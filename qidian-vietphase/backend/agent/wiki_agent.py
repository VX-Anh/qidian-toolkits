"""WikiAgent — ingest 2-stage cho story-wiki (LLM-Wiki Phase 1).

Đọc một chương Trung (nguồn) + bảng thuật ngữ, rồi:
  Stage 1 — phân tích: liệt kê thực thể / quan hệ / sự kiện xuất hiện trong chương.
  Stage 2 — sinh: gọi tool upsert_entity / add_relationship / add_event ghi vào SQLite.

Khác ExtractorAgent (chỉ giải quyết term bị translator flag), WikiAgent chủ động
trích ngữ cảnh giàu (mô tả, alias, quan hệ, sự kiện) cho mỗi chương.

Bất biến: novel.md là vua cho `vi`. WikiAgent chỉ ghi SQLite; `vi` ưu tiên lấy từ
glossary đã-duyệt, chỉ dùng đề xuất của model khi term chưa có trong glossary.
"""
from pathlib import Path
from typing import AsyncIterator, Optional

from openai import AsyncOpenAI

from ..config import settings
from .base import AgentEvent, BaseAgent
from .novel_loader import NovelProfile
from .state import SharedState
from .tools import ToolRegistry

CATEGORIES = ["character", "place", "realm", "skill", "other"]

# Cắt nguồn để giữ token hợp lý (một chương web-novel thường < 8000 ký tự Trung).
SOURCE_CHAR_CAP = 9000


def _split_csv(s: str) -> list[str]:
    """'陈大, 小陈' → ['陈大', '小陈']  (bỏ rỗng, bỏ trùng giữ thứ tự)."""
    items = [x.strip() for x in (s or "").replace("，", ",").split(",")]
    return list(dict.fromkeys(x for x in items if x))


def _make_registry(
    state: SharedState,
    novel_slug: str,
    chapter_num: int,
    profile: NovelProfile,
) -> ToolRegistry:
    reg = ToolRegistry()
    gloss = {t.zh: t.vi for t in profile.all_terms() if t.zh}
    counts = {"entities": 0, "relationships": 0, "events": 0}

    async def upsert_entity(zh: str, vi: str, type: str, description: str, aliases: str) -> str:
        """Thêm/cập nhật một thực thể (nhân vật/địa danh/cảnh giới/kỹ năng).

        zh: tên gốc Hán tự (khóa). vi: tên Việt (để '' nếu chưa chắc — sẽ lấy từ glossary).
        type: character|place|realm|skill|other. description: mô tả NGẮN tiếng Việt (1 câu,
        không spoiler về sau). aliases: các tên gọi khác bằng Hán tự, cách nhau dấu phẩy ('' nếu không có).
        """
        if type not in CATEGORIES:
            type = "other"
        # novel.md là vua: nếu zh đã có trong glossary, dùng vi đã-duyệt.
        resolved_vi = gloss.get(zh) or (vi.strip() or None)
        await state.upsert_entity(
            novel_slug=novel_slug, zh=zh, vi=resolved_vi, type=type,
            description=description.strip(), aliases=_split_csv(aliases),
            first_chapter=chapter_num,
        )
        counts["entities"] += 1
        return f"OK entity: {zh} → {resolved_vi or '(chưa có vi)'} [{type}]"

    async def add_relationship(from_zh: str, to_zh: str, type: str, description: str) -> str:
        """Thêm quan hệ giữa hai thực thể (dùng Hán tự cho from_zh/to_zh, khớp zh của entity).

        type: nhãn quan hệ ngắn tiếng Việt (vd: 'sư phụ', 'kẻ thù', 'thuộc về', 'huynh đệ').
        description: giải thích ngắn ('' nếu không cần).
        """
        if not from_zh.strip() or not to_zh.strip():
            return "Bỏ qua: thiếu from_zh hoặc to_zh."
        await state.add_relationship(
            novel_slug=novel_slug, from_zh=from_zh.strip(), to_zh=to_zh.strip(),
            type=type.strip(), description=description.strip(), first_chapter=chapter_num,
        )
        counts["relationships"] += 1
        return f"OK quan hệ: {from_zh} —[{type}]→ {to_zh}"

    async def add_event(description: str, characters: str) -> str:
        """Ghi một sự kiện chính của chương.

        description: mô tả sự kiện NGẮN tiếng Việt. characters: các thực thể liên quan
        bằng Hán tự, cách nhau dấu phẩy ('' nếu không rõ).
        """
        if not description.strip():
            return "Bỏ qua: sự kiện rỗng."
        await state.add_event(
            novel_slug=novel_slug, chapter_num=chapter_num,
            description=description.strip(), characters=_split_csv(characters),
        )
        counts["events"] += 1
        return f"OK sự kiện (chương {chapter_num})."

    async def finish(summary: str) -> str:
        """Gọi khi đã ghi xong toàn bộ thực thể/quan hệ/sự kiện của chương."""
        return (f"Đã ghi: {counts['entities']} thực thể, "
                f"{counts['relationships']} quan hệ, {counts['events']} sự kiện. {summary}")

    reg.register(upsert_entity, "upsert_entity", upsert_entity.__doc__)
    reg.register(add_relationship, "add_relationship", add_relationship.__doc__)
    reg.register(add_event, "add_event", add_event.__doc__)
    reg.register(finish, "finish", finish.__doc__)
    return reg


