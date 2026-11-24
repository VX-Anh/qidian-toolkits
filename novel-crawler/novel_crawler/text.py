"""Chuyển khối HTML nội dung chương thành text sạch."""
from __future__ import annotations

import re

from bs4 import BeautifulSoup, NavigableString, Tag

# Dòng quảng cáo / rác hay gặp ở các trang raw. Khớp là bỏ CẢ dòng.
COMMON_JUNK = [
    r"笔趣阁",
    r"69书吧|69shu",
    r"请收藏本站|请记住本站|本站域名|最新网址|手机版阅读网址|手机用户请浏览",
    r"一秒记住|天才一秒",
    r"章节错误.{0,6}点此举报|(加入|添加)书签|返回目录|上一章|下一章",
    r"(https?://|www\.)[\w.-]+",
    r"本章未完.{0,6}点击下一页",
    r"喜欢.{1,40}请大家收藏",
]

_BLOCK_TAGS = {"p", "div", "br", "h1", "h2", "h3", "li", "section", "article"}


def html_to_lines(node: Tag | str) -> list[str]:
    """Lấy text theo dòng: <br>, <p>, <div> đều tách dòng."""
    if isinstance(node, str):
        node = BeautifulSoup(node, "lxml")
    parts: list[str] = []

    def walk(el):
        for child in el.children:
            if isinstance(child, NavigableString):
                if child.__class__.__name__ in ("Comment", "Script", "Stylesheet"):
                    continue
                parts.append(str(child))
            elif isinstance(child, Tag):
                if child.name in ("script", "style", "noscript"):
                    continue
                if child.name == "br":
                    parts.append("\n")
                    continue
                block = child.name in _BLOCK_TAGS
                if block:
                    parts.append("\n")
                walk(child)
                if block:
                    parts.append("\n")

    walk(node)
    return clean_lines("".join(parts).split("\n"))


def clean_lines(lines, junk_patterns=(), drop_common=True) -> list[str]:
    pats = list(junk_patterns) + (COMMON_JUNK if drop_common else [])
    rx = re.compile("|".join(f"(?:{p})" for p in pats)) if pats else None
    out = []
    for raw in lines:
        s = raw.replace("\xa0", " ").replace("　", " ").replace("﻿", "").strip()
        if not s:
            continue
        if rx and rx.search(s):
            continue
        out.append(s)
    return out


def strip_title_line(lines: list[str], title: str) -> list[str]:
    """Bỏ dòng đầu nếu nó lặp lại tiêu đề chương."""
    if lines and title and _norm(lines[0]) == _norm(title):
        return lines[1:]
    return lines


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s)


def safe_filename(s: str, limit: int = 80) -> str:
    s = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", s).strip().rstrip(".")
    return s[:limit] or "untitled"
