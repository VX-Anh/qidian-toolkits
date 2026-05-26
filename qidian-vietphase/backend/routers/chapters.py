from pathlib import Path
from typing import List

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile

from ..agent.novel_loader import load_novel
from ..agent.orchestrator import parse_chapter_filename
from ..agent.preprocessor import build_segments
from ..config import settings
from ..shared import get_state

router = APIRouter(prefix="/api/chapters", tags=["chapters"])


@router.get("")
def list_chapters(novel_slug: str | None = None):
    state = get_state()
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


@router.post("/upload")
async def upload_chapters(
    novel_slug: str = Form(...),
    files: List[UploadFile] = File(...),
):
    state = get_state()
    settings.input_dir.mkdir(parents=True, exist_ok=True)
    saved, errors = [], []

    for f in files:
        if not (f.filename or "").endswith(".txt"):
            errors.append(f"{f.filename}: chỉ chấp nhận .txt")
            continue
        dest = settings.input_dir / f.filename
        dest.write_bytes(await f.read())

        # Đăng ký vào DB ngay với đúng novel_slug
        num, zh_title = parse_chapter_filename(f.filename)
        state._conn.execute(
            """INSERT INTO chapters(filename, novel_slug, chapter_num, zh_title)
               VALUES(?, ?, ?, ?)
               ON CONFLICT(filename) DO UPDATE SET
                 novel_slug  = excluded.novel_slug,
                 chapter_num = excluded.chapter_num,
                 zh_title    = excluded.zh_title""",
            [f.filename, novel_slug, num, zh_title],
        )
    state._conn.commit()
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
