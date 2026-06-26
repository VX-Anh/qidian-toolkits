import unicodedata
from pathlib import Path
from typing import List

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile

from ..agent.novel_loader import load_novel
from ..agent.orchestrator import parse_chapter_filename
from ..agent.preprocessor import build_segments
from ..agent import vietphase_import
from ..config import settings
from ..shared import get_state

router = APIRouter(prefix="/api/chapters", tags=["chapters"])


@router.post("/import")
def import_vietphase(novel_slug: str | None = None):
    """Quét thư mục vietphase/{slug}/{chương}/ và đăng ký các chương ảnh."""
    state = get_state()
    imported = vietphase_import.scan(state, settings, novel_slug)
    return {"imported": len(imported), "files": imported}


@router.get("")
def list_chapters(novel_slug: str | None = None):
    state = get_state()
    # Tự động import chương ảnh từ vietphase_dir trước khi liệt kê
    try:
        vietphase_import.scan(state, settings, novel_slug)
    except Exception:
        pass
    if not settings.input_dir.exists():
        return state.get_chapters(novel_slug)

    files = sorted(
        settings.input_dir.glob("*.txt"),
        key=lambda p: parse_chapter_filename(p.name)[0],
    )
    conn = state._conn
    for f in files:
        num, zh_title = parse_chapter_filename(f.name)
        # Nếu chapter đã tồn tại với slug "unknown", cập nhật sang slug đúng
        conn.execute(
            """INSERT INTO chapters(filename, novel_slug, chapter_num, zh_title)
               VALUES(?, ?, ?, ?)
               ON CONFLICT(filename) DO UPDATE SET
                 novel_slug  = CASE WHEN novel_slug = 'unknown'
                                    THEN excluded.novel_slug
                                    ELSE novel_slug END,
                 chapter_num = excluded.chapter_num,
                 zh_title    = excluded.zh_title""",
            [f.name, novel_slug or "unknown", num, zh_title],
        )
    conn.commit()
    chapters = state.get_chapters(novel_slug)
    if novel_slug:
        reviews = {r["filename"]: r for r in state.get_reviews(novel_slug)}
        for ch in chapters:
            rev = reviews.get(ch["filename"])
            ch["review_status"] = rev["status"] if rev else None
            ch["review_issues"] = rev["issues"] if rev else None
    return chapters


def _recover_filename(name: str | None) -> str | None:
    """Khôi phục tên file UTF-8 mà parser multipart có thể đã decode nhầm bằng
    latin-1/cp1252 (sinh mojibake hoặc lone-surrogate cho ký tự CJK).

    Trả về tên đã NFC-normalize, hoặc None nếu vẫn còn surrogate (không an toàn để
    ghi xuống đĩa / lưu DB — tránh đầu độc state bằng tên không khớp file thật).
    """
    if not name:
        return None
    if any(0xD800 <= ord(c) <= 0xDFFF for c in name):
        # Đưa chuỗi (kể cả surrogateescape) về lại bytes rồi decode UTF-8 cho đúng.
        for codec in ("latin-1", "cp1252", "utf-8"):
            try:
                name = name.encode(codec, "surrogateescape").decode("utf-8")
                break
            except (UnicodeError, ValueError):
                continue
    if any(0xD800 <= ord(c) <= 0xDFFF for c in name):
        return None
    return unicodedata.normalize("NFC", name)


@router.post("/upload")
async def upload_chapters(
    novel_slug: str = Form(...),
    files: List[UploadFile] = File(...),
):
    state = get_state()
    settings.input_dir.mkdir(parents=True, exist_ok=True)
    saved, errors = [], []

    for f in files:
        name = _recover_filename(f.filename)
        if not name:
            errors.append(f"{f.filename!r}: tên file không hợp lệ (lỗi mã hóa)")
            continue
        if not name.endswith(".txt"):
            errors.append(f"{name}: chỉ chấp nhận .txt")
            continue

        # Ghi file + đăng ký DB cho TỪNG file một cách độc lập. Commit ngay sau mỗi
        # file để một file lỗi không bỏ dở transaction trên connection dùng chung
        # (transaction treo sẽ làm cả app thấy dòng chưa-commit, sinh tên không khớp).
        try:
            dest = settings.input_dir / name
            dest.write_bytes(await f.read())
            num, zh_title = parse_chapter_filename(name)
            with state._tlock:
                state._conn.execute(
                    """INSERT INTO chapters(filename, novel_slug, chapter_num, zh_title)
                       VALUES(?, ?, ?, ?)
                       ON CONFLICT(filename) DO UPDATE SET
                         novel_slug  = excluded.novel_slug,
                         chapter_num = excluded.chapter_num,
                         zh_title    = excluded.zh_title""",
                    [name, novel_slug, num, zh_title],
                )
                state._conn.commit()
            saved.append(name)
        except Exception as exc:
            with state._tlock:
                state._conn.rollback()
            errors.append(f"{name}: {exc}")

    return {"saved": saved, "errors": errors}


@router.get("/{filename}/pretranslate")
def get_pretranslate(filename: str, novel_slug: str):
    path = settings.input_dir / filename
    if not path.exists():
        raise HTTPException(404, "File gốc không tồn tại")
    try:
        profile = load_novel(settings.rules_dir, novel_slug)
    except FileNotFoundError:
        raise HTTPException(404, f"Không tìm thấy rules/{novel_slug}/novel.md")
    text = path.read_text(encoding="utf-8")
    segments, count = build_segments(text, profile)
    return {"segments": segments, "substitution_count": count}


@router.get("/{filename}/source")
def get_source(filename: str):
    path = settings.input_dir / filename
    if not path.exists():
        raise HTTPException(404, "File gốc không tồn tại")
    return {"filename": filename, "content": path.read_text(encoding="utf-8")}


@router.put("/{filename}/source")
def save_source(filename: str, content: str = Body(..., embed=True)):
    """Lưu nội dung bản gốc đã sửa tay về file .txt trong input_dir.

    Dùng chung cho cả chương text và chương ảnh/OCR (kết quả OCR cũng được ghi
    vào input_dir/{filename}). Ghi UTF-8; pretranslate sẽ tự build lại lần sau.
    """
    path = settings.input_dir / filename
    if not path.exists():
        raise HTTPException(404, "File gốc không tồn tại")
    path.write_text(content, encoding="utf-8")
    return {"ok": True}


@router.get("/{filename}/output")
def get_output(filename: str):
    state = get_state()
    chapter = state.get_chapter(filename)
    if not chapter or not chapter.get("translated_path"):
        raise HTTPException(404, "Chưa được dịch")

    path = Path(chapter["translated_path"])
    if not path.exists():
        raise HTTPException(404, "File output không tồn tại")

    return {"filename": filename, "vi_title": chapter["vi_title"], "content": path.read_text(encoding="utf-8")}


@router.put("/{filename}/output")
def save_output(filename: str, content: str = Body(..., embed=True)):
    state = get_state()
    chapter = state.get_chapter(filename)
    if not chapter or not chapter.get("translated_path"):
        raise HTTPException(404, "Chưa được dịch")
    path = Path(chapter["translated_path"])
    if not path.exists():
        raise HTTPException(404, "File output không tồn tại")
    path.write_bytes(content.encode("utf-8"))
    return {"ok": True}
