import json
from pathlib import Path
from typing import AsyncIterator

from google import genai

from ..config import settings
from .base import BaseAgent, AgentEvent
from .novel_loader import append_terms_to_novel
from .state import SharedState
from .tools import ToolRegistry

CATEGORIES = ["character", "place", "realm", "skill", "other"]


def _make_registry(state: SharedState, rules_dir: Path, slug: str) -> ToolRegistry:
    reg = ToolRegistry()
    resolved: list[dict] = []

    async def read_flagged_terms() -> str:
        """Lấy tất cả thuật ngữ chưa được giải quyết."""
        terms = state.get_flagged_terms(resolved=False)
        if not terms:
            return "Không có thuật ngữ nào cần xử lý."
        return json.dumps(terms, ensure_ascii=False)

    async def add_term(zh_term: str, vi_term: str, category: str, notes: str) -> str:
        """Thêm một thuật ngữ vào novel.md. category: character|place|realm|skill|other"""
        if category not in CATEGORIES:
            category = "character"
        resolved.append({"zh": zh_term, "vi": vi_term, "type": category, "notes": notes})
        await state.resolve_term(zh_term)
        return f"OK: {zh_term} → {vi_term} [{category}]"

    async def skip_term(zh_term: str, reason: str) -> str:
        """Bỏ qua thuật ngữ không phải danh từ riêng (ví dụ: từ thông thường)."""
        await state.resolve_term(zh_term)
        return f"Bỏ qua: {zh_term} ({reason})"

    async def flush_to_novel() -> str:
        """Ghi tất cả thuật ngữ đã xử lý vào novel.md."""
        if not resolved:
            return "Không có thuật ngữ mới."
        append_terms_to_novel(rules_dir, slug, resolved)
        count = len(resolved)
        resolved.clear()
        return f"Đã ghi {count} thuật ngữ vào novel.md"

    reg.register(read_flagged_terms, "read_flagged_terms", read_flagged_terms.__doc__)
    reg.register(add_term, "add_term", add_term.__doc__)
    reg.register(skip_term, "skip_term", skip_term.__doc__)
    reg.register(flush_to_novel, "flush_to_novel", flush_to_novel.__doc__)

    return reg


class ExtractorAgent(BaseAgent):
    def __init__(self, slug: str, state: SharedState, client: genai.Client, rules_dir: Path):
        self.slug = slug
        reg = _make_registry(state, rules_dir, slug)
        super().__init__(
            agent_id=f"extractor:{slug}",
            client=client,
            registry=reg,
            model=settings.llm_model,
        )

    def _system_prompt(self) -> str:
        return (
            "Bạn là chuyên gia thuật ngữ tiểu thuyết tiên hiệp/võ hiệp Trung-Việt. "
            "Nhiệm vụ: phân tích các thuật ngữ chưa được dịch và đề xuất tên tiếng Việt phù hợp.\n\n"
            "Nguyên tắc đặt tên:\n"
            "- Nhân vật: phiên âm Hán Việt (陈庆 → Trần Khánh)\n"
            "- Địa danh: dịch nghĩa + Hán Việt (天演宗 → Thiên Diễn Tông)\n"
            "- Cảnh giới: giữ nguyên cấu trúc Hán Việt (元神境 → Nguyên Thần Cảnh)\n"
            "- Kỹ năng: dịch nghĩa thơ mộng (天火诀 → Thiên Hỏa Quyết)\n"
            "- Từ thông thường (không phải danh từ riêng): dùng skip_term\n\n"
            "Workflow: read_flagged_terms → phân tích từng term → add_term hoặc skip_term → flush_to_novel"
        )

    async def run(self, _: str = "") -> AsyncIterator[AgentEvent]:
        user_msg = (
            "Xử lý tất cả thuật ngữ chưa được dịch:\n"
            "1. Gọi read_flagged_terms để lấy danh sách\n"
            "2. Với mỗi thuật ngữ: phân tích ngữ cảnh, xác định loại, đề xuất tên Việt\n"
            "3. Gọi add_term hoặc skip_term cho từng thuật ngữ\n"
            "4. Cuối cùng gọi flush_to_novel để lưu tất cả"
        )
        async for event in super().run(user_msg):
            yield event
