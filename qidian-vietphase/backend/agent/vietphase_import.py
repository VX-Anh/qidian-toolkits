"""Auto-import chương từ thư mục vietphase/{slug}/{chương}/.

Mỗi thư mục chương chứa:
  - output.txt           : văn bản tiếng Trung đã OCR (dùng làm nguồn để dịch)
  - <tên chương>_NN.jpg  : ảnh screenshot nguồn

Hàm scan() đăng ký từng chương vào DB với ocr_job_id = tên thư mục chương,
và (nếu chưa có) copy output.txt vào input_dir thành file nguồn .txt.
Ảnh được phục vụ trực tiếp từ vietphase_dir qua router OCR (không copy).
"""
import re
from pathlib import Path

from .orchestrator import parse_chapter_filename

IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def derive_filename(image_name: str, folder_name: str) -> str:
    """'第678章 二重（求月票！）_01.jpg' → '第678章 二重（求月票！）.txt'"""
    m = re.match(r"^(.*?)(?:_\d+)?\.[^.]+$", image_name)
    base = (m.group(1) if m else image_name).strip()
    if not base or not re.search(r"第\d+章", base):
        # Không suy ra được tên chương từ ảnh → dùng tên thư mục
        base = folder_name
    return base + ".txt"


def list_images(chapter_dir: Path) -> list[Path]:
    return sorted(
        [p for p in chapter_dir.iterdir() if p.is_file() and p.suffix.lower() in IMG_EXTS],
        key=lambda p: p.name,
    )


def _pick_raw_text(chapter_dir: Path) -> Path | None:
    """File .txt nguồn từ extension (không phải output.txt), khớp 第\\d+章.

    Đây là bản copy text trực tiếp từ Qidian — chính xác hơn OCR. Ưu tiên bản tên
    sạch (không có hậu tố _N như '..._1.txt') khi có nhiều bản.
    """
    cands = [
        p for p in chapter_dir.glob("*.txt")
        if p.name != "output.txt" and re.search(r"第\d+章", p.name)
    ]
    if not cands:
        return None
    clean = [p for p in cands if not re.search(r"_\d+\.txt$", p.name)]
    return sorted(clean or cands, key=lambda p: p.name)[0]


def scan(state, settings, novel_slug: str | None = None) -> list[str]:
    """Quét vietphase_dir, đăng ký chương (ảnh OCR hoặc text từ extension).

    Mỗi chương được copy nguồn vào input_dir để dịch — ưu tiên file text extension
    (第NNN章....txt), fallback output.txt (OCR). Trả về danh sách filename đã import.
    """
    base: Path = settings.vietphase_dir
    if not base.exists():
        return []

    if novel_slug:
        slug_dirs = [base / novel_slug] if (base / novel_slug).is_dir() else []
    else:
        slug_dirs = [p for p in base.iterdir() if p.is_dir()]

    conn = state._conn
    imported: list[str] = []

    for ndir in slug_dirs:
        slug = ndir.name
        for chdir in sorted(ndir.iterdir(), key=lambda p: p.name):
            if not chdir.is_dir():
                continue
            images = list_images(chdir)
            raw_txt = _pick_raw_text(chdir)
            out_txt = chdir / "output.txt"
            # Bỏ qua thư mục không có nguồn nào (ảnh / text extension / OCR)
            if not images and raw_txt is None and not out_txt.exists():
                continue

            # Tên chương chuẩn: ưu tiên text extension → ảnh → tên thư mục
            base_name = raw_txt.name if raw_txt else (images[0].name if images else None)
            filename = derive_filename(base_name or chdir.name, chdir.name)
            num, zh_title = parse_chapter_filename(filename)

            # Nguồn dịch: ưu tiên text extension (copy trực tiếp), fallback output.txt (OCR).
            # Copy vào input_dir nếu chưa có — không ghi đè bản đã sửa tay.
            src = raw_txt if raw_txt else (out_txt if out_txt.exists() else None)
            dest = settings.input_dir / filename
            if src and not dest.exists():
                settings.input_dir.mkdir(parents=True, exist_ok=True)
                dest.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")

            # Chương ảnh → ocr_job_id = tên thư mục; chương text-only → None (không có bước OCR)
            ocr_job_id = chdir.name if images else None
            conn.execute(
                """INSERT INTO chapters(filename, novel_slug, chapter_num, zh_title, ocr_job_id)
                   VALUES(?,?,?,?,?)
                   ON CONFLICT(filename) DO UPDATE SET
                       novel_slug  = CASE WHEN chapters.novel_slug = 'unknown'
                                          THEN excluded.novel_slug ELSE chapters.novel_slug END,
                       chapter_num = excluded.chapter_num,
                       zh_title    = excluded.zh_title,
                       ocr_job_id  = COALESCE(excluded.ocr_job_id, chapters.ocr_job_id)""",
                [filename, slug, num, zh_title, ocr_job_id],
            )
            imported.append(filename)

    conn.commit()
    return imported


