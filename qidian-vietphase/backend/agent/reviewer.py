from pathlib import Path
from typing import AsyncIterator

import anthropic

from ..config import settings
from .base import BaseAgent, AgentEvent
from .novel_loader import NovelProfile
from .state import SharedState
from .tools import ToolRegistry


def _make_registry(
    translated_path: Path,
    source_path: Path,
    profile: NovelProfile,
    state: SharedState,
    filename: str,
    novel_slug: str,
) -> ToolRegistry:
    reg = ToolRegistry()

    async def read_translation() -> str:
        """Đọc nội dung bản dịch tiếng Việt của chương."""
        if not translated_path.exists():
            raise FileNotFoundError(f"Không tìm thấy bản dịch: {translated_path}")
        return translated_path.read_text(encoding="utf-8")

    async def read_source() -> str:
        """Đọc nội dung nguyên bản tiếng Trung của chương."""
        if not source_path.exists():
            raise FileNotFoundError(f"Không tìm thấy file gốc: {source_path}")
        return source_path.read_text(encoding="utf-8")

    async def get_glossary() -> str:
        """Lấy bảng thuật ngữ (nhân vật, địa danh, cảnh giới, kỹ năng) của truyện."""
        return profile.glossary_block()

    async def save_review(status: str, issues: str) -> str:
        """Lưu kết quả review chương. status: 'ok' hoặc 'needs_fix'. issues: mô tả vấn đề (chuỗi rỗng nếu ok)."""
        await state.save_review(filename, novel_slug, status, issues)
        return f"Đã lưu review cho {filename}: {status}"

    reg.register(read_translation, "read_translation", read_translation.__doc__)
    reg.register(read_source, "read_source", read_source.__doc__)
    reg.register(get_glossary, "get_glossary", get_glossary.__doc__)
    reg.register(save_review, "save_review", save_review.__doc__)

    return reg


class ReviewerAgent(BaseAgent):
    MAX_ITER = 10

    def __init__(
        self,
        filename: str,
        novel_slug: str,
        translated_path: Path,
        source_path: Path,
        profile: NovelProfile,
        state: SharedState,
        client: anthropic.AsyncAnthropic,
    ):
        self.filename = filename
        reg = _make_registry(translated_path, source_path, profile, state, filename, novel_slug)
        super().__init__(
            agent_id=f"reviewer:{filename}",
            client=client,
            registry=reg,
            model=settings.llm_light_model,
        )

    def _system_prompt(self) -> str:
        return (
            "Bạn là biên tập viên kiểm duyệt bản dịch tiểu thuyết tiên hiệp Trung-Việt.\n"
            "Nhiệm vụ: đọc bản dịch, đối chiếu nguyên bản, kiểm tra chất lượng.\n\n"
            "Tên riêng đã được hệ thống kiểm và sửa riêng theo bảng thuật ngữ — KHÔNG chấm "
            "lỗi về tên riêng, kể cả tên chưa có trong bảng.\n\n"
            "Chỉ chấm 'needs_fix' khi có ít nhất một lỗi rõ ràng:\n"
            "1. Sót: một đoạn hay câu của nguyên bản không có trong bản dịch\n"
            "2. Còn chữ Hán chưa dịch trong bản dịch\n"
            "3. Sai nghĩa rõ: dịch ngược nghĩa, nhầm người nói/hành động, sai số liệu\n"
            "Văn phong chưa mượt, chọn từ khác, gộp/tách đoạn hợp lý KHÔNG phải lỗi.\n\n"
            "Kết quả:\n"
            "- Nếu ổn: save_review(status='ok', issues='')\n"
            "- Nếu có lỗi: save_review(status='needs_fix', issues='từng lỗi: trích câu gốc → câu dịch → sửa thế nào')"
        )

    async def run(self, _: str = "") -> AsyncIterator[AgentEvent]:
        user_msg = (
            f"Kiểm duyệt chương '{self.filename}':\n"
            "1. Gọi get_glossary() để nắm bảng thuật ngữ\n"
            "2. Gọi read_source() để đọc nguyên bản tiếng Trung\n"
            "3. Gọi read_translation() để đọc bản dịch tiếng Việt\n"
            "4. Đối chiếu và kiểm tra theo 3 tiêu chí\n"
            "5. Gọi save_review() với kết quả"
        )
        async for event in super().run(user_msg):
            yield event
