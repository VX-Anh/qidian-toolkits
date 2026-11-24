"""Lưu sách ra thư mục: book.json (trạng thái để chạy tiếp/cập nhật) + chapters/*.txt.

Tên file chương theo mẫu VietPhase đọc được: `第<số>章 <tên>.txt` (số Ả Rập).
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from .sites.base import Book, ChapterRef
from .text import safe_filename

_CN_DIGITS = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
              "六": 6, "七": 7, "八": 8, "九": 9}
_CN_UNITS = {"十": 10, "百": 100, "千": 1000, "万": 10000}
_NUM_PREFIX = re.compile(r"^\s*第\s*([0-9０-９零〇一二两三四五六七八九十百千万]+)\s*[章节回]\s*[:：、.\s]*")


def cn_to_int(s: str) -> int | None:
    s = s.translate(str.maketrans("０１２３４５６７８９", "0123456789"))
    if s.isdigit():
        return int(s)
    total, section, num = 0, 0, 0
    for ch in s:
        if ch in _CN_DIGITS:
            num = _CN_DIGITS[ch]
        elif ch in _CN_UNITS:
            unit = _CN_UNITS[ch]
            if unit == 10000:
                total += (section + num) * unit
                section = 0
            else:
                section += (num or 1) * unit
            num = 0
        else:
            return None
    return total + section + num


def split_title(title: str) -> tuple[int | None, str]:
    """'第十二章 风起' → (12, '风起');  '序章 开端' → (None, '序章 开端')."""
    m = _NUM_PREFIX.match(title)
    if not m:
        return None, title.strip()
    return cn_to_int(m.group(1)), title[m.end():].strip() or title.strip()


def assign_numbers(chapters: list[ChapterRef]) -> list[tuple[int, str]]:
    """Số chương cho tên file (VietPhase sắp chương theo số này, không giảm dần).

    - Tiêu đề có số lớn hơn số trước → giữ đúng số gốc (第12章 → 12).
    - Số bị lùi (quyển mới đánh lại từ 1) → số trước + 1, giữ cả tiêu đề gốc.
    - Chương không số (序章, 感言, 请假条...) → dùng lại số chương liền trước (0 nếu đứng đầu)
      để chương sau vẫn giữ đúng số gốc. Tên file khác nhau nhờ phần tiêu đề.
    """
    out, prev, used = [], 0, set()
    for c in chapters:
        n, rest = split_title(c.title)
        if n is None:
            n, rest = prev, c.title.strip()
        elif n <= prev:
            n, rest = prev + 1, c.title.strip()
        key, k = (n, rest), 2
        while key in used:                      # trùng hẳn tên → thêm (2), (3)
            key = (n, f"{rest} ({k})")
            k += 1
        used.add(key)
        out.append(key)
        prev = n
    return out


class BookStore:
    def __init__(self, root: Path):
        self.root = root
        self.chapters_dir = root / "chapters"
        self.meta_path = root / "book.json"

    @classmethod
    def for_book(cls, out_dir: Path, book: Book) -> "BookStore":
        for p in out_dir.glob(f"{book.site}_{book.book_id}*"):   # đã có thư mục cũ → dùng lại
            if (p / "book.json").exists():
                return cls(p)
        return cls(out_dir / safe_filename(f"{book.site}_{book.book_id} {book.title}"))

    def load(self) -> dict:
        if self.meta_path.exists():
            return json.loads(self.meta_path.read_text(encoding="utf-8"))
        return {}

    def save_meta(self, book: Book, files: dict[str, str]):
        self.root.mkdir(parents=True, exist_ok=True)
        data = {
            "site": book.site, "book_id": book.book_id, "title": book.title,
            "author": book.author, "catalog_url": book.url,
            "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "chapters": [dict(asdict(c), file=files.get(c.url)) for c in book.chapters],
        }
        tmp = self.meta_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self.meta_path)

    def chapter_filename(self, num: int, rest: str) -> str:
        return safe_filename(f"第{num}章 {rest}", 100) + ".txt"

    def write_chapter(self, filename: str, title: str, lines: list[str]):
        self.chapters_dir.mkdir(parents=True, exist_ok=True)
        body = title + "\n\n" + "\n\n".join(lines) + "\n"
        tmp = self.chapters_dir / (filename + ".part")
        tmp.write_text(body, encoding="utf-8")
        tmp.replace(self.chapters_dir / filename)

    def merge(self, out_file: Path | None = None) -> Path:
        meta = self.load()
        out_file = out_file or self.root / (safe_filename(meta.get("title") or "book") + ".txt")
        with out_file.open("w", encoding="utf-8") as f:
            f.write(f"{meta.get('title', '')}\n作者：{meta.get('author', '')}\n\n")
            for c in meta.get("chapters", []):
                if c.get("file") and (self.chapters_dir / c["file"]).exists():
                    f.write((self.chapters_dir / c["file"]).read_text(encoding="utf-8"))
                    f.write("\n\n")
        return out_file