class WikiAgent(BaseAgent):
    def __init__(
        self,
        filename: str,
        novel_slug: str,
        chapter_num: int,
        source_content: str,
        profile: NovelProfile,
        state: SharedState,
        client: AsyncOpenAI,
    ):
        self.filename = filename
        self.chapter_num = chapter_num
        self.source_content = source_content
        self.profile = profile

        reg = _make_registry(state, novel_slug, chapter_num, profile)
        super().__init__(
            agent_id=f"wiki:{filename}",
            client=client,
            registry=reg,
            model=settings.openai_model,
        )

    def _system_prompt(self) -> str:
        return (
            "Bạn là biên tập viên story-wiki cho tiểu thuyết tiên hiệp/võ hiệp Trung Quốc. "
            "Nhiệm vụ: đọc MỘT chương (tiếng Trung) và trích xuất tri thức để xây wiki nhân vật.\n\n"
            "Quy trình HAI BƯỚC:\n"
            "BƯỚC 1 — Phân tích (viết ngắn gọn dưới dạng text): liệt kê các thực thể "
            "(nhân vật/địa danh/cảnh giới/kỹ năng) THỰC SỰ xuất hiện trong chương, các quan hệ "
            "giữa nhân vật, và 1-3 sự kiện chính.\n"
            "BƯỚC 2 — Ghi: gọi tool cho từng mục: upsert_entity, add_relationship, add_event. "
            "Khi xong gọi finish.\n\n"
            "NGUYÊN TẮC:\n"
            "- Khóa thực thể là tên Hán tự gốc (zh). Mô tả viết bằng TIẾNG VIỆT, ngắn (1 câu).\n"
            "- Chỉ trích thực thể có ý nghĩa (danh từ riêng), bỏ qua từ thông thường.\n"
            "- KHÔNG spoiler: mô tả chỉ dựa trên thông tin tới chương này.\n"
            "- type phải là một trong: character | place | realm | skill | other.\n"
            "- Nếu không chắc tên Việt, để vi rỗng — hệ thống sẽ lấy từ bảng thuật ngữ."
        )

    async def run(self, _: str = "") -> AsyncIterator[AgentEvent]:
        content = self.source_content.strip()
        truncated = ""
        if len(content) > SOURCE_CHAR_CAP:
            content = content[:SOURCE_CHAR_CAP]
            truncated = "\n\n[... nội dung đã cắt bớt để tiết kiệm token ...]"

        user_msg = (
            f"Chương số {self.chapter_num} — file '{self.filename}'.\n\n"
            f"{self.profile.glossary_block()}\n\n"
            "=== NỘI DUNG CHƯƠNG (tiếng Trung) ===\n"
            f"{content}{truncated}\n\n"
            "Hãy phân tích rồi ghi vào wiki: gọi upsert_entity cho mỗi thực thể, "
            "add_relationship cho mỗi quan hệ, add_event cho mỗi sự kiện chính, "
            "cuối cùng gọi finish."
        )
        async for event in super().run(user_msg):
            yield event