def _humanize_slug(slug: str) -> str:
    return slug.replace("-", " ").replace("_", " ").strip().title()


def _novel_template(slug: str, settings) -> str:
    """Lấy nội dung novel.md mặc định cho slug mới (ưu tiên rules/_template.md)."""
    tpl = settings.rules_dir / "_template.md"
    vi_name = _humanize_slug(slug)
    if tpl.exists():
        return (
            tpl.read_text(encoding="utf-8")
            .replace("NOVEL_ZH_NAME", "")
            .replace("NOVEL_VI_NAME", vi_name)
            .replace("NOVEL_GENRE", "tiên hiệp")
        )
    return f"""---
zh_name: ""
vi_name: "{vi_name}"
genre: tiên hiệp
style: trang trọng, nhiều Hán Việt
status: đang dịch
---

## Prompt dịch

Bạn là dịch giả tiểu thuyết tiên hiệp Trung-Việt chuyên nghiệp.
Dịch sang tiếng Việt tự nhiên, trang trọng, ưu tiên từ Hán Việt cho thuật ngữ tu luyện.

## Nhân vật

| Tiếng Trung | Tiếng Việt | Ghi chú |
|---|---|---|

## Địa danh

| Tiếng Trung | Tiếng Việt | Ghi chú |
|---|---|---|

## Cảnh giới tu luyện

| Tiếng Trung | Tiếng Việt | Ghi chú |
|---|---|---|

## Kỹ năng / Pháp thuật

| Tiếng Trung | Tiếng Việt | Ghi chú |
|---|---|---|
"""


def ensure_novels_from_folders(settings) -> list[str]:
    """Mỗi folder slug trong vietphase_dir mà chưa có rules/{slug}/novel.md → tạo mới.

    Trả về danh sách slug vừa được tạo (để truyện hiện ngay trong danh sách).
    """
    base: Path = settings.vietphase_dir
    if not base.exists():
        return []
    created = []
    for ndir in base.iterdir():
        if not ndir.is_dir():
            continue
        slug = ndir.name
        if slug.startswith("_") or slug.startswith("."):
            continue
        novel_md = settings.rules_dir / slug / "novel.md"
        if novel_md.exists():
            continue
        novel_md.parent.mkdir(parents=True, exist_ok=True)
        novel_md.write_text(_novel_template(slug, settings), encoding="utf-8")
        created.append(slug)
    return created


def resolve_image_dir(settings, slug: str, job: str) -> Path | None:
    """Trả về thư mục chứa ảnh cho (slug, job) — ưu tiên ocr_images_dir, fallback vietphase_dir."""
    d1 = settings.ocr_images_dir / slug / job
    if d1.exists():
        return d1
    d2 = settings.vietphase_dir / slug / job
    if d2.exists():
        return d2
    return None
