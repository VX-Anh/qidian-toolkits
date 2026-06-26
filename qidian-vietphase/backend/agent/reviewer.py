from pathlib import Path
from typing import AsyncIterator

from google import genai

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
        client: genai.Client,
    ):
        self.filename = filename
        reg = _make_registry(translated_path, source_path, profile, state, filename, novel_slug)
        super().__init__(
            agent_id=f"reviewer:{filename}",
            client=client,
            registry=reg,
            model=settings.llm_model,
        )

    def _system_prompt(self) -> str:
        return (
            "Bạn là biên tập viên kiểm duyệt bản dịch tiểu thuyết tiên hiệp Trung-Việt.\n"
            "Nhiệm vụ: đọc bản dịch, đối chiếu nguyên bản, kiểm tra chất lượng.\n\n"
            "Tiêu chí kiểm tra:\n"
            "1. Thuật ngữ: tên nhân vật/địa danh/cảnh giới/kỹ năng có khớp bảng thuật ngữ không\n"
            "2. Đầy đủ: có đoạn văn nào bị bỏ sót hoặc còn để tiếng Trung không\n"
            "3. Văn phong: trang trọng, nhiều Hán Việt, không dùng từ hiện đại/thông tục\n"
            "4. Cấu trúc: số đoạn văn tiếng Việt có tương ứng nguyên bản không\n\n"
            "Kết quả:\n"
            "- Nếu ổn: save_review(status='ok', issues='')\n"
            "- Nếu có vấn đề: save_review(status='needs_fix', issues='mô tả chi tiết từng lỗi')"
        )

    async def run(self, _: str = "") -> AsyncIterator[AgentEvent]:
        user_msg = (
            f"Kiểm duyệt chương '{self.filename}':\n"
            "1. Gọi get_glossary() để nắm bảng thuật ngữ\n"
            "2. Gọi read_source() để đọc nguyên bản tiếng Trung\n"
            "3. Gọi read_translation() để đọc bản dịch tiếng Việt\n"
            "4. Đối chiếu và kiểm tra theo 4 tiêu chí\n"
            "5. Gọi save_review() với kết quả"
        )
        async for event in super().run(user_msg):
            yield event
