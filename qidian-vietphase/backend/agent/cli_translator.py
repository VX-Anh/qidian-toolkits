"""CliTranslatorAgent — dịch chương bằng Claude Code CLI (`claude -p`) thay cho Claude API.

Dùng gói đăng ký Claude đã đăng nhập trong CLI chính thức, chạy headless; không chuyển
token đăng ký thành API. Bật bằng TRANSLATE_PROVIDER=cli.

Khác TranslatorAgent (API):
- Không tool use: CLI chạy với `--tools ""`. Model trả về một khối văn bản có thẻ
  <tieu_de>, <ban_dich>, <tom_tat>, <thuat_ngu>; backend tự gọi save_chapter /
  save_summary / flag_unknown_term (cùng registry với bản API) từ kết quả đã parse.
- Tóm tắt chương trước được đưa thẳng vào prompt thay cho tool get_prev_summary.
- Chữ trong <ban_dich> stream ra UI theo từng mảnh như event "token" của bản API.

Lỗi chạy CLI (chưa cài, chưa đăng nhập, hết hạn mức, quá thời gian) → CliUnavailable,
để orchestrator chuyển sang API nếu CLI_FALLBACK_API bật. Model trả sai định dạng →
RuntimeError (chương FAILED), không tốn thêm lượt API.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator

from ..config import settings
from .base import AgentEvent
from .novel_loader import NovelProfile
from .state import SharedState
from .translator import _make_registry

OPEN_TAG = "<ban_dich>"
CLOSE_TAG = "</ban_dich>"
# Giới hạn một dòng stream-json (bản dịch dài nằm trọn trong event "assistant"/"result").
_LINE_LIMIT = 64 * 1024 * 1024
_STDERR_TAIL = 2000
# Không đưa cho CLI: key API (CLI sẽ tính tiền API thay vì gói đăng ký) và token của app.
_ENV_DROP = {"ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_FILE", "ANTHROPIC_AUTH_TOKEN", "API_TOKEN"}


def cli_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in _ENV_DROP}
    env["NO_COLOR"] = "1"
    return env


class CliUnavailable(RuntimeError):
    """CLI không chạy được hoặc không trả kết quả: có thể chuyển sang Claude API."""


@dataclass(frozen=True)
class CliTranslation:
    vi_title: str
    content: str
    summary: str
    unknown_terms: list[tuple[str, str]]


def _tag(text: str, name: str) -> str | None:
    m = re.search(rf"<{name}>\s*(.*?)\s*</{name}>", text, re.S)
    return m.group(1) if m else None


def parse_output(text: str) -> CliTranslation:
    """Tách kết quả model. Thiếu <ban_dich> hoặc <tieu_de> → RuntimeError."""
    content = _tag(text, "ban_dich")
    title = _tag(text, "tieu_de")
    if not content or not content.strip():
        raise RuntimeError("CLI trả kết quả thiếu khối <ban_dich> — không lưu bản dịch")
    title = re.sub(r"\s+", " ", (title or "").strip())
    if not title:
        raise RuntimeError("CLI trả kết quả thiếu <tieu_de> — không lưu bản dịch")
    terms: list[tuple[str, str]] = []
    for line in (_tag(text, "thuat_ngu") or "").splitlines():
        line = line.strip().lstrip("-•* ").strip()
        if not line or line.lower() in ("không có", "khong co", "(không có)"):
            continue
        zh, _, ctx = line.partition("|")
        zh = zh.strip()
        # Chỉ nhận mục có chữ Hán: dòng giải thích lạc vào khối bị bỏ.
        if zh and re.search(r"[㐀-鿿]", zh) and len(zh) <= 40:
            terms.append((zh, ctx.strip()[:300]))
    return CliTranslation(title, content.strip(), (_tag(text, "tom_tat") or "").strip(), terms)


class BanDichStreamer:
    """Nhận text model viết dần, trả phần mới nằm trong <ban_dich>…</ban_dich>.

    Giữ lại đuôi có thể là đầu của thẻ đóng (vd "</ban_") để không phát ra UI.
    """

    def __init__(self) -> None:
        self.buf = ""
        self.sent = 0  # số ký tự của nội dung khối đã phát

    def feed(self, chunk: str) -> str:
        self.buf += chunk
        start = self.buf.find(OPEN_TAG)
        if start < 0:
            return ""
        start += len(OPEN_TAG)
        if self.buf.startswith("\n", start):
            start += 1
        elif len(self.buf) == start:
            return ""   # chưa biết ký tự sau thẻ mở có phải xuống dòng không
        end = self.buf.find(CLOSE_TAG, start)
        if end < 0:
            end = len(self.buf)
            for k in range(min(len(CLOSE_TAG) - 1, end - start), 0, -1):
                if CLOSE_TAG.startswith(self.buf[end - k:end]):
                    end -= k
                    break
        body = self.buf[start:end]
        if len(body) <= self.sent:
            return ""
        out = body[self.sent:]
        self.sent = len(body)
        return out


def build_prompt(filename: str, content: str, prev_summary: str | None,
                 review_issues: str | None) -> str:
    parts = [
        f"Dịch file chương: '{filename}'",
        "Dưới đây là toàn bộ nội dung:",
        "",
        content.strip(),
        "",
        "---",
        "",
    ]
    if prev_summary:
        parts += ["Tóm tắt chương trước (để giữ mạch truyện):", prev_summary.strip(), ""]
    parts += [
        "Hướng dẫn:",
        "1. Tên riêng trong bảng thuật ngữ đã được thay sang tiếng Việt trước. Giữ nguyên các tên riêng tiếng Việt này khi dịch.",
        "2. Dịch toàn bộ nội dung, giữ nguyên số lượng đoạn văn. Dịch tên chương sang tiếng Việt.",
        "3. Trả lời ĐÚNG định dạng sau, không viết gì ngoài các thẻ:",
        "<tieu_de>tên chương tiếng Việt (không kèm 'Chương N')</tieu_de>",
        OPEN_TAG,
        "toàn bộ bản dịch, mỗi đoạn một dòng, giữa các đoạn một dòng trống",
        CLOSE_TAG,
        "<tom_tat>tóm tắt 2-3 câu nội dung chương</tom_tat>",
        "<thuat_ngu>",
        "mỗi dòng một danh từ riêng tiếng Trung còn sót chưa có trong bảng thuật ngữ: 中文 | ngữ cảnh ngắn",
        "(để trống nếu không có)",
        "</thuat_ngu>",
    ]
    if review_issues:
        parts += ["", "[LẦN TRƯỚC CÓ VẤN ĐỀ — HÃY SỬA]", review_issues]
    return "\n".join(parts)


def cli_command(system_prompt_file: str) -> list[str]:
    cmd = [
        settings.cli_bin, "-p",            # prompt qua stdin
        "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--tools", "",                     # chỉ dịch: không đọc/ghi file, không chạy lệnh
        "--strict-mcp-config",             # không nạp MCP server nào
        "--setting-sources", "",           # bỏ settings/hook của máy
        "--no-session-persistence",
        "--model", settings.cli_model or settings.llm_model,
        # Qua file: glossary lớn vượt giới hạn một đối số dòng lệnh (Windows ~32K ký tự,
        # Linux 128 KiB).
        "--system-prompt-file", system_prompt_file,
    ]
    if settings.cli_effort:
        cmd += ["--effort", settings.cli_effort]
    return cmd


class CliTranslatorAgent:
    def __init__(
        self,
        filename: str,
        content: str,
        novel_slug: str,
        profile: NovelProfile,
        state: SharedState,
        output_dir: Path,
        review_issues: str | None = None,
    ):
        self.agent_id = f"translator:{filename}"
        self.filename = filename
        self.content = content
        self.novel_slug = novel_slug
        self.profile = profile
        self.state = state
        self.review_issues = review_issues
        self.registry = _make_registry(state, filename, novel_slug, output_dir, profile)

    def _emit(self, type: str, **data) -> AgentEvent:
        return AgentEvent(agent_id=self.agent_id, type=type, data=data)

    def _prev_summary(self) -> str | None:
        info = self.state.get_chapter(self.filename) or {}
        num = info.get("chapter_num") or 0
        if num <= 1:
            return None
        for c in self.state.get_chapters(self.novel_slug):
            if c.get("chapter_num") == num - 1:
                return self.state.get_summary(c["filename"])
        return None

    async def run(self) -> AsyncIterator[AgentEvent]:
        yield self._emit("thinking", iteration=0, provider="cli")
        prompt = build_prompt(self.filename, self.content, self._prev_summary(), self.review_issues)
        streamer = BanDichStreamer()
        final_text: str | None = None
        result_error: str | None = None

        # cwd là thư mục tạm rỗng: CLI không thấy mã nguồn/dữ liệu (dù không có tool).
        with tempfile.TemporaryDirectory(prefix="vp-cli-") as cwd:
            sp_file = Path(cwd) / "system-prompt.txt"
            sp_file.write_text(self.profile.system_prompt(), encoding="utf-8")
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cli_command(str(sp_file)),
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE, cwd=cwd, limit=_LINE_LIMIT,
                    env=cli_env(),
                )
            except (OSError, NotImplementedError) as exc:
                # NotImplementedError: event loop không hỗ trợ subprocess (Windows + uvicorn
                # --reload dùng SelectorEventLoop) → chạy server không --reload khi dùng CLI.
                raise CliUnavailable(f"Không chạy được Claude CLI ({settings.cli_bin}): "
                                     f"{type(exc).__name__}: {exc}") from exc

            stderr_task = asyncio.create_task(proc.stderr.read())   # type: ignore[union-attr]
            try:
                async with asyncio.timeout(settings.cli_timeout):
                    try:
                        proc.stdin.write(prompt.encode("utf-8"))    # type: ignore[union-attr]
                        await proc.stdin.drain()                    # type: ignore[union-attr]
                        proc.stdin.close()                          # type: ignore[union-attr]
                    except (BrokenPipeError, ConnectionResetError):
                        # CLI thoát trước khi đọc hết prompt (vd chưa đăng nhập): đọc tiếp
                        # stdout/stderr, mã thoát ≠ 0 bên dưới thành CliUnavailable.
                        pass
                    async for raw in proc.stdout:                   # type: ignore[union-attr]
                        try:
                            msg = json.loads(raw)
                        except ValueError:
                            continue
                        if not isinstance(msg, dict):
                            continue
                        kind = msg.get("type")
                        if kind == "stream_event":
                            ev = msg.get("event") or {}
                            delta = ev.get("delta") or {}
                            if ev.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
                                piece = streamer.feed(delta.get("text") or "")
                                if piece:
                                    yield self._emit("token", text=piece)
                        elif kind == "assistant":
                            blocks = (msg.get("message") or {}).get("content") or []
                            text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
                            if text:
                                final_text = text
                        elif kind == "result":
                            if msg.get("is_error") or msg.get("subtype") != "success":
                                result_error = str(msg.get("result") or msg.get("subtype") or "lỗi không rõ")
                            elif isinstance(msg.get("result"), str) and msg["result"]:
                                final_text = msg["result"]
                    await proc.wait()
            except TimeoutError:
                raise CliUnavailable(f"Claude CLI quá {settings.cli_timeout} giây") from None
            except (ValueError, asyncio.LimitOverrunError) as exc:
                # Một dòng stream-json vượt _LINE_LIMIT.
                raise CliUnavailable(f"Đọc output Claude CLI lỗi: {exc}") from exc
            finally:
                # Mọi đường thoát (timeout, huỷ, lỗi lạ, generator bị đóng sớm): không để
                # tiến trình CLI chạy mồ côi, rồi mới chờ stderr (EOF khi tiến trình đã chết).
                if proc.returncode is None:
                    proc.kill()
                    await proc.wait()
                stderr = (await stderr_task).decode("utf-8", "replace")[-_STDERR_TAIL:]

        if result_error or proc.returncode != 0 or final_text is None:
            detail = result_error or stderr.strip() or f"mã thoát {proc.returncode}"
            raise CliUnavailable(f"Claude CLI lỗi: {detail[:500]}")

        parsed = parse_output(final_text)
        yield self._emit("tool_call", tools=["save_chapter", "save_summary"], provider="cli")
        saved = await self.registry.call("save_chapter",
                                         {"vi_title": parsed.vi_title, "content": parsed.content})
        if not saved.success:
            raise RuntimeError(f"Lưu bản dịch lỗi: {saved.error}")
        yield self._emit("tool_result", tool="save_chapter", success=True, preview=str(saved.data)[:300])
        if parsed.summary:
            await self.registry.call("save_summary", {"summary": parsed.summary})
        for zh, ctx in parsed.unknown_terms:
            await self.registry.call("flag_unknown_term", {"zh_term": zh, "context": ctx})
        yield self._emit("done", content="", provider="cli")
