from pathlib import Path

from fastapi import Depends, APIRouter, HTTPException
from pydantic import BaseModel

from ..agent.novel_loader import (
    NOVEL_MD_LOCK, list_novels, load_novel, render_novel_template, write_novel_md,
)
from ..agent import vietphase_import
from ..config import settings
from ..safety import check_request_params, check_slug, safe_child

router = APIRouter(prefix="/api/novels", tags=["novels"], dependencies=[Depends(check_request_params)])


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


def _md_version(path: Path) -> str:
    return str(path.stat().st_mtime_ns)


@router.get("/{slug}/raw")
def get_novel_raw(slug: str):
    path = settings.rules_dir / slug / "novel.md"
    if not path.exists():
        raise HTTPException(404)
    with NOVEL_MD_LOCK:
        return {"content": path.read_text(encoding="utf-8"), "version": _md_version(path)}


class NovelRawBody(BaseModel):
    content: str
    # version lấy từ GET /raw. Có gửi mà file đã đổi (extractor / tab khác vừa ghi)
    # → 409 thay vì đè mất thay đổi đó. Không gửi = ghi đè (tương thích cũ).
    version: str | None = None


@router.put("/{slug}/raw")
def update_novel_raw(slug: str, body: NovelRawBody):
    path = settings.rules_dir / slug / "novel.md"
    if not path.exists():
        raise HTTPException(404)
    with NOVEL_MD_LOCK:
        if body.version is not None and body.version != _md_version(path):
            raise HTTPException(409, "novel.md đã bị thay đổi ở nơi khác — tải lại rồi sửa")
        write_novel_md(path, body.content)
        return {"ok": True, "version": _md_version(path)}


class CreateNovelBody(BaseModel):
    slug: str
    zh_name: str
    vi_name: str
    genre: str = "tiên hiệp"


@router.post("")
def create_novel(body: CreateNovelBody):
    check_slug(body.slug)
    novel_dir = safe_child(settings.rules_dir, body.slug)
    if novel_dir.exists():
        raise HTTPException(400, "Slug đã tồn tại")

    content = render_novel_template(settings.rules_dir, body.zh_name, body.vi_name, body.genre)

    novel_dir.mkdir(parents=True, exist_ok=True)
    (novel_dir / "novel.md").write_text(content, encoding="utf-8")
    return {"slug": body.slug, "ok": True}
