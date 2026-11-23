"""Test dịch qua Claude CLI (backend/agent/cli_translator.py) bằng CLI giả.

Chạy (trong qidian-vietphase/):  uv run python -m unittest discover -s tests
"""
from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from backend.agent import cli_translator as ct
from backend.agent.novel_loader import NovelProfile
from backend.agent.state import ChapterStatus, SharedState

GOOD = textwrap.dedent("""\
    <tieu_de>Thiên Diễn</tieu_de>
    <ban_dich>
    Đoạn một.

    Đoạn hai có </ban chữ lạ.
    </ban_dich>
    <tom_tat>Nhân vật chính đột phá.</tom_tat>
    <thuat_ngu>
    天演诀 | công pháp chính
    - 青云宗 | tông môn
    Không có chữ Hán thì bỏ
    </thuat_ngu>
""")


class ParseTest(unittest.TestCase):
    def test_parse_ok(self):
        r = ct.parse_output(GOOD)
        self.assertEqual(r.vi_title, "Thiên Diễn")
        self.assertEqual(r.content, "Đoạn một.\n\nĐoạn hai có </ban chữ lạ.")
        self.assertEqual(r.summary, "Nhân vật chính đột phá.")
        self.assertEqual(r.unknown_terms, [("天演诀", "công pháp chính"), ("青云宗", "tông môn")])

    def test_parse_missing_body(self):
        with self.assertRaises(RuntimeError):
            ct.parse_output("<tieu_de>X</tieu_de>")

    def test_parse_missing_title(self):
        with self.assertRaises(RuntimeError):
            ct.parse_output("<ban_dich>abc</ban_dich>")

    def test_streamer_char_by_char(self):
        s = ct.BanDichStreamer()
        out = "".join(s.feed(ch) for ch in GOOD)
        self.assertEqual(out, "Đoạn một.\n\nĐoạn hai có </ban chữ lạ.\n")
        self.assertNotIn("</ban_dich", out)

    def test_streamer_chunks(self):
        s = ct.BanDichStreamer()
        out = "".join(s.feed(GOOD[i:i + 7]) for i in range(0, len(GOOD), 7))
        self.assertEqual(out, "Đoạn một.\n\nĐoạn hai có </ban chữ lạ.\n")


FAKE_CLI = textwrap.dedent("""\
    import json, sys
    sys.stdout.reconfigure(encoding="utf-8")
    mode = sys.argv[1]
    sys.stdin.read()
    def out(o): print(json.dumps(o, ensure_ascii=False), flush=True)
    text = open(sys.argv[2], encoding="utf-8").read()
    if mode == "fail":
        sys.stderr.write("Not logged in")
        sys.exit(1)
    out({"type": "system", "subtype": "init"})
    for i in range(0, len(text), 5):
        out({"type": "stream_event", "event": {"type": "content_block_delta",
             "delta": {"type": "text_delta", "text": text[i:i + 5]}}})
    out({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}})
    if mode == "quota":
        out({"type": "result", "subtype": "success", "is_error": True, "result": "usage limit reached"})
    else:
        out({"type": "result", "subtype": "success", "is_error": False, "result": text})
""")


class RunTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        (d / "fake_cli.py").write_text(FAKE_CLI, encoding="utf-8")
        (d / "reply.txt").write_text(GOOD, encoding="utf-8")
        self.dir = d
        self.state = SharedState(str(d / "state.db"))
        self.fn = "第2章 天演.txt"
        asyncio.run(self.state.upsert_chapter(self.fn, "truyen", 2, "天演"))
        self._orig = ct.cli_command

    def tearDown(self):
        ct.cli_command = self._orig
        self.state._conn.close()   # Windows: phải đóng SQLite trước khi xoá thư mục tạm
        self.tmp.cleanup()

    def _run(self, mode: str):
        ct.cli_command = lambda _sp: [sys.executable, str(self.dir / "fake_cli.py"), mode,
                                      str(self.dir / "reply.txt")]
        profile = NovelProfile(slug="truyen", zh_name="", vi_name="Truyện", genre="", style="", custom_prompt="Dịch.")
        agent = ct.CliTranslatorAgent(self.fn, "原文", "truyen", profile, self.state, self.dir / "out")

        async def go():
            return [e async for e in agent.run()]
        return asyncio.run(go())

    def test_success_saves_chapter(self):
        events = self._run("ok")
        tokens = "".join(e.data["text"] for e in events if e.type == "token")
        self.assertEqual(tokens, "Đoạn một.\n\nĐoạn hai có </ban chữ lạ.\n")
        ch = self.state.get_chapter(self.fn)
        self.assertEqual(ch["status"], ChapterStatus.DONE)
        out = Path(ch["translated_path"])
        self.assertEqual(out.read_text(encoding="utf-8"),
                         "# Thiên Diễn\n\nĐoạn một.\n\nĐoạn hai có </ban chữ lạ.\n")
        self.assertEqual(self.state.get_summary(self.fn), "Nhân vật chính đột phá.")

    def test_exit_error_is_unavailable(self):
        with self.assertRaises(ct.CliUnavailable) as cm:
            self._run("fail")
        self.assertIn("Not logged in", str(cm.exception))
        self.assertNotEqual(self.state.get_chapter(self.fn)["status"], ChapterStatus.DONE)

    def test_result_error_is_unavailable(self):
        with self.assertRaises(ct.CliUnavailable):
            self._run("quota")

    def test_missing_binary_is_unavailable(self):
        ct.cli_command = lambda _sp: [str(self.dir / "khong-co-lenh")]
        profile = NovelProfile(slug="truyen", zh_name="", vi_name="Truyện", genre="", style="", custom_prompt="Dịch.")
        agent = ct.CliTranslatorAgent(self.fn, "原文", "truyen", profile, self.state, self.dir / "out")

        async def go():
            return [e async for e in agent.run()]
        with self.assertRaises(ct.CliUnavailable):
            asyncio.run(go())


if __name__ == "__main__":
    unittest.main()
