"""Test chặn ghi ra ngoài --root của seed_ux_demo.py (chỉ dùng thư viện chuẩn).

Chạy (trong qidian-vietphase/):  python3 -m unittest scripts/test_seed_ux_demo.py
Các trường hợp bị từ chối dừng ở bước kiểm trước khi import backend, nên không cần cài gói.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("seed_ux_demo", _HERE / "seed_ux_demo.py")
seed_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(seed_mod)

CH1 = seed_mod._zh_filename(1, seed_mod.NOVELS["a"]["chapters"][1][0])
OUT4 = seed_mod._out_path(seed_mod._paths(Path("/x")), "truyen-mau-a", 4,
                          seed_mod.NOVELS["a"]["chapters"][4][1]).name


class SeedSymlinkTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(os.path.realpath(self._tmp.name))
        self.root = base / "root"
        self.outside = base / "outside"
        self.root.mkdir()
        self.outside.mkdir()
        self._env = {k: os.environ.pop(k) for k in seed_mod.PATH_VARS if k in os.environ}

    def tearDown(self):
        os.environ.update(self._env)
        self._tmp.cleanup()

    def outside_files(self):
        return sorted(p.relative_to(self.outside) for p in self.outside.rglob("*"))

    def run_main(self, *args):
        old = sys.argv
        sys.argv = ["seed_ux_demo.py", "--root", str(self.root), *args]
        try:
            return seed_mod.main()
        except SystemExit as e:
            return e.code
        finally:
            sys.argv = old

    def assert_refused(self, *args):
        before = self.outside_files()
        code = self.run_main(*args)
        self.assertNotIn(code, (0, None), "phải từ chối")
        self.assertEqual(self.outside_files(), before, "không được ghi ra ngoài root")

    # ── Thư mục trung gian là liên kết ────────────────────────────────────────
    def test_rules_dir_symlink(self):
        (self.root / "rules").symlink_to(self.outside, target_is_directory=True)
        self.assert_refused("--force")

    def test_input_dir_symlink(self):
        (self.root / "input").symlink_to(self.outside, target_is_directory=True)
        self.assert_refused("--force")

    def test_db_dir_symlink(self):
        (self.root / "db").symlink_to(self.outside, target_is_directory=True)
        self.assert_refused("--force")

    def test_nested_rules_slug_symlink(self):
        (self.root / "rules").mkdir()
        (self.root / "rules" / "truyen-mau-b").symlink_to(self.outside, target_is_directory=True)
        self.assert_refused("--force")

    # ── File đích là liên kết (kể cả liên kết hỏng) ──────────────────────────
    def test_input_file_symlink(self):
        (self.root / "input").mkdir()
        target = self.outside / "victim.txt"
        target.write_text("giữ nguyên", encoding="utf-8")
        (self.root / "input" / CH1).symlink_to(target)
        self.assert_refused("--force")
        self.assertEqual(target.read_text(encoding="utf-8"), "giữ nguyên")

    def test_dangling_novel_md_symlink(self):
        (self.root / "rules" / "truyen-mau-a").mkdir(parents=True)
        (self.root / "rules" / "truyen-mau-a" / "novel.md").symlink_to(self.outside / "moi.md")
        self.assert_refused("--force")

    def test_marker_symlink(self):
        (self.root / seed_mod.MARKER).symlink_to(self.outside / "marker")
        self.assert_refused("--force")

    def test_db_file_symlink(self):
        (self.root / "db").mkdir()
        (self.root / "db" / "state.db").symlink_to(self.outside / "state.db")
        self.assert_refused("--force")

    def test_db_wal_symlink(self):
        (self.root / "db").mkdir()
        (self.root / "db" / "state.db-wal").symlink_to(self.outside / "wal")
        self.assert_refused("--force")

    # ── Chế độ --mark-done / --unmark trên root đã có marker ─────────────────
    def _marked_root(self):
        (self.root / seed_mod.MARKER).write_text("x", encoding="utf-8")

    def test_mark_done_output_slug_symlink(self):
        self._marked_root()
        (self.root / "output").mkdir()
        (self.root / "output" / "truyen-mau-a").symlink_to(self.outside, target_is_directory=True)
        self.assert_refused("--mark-done", "4")

    def test_mark_done_output_file_symlink(self):
        self._marked_root()
        (self.root / "output" / "truyen-mau-a").mkdir(parents=True)
        (self.root / "output" / "truyen-mau-a" / OUT4).symlink_to(self.outside / "out4.txt")
        self.assert_refused("--mark-done", "4")

    def test_unmark_db_symlink(self):
        self._marked_root()
        (self.root / "db").symlink_to(self.outside, target_is_directory=True)
        self.assert_refused("--unmark", "3")

    # ── Hàm kiểm ──────────────────────────────────────────────────────────────
    def test_ensure_inside_plain_paths_ok(self):
        p = self.root / "rules" / "a" / "novel.md"
        self.assertEqual(seed_mod.ensure_inside(self.root, p), p)

    def test_ensure_inside_rejects_symlink_pointing_inside(self):
        (self.root / "real").mkdir()
        (self.root / "link").symlink_to(self.root / "real", target_is_directory=True)
        with self.assertRaises(SystemExit):
            seed_mod.ensure_inside(self.root, self.root / "link" / "f.txt")

    def test_ensure_inside_rejects_parent_escape(self):
        with self.assertRaises(SystemExit):
            seed_mod.ensure_inside(self.root, self.root / ".." / "outside" / "f.txt")


if __name__ == "__main__":
    unittest.main()
