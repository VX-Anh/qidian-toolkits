import re
from pathlib import Path
from typing import AsyncIterator

from openai import AsyncOpenAI

from ..config import settings
from .base import BaseAgent, AgentEvent
from .novel_loader import NovelProfile
from .rate_limiter import RateLimiter
from .state import ChapterStatus, SharedState
from .tools import ToolRegistry

# ~2500 từ Trung mỗi chunk (an toàn với 4096 output token)
CHUNK_SIZE = 2500


def _make_registry(
    state: SharedState,
    filename: str,
    novel_slug: str,
    output_dir: Path,
    profile: NovelProfile,
) -> ToolRegistry:
    reg = ToolRegistry()

    async def lookup_glossary(zh_terms: str) -> str:
        """Tra bảng thuật ngữ cho danh sách từ Trung (cách nhau bởi dấu phẩy)."""
        terms = [t.strip() for t in zh_terms.split(",")]
        result = {}
        for t in terms:
            for term in profile.all_terms():
                if term.zh == t:
                    result[t] = term.vi
                    break
            else:
                result[t] = "CHƯA CÓ TRONG GLOSSARY"
        return str(result)

    async def get_prev_summary(prev_filename: str) -> str:
        """Lấy tóm tắt chương trước để đảm bảo liên tục."""
        summary = state.get_summary(prev_filename)
        return summary or "Không có tóm tắt chương trước."

    async def flag_unknown_term(zh_term: str, context: str) -> str:
        """Đánh dấu thuật ngữ chưa biết để ExtractorAgent xử lý sau."""
        await state.flag_term(zh_term, context, filename)
        return f"Đã ghi nhận: {zh_term}"

    async def save_chapter(vi_title: str, content: str) -> str:
        """Lưu toàn bộ bản dịch vào file output."""
        novel_out = output_dir / novel_slug
        novel_out.mkdir(parents=True, exist_ok=True)

        chapter_info = state.get_chapter(filename)
        num = chapter_info["chapter_num"] if chapter_info else 0
        safe_title = re.sub(r'[\\/:*?"<>|]', "", vi_title).strip()
        out_path = novel_out / f"Chuong_{num:04d}_{safe_title}.txt"

        out_path.write_bytes(
            f"# {vi_title}\n\n{content.strip()}\n".encode("utf-8")
        )

        await state.set_status(
            filename,
            ChapterStatus.DONE,
            vi_title=vi_title,
            translated_path=str(out_path),
        )
        return f"Đã lưu: {out_path.name}"

    async def save_summary(summary: str) -> str:
        """Lưu tóm tắt ngắn chương vừa dịch (dùng cho chương sau)."""
        await state.save_summary(filename, summary)
        return "Đã lưu tóm tắt."

    reg.register(lookup_glossary, "lookup_glossary", lookup_glossary.__doc__)
    reg.register(get_prev_summary, "get_prev_summary", get_prev_summary.__doc__)
    reg.register(flag_unknown_term, "flag_unknown_term", flag_unknown_term.__doc__)
    reg.register(save_chapter, "save_chapter", save_chapter.__doc__)
    reg.register(save_summary, "save_summary", save_summary.__doc__)

    return reg


class TranslatorAgent(BaseAgent):
    def __init__(
        self,
        filename: str,
        content: str,
        novel_slug: str,
        profile: NovelProfile,
        state: SharedState,
        client: AsyncOpenAI,
        rate_limiter: RateLimiter,
        output_dir: Path,
        review_issues: str | None = None,
    ):
        self.filename = filename
        self.content = content
        self.profile = profile
        self.rate_limiter = rate_limiter
        self.review_issues = review_issues

        reg = _make_registry(state, filename, novel_slug, output_dir, profile)
        super().__init__(
            agent_id=f"translator:{filename}",
            client=client,
            registry=reg,
            model=settings.openai_model,
        )

    def _system_prompt(self) -> str:
        return self.profile.system_prompt()

    async def run(self, _: str = "") -> AsyncIterator[AgentEvent]:
        chunks = self._split_chunks(self.content)
        n = len(chunks)

        user_msg = (
            f"Dịch file chương: '{self.filename}'\n"
            f"Nội dung gồm {n} phần. Dưới đây là toàn bộ nội dung:\n\n"
            + "\n\n---\n\n".join(chunks)
            + "\n\n---\n\n"
            "Hướng dẫn:\n"
            "1. Tên riêng trong bảng thuật ngữ đã được thay sang tiếng Việt trước. Giữ nguyên các tên riêng tiếng Việt này khi dịch.\n"
            "2. Dùng flag_unknown_term cho bất kỳ danh từ riêng Trung nào còn sót chưa được dịch sẵn.\n"
            "3. Dịch toàn bộ nội dung, giữ nguyên số lượng đoạn văn.\n"
            "4. Dịch tên chương sang tiếng Việt.\n"
            "5. Gọi save_chapter(vi_title, content) với bản dịch hoàn chỉnh.\n"
            "6. Gọi save_summary với tóm tắt 2-3 câu về nội dung chương."
        )

        if self.review_issues:
            user_msg += f"\n\n[LẦN TRƯỚC CÓ VẤN ĐỀ — HÃY SỬA]\n{self.review_issues}"

        await self.rate_limiter.acquire(estimated_tokens=len(self.content) // 2 + 3000)
        async for event in super().run(user_msg):
            yield event

    def _split_chunks(self, text: str) -> list[str]:
        paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
        chunks, current, size = [], [], 0
        for para in paragraphs:
            para_len = len(para)
            if size + para_len > CHUNK_SIZE and current:
                chunks.append("\n\n".join(current))
                current, size = [], 0
            current.append(para)
            size += para_len
        if current:
            chunks.append("\n\n".join(current))
        return chunks or [text]
