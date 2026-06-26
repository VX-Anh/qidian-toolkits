import asyncio
import re
from pathlib import Path

from google import genai

from ..config import settings
from .extractor import ExtractorAgent
from .novel_loader import NovelProfile, load_novel
from .preprocessor import replace_proper_nouns
from .rate_limiter import RateLimiter
from .reviewer import ReviewerAgent
from .state import ChapterStatus, EventQueue, SharedState
from .translator import TranslatorAgent
from .wiki_agent import WikiAgent


def parse_chapter_filename(filename: str) -> tuple[int, str]:
    """第675章 天演（求月票！）.txt → (675, '天演')"""
    m = re.match(r"第(\d+)章\s*(.+?)(?:（[^）]*）)*\.txt$", filename)
    if m:
        return int(m.group(1)), m.group(2).strip()
    return 0, filename.replace(".txt", "")


class Orchestrator:
    def __init__(
        self,
        novel_slug: str,
        input_dir: Path,
        output_dir: Path,
        rules_dir: Path,
        state: SharedState,
        event_queue: EventQueue,
        client: genai.Client,
        chapter_filenames: list[str] | None = None,
        force: bool = False,
        run_wiki: bool = True,
    ):
        self.novel_slug = novel_slug
        self.input_dir = input_dir
        self.output_dir = output_dir
        self.rules_dir = rules_dir
        self.state = state
        self.event_queue = event_queue
        self.client = client
        self.chapter_filenames = chapter_filenames  # None = dịch tất cả
        self.force = force  # True = dịch lại kể cả chương đã DONE
        self.run_wiki = run_wiki  # False = chỉ dịch, bỏ bước đưa vào Story-Wiki
        self.rate_limiter = RateLimiter(rpm=settings.llm_rpm, tpm=settings.llm_tpm)

    async def run(self):
        try:
            try:
                profile = load_novel(self.rules_dir, self.novel_slug)
            except FileNotFoundError:
                await self._emit("orchestrator", "error",
                                 msg=f"Không tìm thấy rules/{self.novel_slug}/novel.md")
                return
            except Exception as exc:
                await self._emit("orchestrator", "error", msg=f"Lỗi load config: {exc}")
                return

            await self._emit("orchestrator", "start", novel=profile.vi_name)

            files = self._collect_files()
            if not files:
                await self._emit("orchestrator", "error",
                                 msg=f"Không có file .txt nào trong {self.input_dir}")
                return

            # Đăng ký tất cả chapters vào DB
            for path in files:
                num, zh_title = parse_chapter_filename(path.name)
                await self.state.upsert_chapter(path.name, self.novel_slug, num, zh_title)

            await self._emit("orchestrator", "queued", count=len(files))

            # Dịch song song với semaphore
            sem = asyncio.Semaphore(settings.concurrency)
            tasks = [self._translate_one(path, profile, sem) for path in files]
            await asyncio.gather(*tasks, return_exceptions=True)

            # Chạy extractor sau khi tất cả đã dịch
            await self._emit("orchestrator", "extracting")
            extractor = ExtractorAgent(
                slug=self.novel_slug,
                state=self.state,
                client=self.client,
                rules_dir=self.rules_dir,
            )
            async for event in extractor.run():
                await self.event_queue.put(event.to_dict())

            # Extractor vừa có thể append term mới vào novel.md → nạp lại profile
            # để WikiAgent/Reviewer thấy glossary mới nhất.
            try:
                profile = load_novel(self.rules_dir, self.novel_slug)
            except Exception:
                pass

            # Các chương dịch thành công trong batch này (dùng chung cho wiki + review)
            current_filenames = {path.name for path in files}
            done_chapters = [
                c for c in self.state.get_chapters(self.novel_slug)
                if c["status"] == ChapterStatus.DONE
                and c.get("translated_path")
                and c["filename"] in current_filenames
            ]

            # Story-wiki ingest: trích entity/quan hệ/sự kiện từ mỗi chương trong batch.
            # Đọc nguồn Trung (còn giữ Hán tự) — chương OCR không có .txt nguồn sẽ bỏ qua.
            wiki_targets = [
                c for c in done_chapters
                if (self.input_dir / c["filename"]).exists()
            ] if self.run_wiki else []
            if wiki_targets:
                await self._emit("orchestrator", "wiki_ingest", count=len(wiki_targets))
                for chapter in wiki_targets:
                    try:
                        wiki = WikiAgent(
                            filename=chapter["filename"],
                            novel_slug=self.novel_slug,
                            chapter_num=chapter["chapter_num"],
                            source_content=(self.input_dir / chapter["filename"]).read_text(encoding="utf-8"),
                            profile=profile,
                            state=self.state,
                            client=self.client,
                        )
                        async for event in wiki.run():
                            await self.event_queue.put(event.to_dict())
                    except Exception as exc:
                        await self._emit("wiki", "error",
                                         file=chapter["filename"], error=str(exc))
                await self._emit("orchestrator", "wiki_done", novel=self.novel_slug)

            # Review từng chương được dịch thành công trong batch này
            if done_chapters:
                await self._emit("orchestrator", "reviewing", count=len(done_chapters))
                for chapter in done_chapters:
                    reviewer = ReviewerAgent(
                        filename=chapter["filename"],
                        novel_slug=self.novel_slug,
                        translated_path=Path(chapter["translated_path"]),
                        source_path=self.input_dir / chapter["filename"],
                        profile=profile,
                        state=self.state,
                        client=self.client,
                    )
                    async for event in reviewer.run():
                        await self.event_queue.put(event.to_dict())

                reviews = self.state.get_reviews(self.novel_slug)
                await self._emit("orchestrator", "review_summary", reviews=reviews)

            await self._emit("orchestrator", "done", novel=self.novel_slug)

        except Exception as exc:
            await self._emit("orchestrator", "error", msg=f"Lỗi nghiêm trọng: {exc}")
        finally:
            await self.event_queue.close()

    async def _translate_one(self, path: Path, profile: NovelProfile, sem: asyncio.Semaphore):
        async with sem:
            filename = path.name
            chapter_info = self.state.get_chapter(filename)
            if (
                not self.force
                and chapter_info
                and chapter_info["status"] == ChapterStatus.DONE
            ):
                await self._emit("translator", "skip", file=filename, reason="already done")
                return

            await self.state.set_status(filename, ChapterStatus.IN_PROGRESS)
            await self._emit("translator", "start", file=filename)

            try:
                content = path.read_text(encoding="utf-8")
                content, substitutions = replace_proper_nouns(content, profile)
                if substitutions:
                    await self._emit("translator", "preprocess", file=filename, count=len(substitutions))
                review = self.state.get_chapter_review(filename)
                review_issues = (
                    review["issues"]
                    if review and review.get("status") == "needs_fix"
                    else None
                )
                agent = TranslatorAgent(
                    filename=filename,
                    content=content,
                    novel_slug=self.novel_slug,
                    profile=profile,
                    state=self.state,
                    client=self.client,
                    rate_limiter=self.rate_limiter,
                    output_dir=self.output_dir,
                    review_issues=review_issues,
                )
                async for event in agent.run():
                    await self.event_queue.put(event.to_dict())

                # Agent có thể kết thúc mà không gọi save_chapter (model trả lời
                # text rồi dừng, hoặc chạm MAX_ITER) → status kẹt 'in_progress'.
                # Gỡ kẹt ngay để UI không treo ở 50%.
                final = self.state.get_chapter(filename)
                if final and final["status"] == ChapterStatus.IN_PROGRESS:
                    if final.get("translated_path"):
                        await self.state.set_status(filename, ChapterStatus.DONE, error=None)
                    else:
                        await self.state.set_status(
                            filename, ChapterStatus.FAILED,
                            error="Agent kết thúc nhưng không gọi save_chapter",
                        )
                        await self._emit("translator", "error", file=filename,
                                         error="Không lưu được bản dịch (agent không gọi save_chapter)")

            except Exception as exc:
                await self.state.set_status(filename, ChapterStatus.FAILED, error=str(exc))
                await self._emit("translator", "error", file=filename, error=str(exc))

    def _collect_files(self) -> list[Path]:
        all_files = sorted(
            self.input_dir.glob("*.txt"),
            key=lambda p: parse_chapter_filename(p.name)[0],
        )
        if self.chapter_filenames:
            selected = set(self.chapter_filenames)
            return [f for f in all_files if f.name in selected]
        return all_files

    async def _emit(self, agent: str, type: str, **data):
        await self.event_queue.put({"agent": agent, "type": type, **data})
