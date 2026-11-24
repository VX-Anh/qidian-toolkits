import asyncio
import re
from pathlib import Path

import anthropic

from ..config import settings
from .extractor import ExtractorAgent
from .hanviet import soft
from .novel_loader import NovelProfile, load_novel, remove_auto_terms
from .preprocessor import replace_proper_nouns
from .reviewer import ReviewerAgent
from .state import ChapterStatus, EventQueue, SharedState
from .cli_translator import CliTranslatorAgent, CliUnavailable
from .name_check import check_chapter_file
from .name_scout import scout_chapter
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
        client: anthropic.AsyncAnthropic,
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
        self._auto_names: list[tuple[str, str]] = []  # (zh, vi) bước dò tên vừa thêm

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
            print(f"[dịch] ▶ BẮT ĐẦU dịch '{profile.vi_name}' — {len(files)} chương "
                  f"(song song {settings.concurrency})", flush=True)

            # Dò tên riêng mới TRƯỚC khi dịch, lần lượt theo thứ tự chương: tên chốt ở
            # chương trước đã nằm trong bảng khi dò chương sau, và lúc dịch mọi tên đều
            # được thay sẵn sang tên Việt chuẩn → nhất quán giữa các chương.
            if settings.name_scout:
                profile = await self._scout(files, profile)

            # Dịch song song với semaphore
            sem = asyncio.Semaphore(settings.concurrency)
            tasks = [self._translate_one(path, profile, sem) for path in files]
            await asyncio.gather(*tasks, return_exceptions=True)

            # Tên dò tự động mà bản dịch không dùng tới → gỡ khỏi bảng (thường là chữ nhiễu
            # trong bản gốc, model đã dịch theo ngữ cảnh thành tên khác).
            if self._auto_names:
                await self._prune_unused(files)

            # Chạy extractor sau khi tất cả đã dịch
            await self._emit("orchestrator", "extracting")
            extractor = ExtractorAgent(
                slug=self.novel_slug,
                state=self.state,
                client=self.client,
                rules_dir=self.rules_dir,
            )
            try:
                async for event in extractor.run():
                    await self.event_queue.put(event.to_dict())
            except Exception as exc:
                # Lỗi extractor (vd 429 hết retry) không được bỏ luôn wiki + review.
                await self._emit("extractor", "error", error=str(exc))

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
                    try:
                        async for event in reviewer.run():
                            await self.event_queue.put(event.to_dict())
                    except Exception as exc:
                        await self._emit("reviewer", "error",
                                         file=chapter["filename"], error=str(exc))

                reviews = self.state.get_reviews(self.novel_slug)
                await self._emit("orchestrator", "review_summary", reviews=reviews)

            await self._emit("orchestrator", "done", novel=self.novel_slug)
            print(f"[dịch] ■ HOÀN TẤT job '{profile.vi_name}' ({len(files)} chương)", flush=True)

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
                print(f"[dịch]   ⏭ bỏ qua (đã dịch): {filename}", flush=True)
                return

            await self.state.set_status(filename, ChapterStatus.IN_PROGRESS)
            await self._emit("translator", "start", file=filename)
            print(f"[dịch]   → bắt đầu: {filename}", flush=True)

            try:
                raw = path.read_text(encoding="utf-8")
                content, substitutions = replace_proper_nouns(raw, profile)
                if substitutions:
                    await self._emit("translator", "preprocess", file=filename, count=len(substitutions))
                review = self.state.get_chapter_review(filename)
                review_issues = (
                    review["issues"]
                    if review and review.get("status") == "needs_fix"
                    else None
                )
                use_api = settings.translate_provider.strip().lower() != "cli"
                if not use_api:
                    cli_agent = CliTranslatorAgent(
                        filename=filename,
                        content=content,
                        novel_slug=self.novel_slug,
                        profile=profile,
                        state=self.state,
                        output_dir=self.output_dir,
                        review_issues=review_issues,
                        source_raw=raw,
                    )
                    try:
                        async for event in cli_agent.run():
                            await self.event_queue.put(event.to_dict())
                    except CliUnavailable as exc:
                        if not settings.cli_fallback_api:
                            raise
                        # CLI hỏng / hết hạn mức → dịch lại chương này bằng API. "start" mới
                        # để UI xoá phần chữ CLI đã stream dở.
                        print(f"[dịch]   ↺ CLI lỗi, chuyển API: {filename} — {exc}", flush=True)
                        await self._emit("translator", "start", file=filename,
                                         provider="api", fallback=str(exc)[:300])
                        use_api = True
                if use_api:
                    agent = TranslatorAgent(
                        filename=filename,
                        content=content,
                        novel_slug=self.novel_slug,
                        profile=profile,
                        state=self.state,
                        client=self.client,
                        output_dir=self.output_dir,
                        review_issues=review_issues,
                        source_raw=raw,
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

                final = self.state.get_chapter(filename)
                if final and final["status"] == ChapterStatus.DONE:
                    await self._check_names(final, path)
                    print(f"[dịch]   ✓ xong: {filename}", flush=True)
                else:
                    print(f"[dịch]   ✗ thất bại: {filename}", flush=True)

            except asyncio.CancelledError:
                # CancelledError là BaseException → `except Exception` không bắt; trước
                # đây chương kẹt 'in_progress' tới khi restart server.
                prev = self.state.get_chapter(filename) or {}
                await self.state.set_status(
                    filename,
                    ChapterStatus.DONE if prev.get("translated_path") and not self.force
                    else ChapterStatus.PENDING,
                )
                print(f"[dịch]   ⏹ huỷ: {filename}", flush=True)
                raise
            except Exception as exc:
                await self.state.set_status(filename, ChapterStatus.FAILED, error=str(exc))
                await self._emit("translator", "error", file=filename, error=str(exc))
                print(f"[dịch]   ✗ lỗi: {filename} — {exc}", flush=True)

    async def _scout(self, files: list[Path], profile: NovelProfile) -> NovelProfile:
        targets = [p for p in files if self.force
                   or (self.state.get_chapter(p.name) or {}).get("status") != ChapterStatus.DONE]
        if not targets:
            return profile
        await self._emit("orchestrator", "scouting", count=len(targets))
        for path in targets:
            num, _ = parse_chapter_filename(path.name)
            try:
                added = await scout_chapter(path.read_text(encoding="utf-8"), profile,
                                            self.rules_dir, self.novel_slug, num, self.client)
                await self._emit("scout", "done", file=path.name,
                                 added=[f"{n.zh} → {n.vi}" for n in added])
                if added:
                    self._auto_names += [(n.zh, n.vi) for n in added]
                    print(f"[dịch]   + {len(added)} tên mới: {path.name}", flush=True)
                    profile = load_novel(self.rules_dir, self.novel_slug)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Dò tên lỗi không chặn dịch: chương vẫn dịch với bảng hiện có.
                await self._emit("scout", "error", file=path.name, error=str(exc)[:300])
                print(f"[dịch]   ! dò tên lỗi: {path.name} — {exc}", flush=True)
        return profile

    async def _prune_unused(self, files: list[Path]) -> None:
        """Gỡ tên tự thêm mà KHÔNG chương nào chứa nó dùng tới trong bản dịch. Giữ lại nếu
        có chương chứa tên chưa dịch xong (thất bại / huỷ) — chưa đủ bằng chứng."""
        try:
            sources: list[tuple[Path, str, dict | None, str | None]] = []
            for path in files:
                ch = self.state.get_chapter(path.name)
                text = None
                if ch and ch["status"] == ChapterStatus.DONE and ch.get("translated_path"):
                    try:
                        text = soft(Path(ch["translated_path"]).read_text(encoding="utf-8"))
                    except OSError:
                        text = None
                sources.append((path, path.read_text(encoding="utf-8"), ch, text))
            unused = []
            for zh, vi in self._auto_names:
                hits = [s for s in sources if zh in s[1]]
                if hits and all(s[3] is not None and soft(vi) not in s[3] for s in hits):
                    unused.append((zh, vi))
            removed = remove_auto_terms(self.rules_dir, self.novel_slug, unused)
            if not removed:
                return
            await self._emit("scout", "pruned", removed=[f"{zh} → {vi}" for zh, vi in removed])
            print(f"[dịch]   − gỡ {len(removed)} tên tự động không dùng: "
                  + ", ".join(f"{zh}→{vi}" for zh, vi in removed), flush=True)
            # Kiểm tên lại các chương liên quan để bỏ báo "thiếu tên" của dòng vừa gỡ.
            gone = {zh for zh, _ in removed}
            for path, raw, ch, _ in sources:
                if ch and ch["status"] == ChapterStatus.DONE and any(z in raw for z in gone):
                    await self._check_names(ch, path)
        except Exception as exc:
            await self._emit("scout", "error", error=f"gỡ tên không dùng: {str(exc)[:300]}")

    async def _check_names(self, chapter: dict, path: Path) -> None:
        """Kiểm + tự sửa tên trong bản dịch vừa lưu (bảng mới nhất). Lỗi không làm hỏng chương."""
        try:
            profile = load_novel(self.rules_dir, self.novel_slug)
            res = await check_chapter_file(self.state, chapter, path, profile)
            if res is not None:
                await self._emit("names", "checked", file=chapter["filename"],
                                 fixed=res.fixed_count, issues=len(res.issues))
        except Exception as exc:
            await self._emit("names", "error", file=chapter["filename"], error=str(exc)[:300])

    def _collect_files(self) -> list[Path]:
        # input_dir là thư mục phẳng dùng chung cho mọi truyện → chỉ lấy file đã
        # đăng ký cho truyện này, hoặc file chưa thuộc truyện nào. Trước đây glob
        # hết *.txt nên chương của truyện khác bị dịch bằng glossary của truyện này.
        owner = {c["filename"]: c["novel_slug"] for c in self.state.get_chapters()}
        all_files = sorted(
            (p for p in self.input_dir.glob("*.txt")
             if owner.get(p.name) in (None, "unknown", self.novel_slug)),
            key=lambda p: parse_chapter_filename(p.name)[0],
        )
        if self.chapter_filenames:
            selected = set(self.chapter_filenames)
            return [f for f in all_files if f.name in selected]
        return all_files

    async def _emit(self, agent: str, type: str, **data):
        await self.event_queue.put({"agent": agent, "type": type, **data})
