from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..agent.novel_loader import list_novels, load_novel
from ..agent import vietphase_import
from ..config import settings

router = APIRouter(prefix="/api/novels", tags=["novels"])


@router.get("")
def get_novels():
    # Tự tạo rules/{slug}/novel.md cho mỗi folder slug có trong data/vietphase/
    try:
        vietphase_import.ensure_novels_from_folders(settings)
    except Exception:
        pass
    slugs = list_novels(settings.rules_dir)
    result = []
    for slug in slugs:
        try:
            p = load_novel(settings.rules_dir, slug)
            result.append({"slug": slug, "zh_name": p.zh_name, "vi_name": p.vi_name, "genre": p.genre})
        except Exception:
            result.append({"slug": slug, "zh_name": "", "vi_name": slug, "genre": ""})
    return result


@router.get("/{slug}")
def get_novel(slug: str):
    try:
        profile = load_novel(settings.rules_dir, slug)
        return profile.to_dict()
    except FileNotFoundError:
        raise HTTPException(404, f"Novel '{slug}' not found")


@router.get("/{slug}/raw")
def get_novel_raw(slug: str):
    path = settings.rules_dir / slug / "novel.md"
    if not path.exists():
        raise HTTPException(404)
    return {"content": path.read_text(encoding="utf-8")}


class NovelRawBody(BaseModel):
    content: str


@router.put("/{slug}/raw")
def update_novel_raw(slug: str, body: NovelRawBody):
    path = settings.rules_dir / slug / "novel.md"
    if not path.exists():
        raise HTTPException(404)
    path.write_text(body.content, encoding="utf-8")
    return {"ok": True}


class CreateNovelBody(BaseModel):
    slug: str
    zh_name: str
    vi_name: str
    genre: str = "tiên hiệp"


@router.post("")
def create_novel(body: CreateNovelBody):
    novel_dir = settings.rules_dir / body.slug
    if novel_dir.exists():
        raise HTTPException(400, "Slug đã tồn tại")

    template_path = settings.rules_dir / "_template.md"
    if template_path.exists():
        content = template_path.read_text(encoding="utf-8")
        content = content.replace("NOVEL_ZH_NAME", body.zh_name)
        content = content.replace("NOVEL_VI_NAME", body.vi_name)
        content = content.replace("NOVEL_GENRE", body.genre)
    else:
        content = _default_template(body.zh_name, body.vi_name, body.genre)

    novel_dir.mkdir(parents=True, exist_ok=True)
    (novel_dir / "novel.md").write_text(content, encoding="utf-8")
    return {"slug": body.slug, "ok": True}


def _default_template(zh_name: str, vi_name: str, genre: str) -> str:
    return f"""---
zh_name: "{zh_name}"
vi_name: "{vi_name}"
genre: {genre}
style: trang trọng, nhiều Hán Việt, không dùng từ hiện đại
status: đang dịch
---

## Prompt dịch

Bạn là dịch giả tiểu thuyết {genre} Trung-Việt chuyên nghiệp.
Dịch sang tiếng Việt tự nhiên, trang trọng, ưu tiên từ Hán Việt cho thuật ngữ tu luyện.
Giữ nguyên cấu trúc đoạn văn. Không thêm bình luận hay giải thích.
Tên riêng phải dịch đúng theo bảng thuật ngữ bên dưới.

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

## Ghi chú thêm

"""
