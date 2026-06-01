"""Story-wiki API (LLM-Wiki Phase 1).

Đọc tầng làm giàu/ngữ cảnh trong SQLite: thực thể, quan hệ, sự kiện.
Mọi endpoint nhận `?up_to=N` (spoiler-free) — chỉ trả mục có first_chapter/chapter_num ≤ N.
"""
from fastapi import APIRouter, HTTPException

from ..shared import get_state

router = APIRouter(prefix="/api/wiki", tags=["wiki"])


@router.get("/{slug}/entities")
def list_entities(slug: str, up_to: int | None = None):
    return get_state().get_entities(slug, up_to)


@router.get("/{slug}/relationships")
def list_relationships(slug: str, up_to: int | None = None):
    return get_state().get_relationships(slug, up_to)


@router.get("/{slug}/events")
def list_events(slug: str, up_to: int | None = None):
    return get_state().get_events(slug, up_to)


@router.get("/{slug}/entity/{zh}")
def get_entity(slug: str, zh: str, up_to: int | None = None):
    state = get_state()
    entity = state.get_entity(slug, zh)
    if not entity:
        raise HTTPException(404, f"Không tìm thấy thực thể '{zh}'")
    # Spoiler-free: nếu lọc tới chương N, ẩn luôn entity chưa xuất hiện (first_chapter > N).
    # NULL = chưa rõ chương → vẫn hiện (đồng nhất với get_entities).
    fc = entity.get("first_chapter")
    if up_to is not None and fc is not None and fc > up_to:
        raise HTTPException(404, f"Thực thể '{zh}' chưa xuất hiện tới chương {up_to}")
    # Đính kèm các quan hệ có liên quan tới thực thể này (cả 2 chiều)
    rels = [
        r for r in state.get_relationships(slug, up_to)
        if r["from_zh"] == zh or r["to_zh"] == zh
    ]
    entity["relationships"] = rels
    return entity
