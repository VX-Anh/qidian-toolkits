"""Baidu Tieba (百度贴吧) — tải một thread, chỉ lấy bài của chủ thread (只看楼主, see_lz=1).

Tieba có màn "百度安全验证" nên luôn dùng Chrome. Mỗi tầng (楼) của chủ thread thường là
một chương → mỗi tầng thành một "chương" để lưu giống truyện thường.
"""
from __future__ import annotations

import json
import re
from urllib.parse import urlparse

from ..text import html_to_lines
from .base import soup


def thread_id(url: str) -> str:
    m = re.search(r"/p/(\d+)", urlparse(url).path)
    if not m:
        raise ValueError(f"Link Tieba phải dạng https://tieba.baidu.com/p/<số>, nhận được: {url}")
    return m.group(1)


def page_url(tid: str, pn: int, lz_only: bool = True) -> str:
    q = "see_lz=1&" if lz_only else ""
    return f"https://tieba.baidu.com/p/{tid}?{q}pn={pn}"


def parse_page(html: str) -> dict:
    """Trả {title, total_pages, posts: [{floor, author, lines}]}."""
    doc = soup(html)
    title_el = doc.select_one("h3.core_title_txt") or doc.select_one("h1.core_title_txt") or doc.select_one("title")
    title = title_el.get("title") or title_el.get_text(strip=True) if title_el else ""
    title = re.sub(r"_百度贴吧$|【.*?】|_[^_]*吧_百度贴吧$", "", title).strip()

    total = 1
    for li in doc.select("li.l_reply_num"):
        reds = li.select("span.red")
        if len(reds) >= 2 and reds[1].get_text(strip=True).isdigit():
            total = int(reds[1].get_text(strip=True))
    m = re.search(r'"total_page"\s*:\s*(\d+)', html)
    if m:
        total = max(total, int(m.group(1)))

    posts = []
    for div in doc.select("div.l_post"):
        floor, author = None, ""
        try:
            data = json.loads(div.get("data-field") or "{}")
            floor = data.get("content", {}).get("post_no")
            author = data.get("author", {}).get("user_name") or ""
        except (json.JSONDecodeError, AttributeError):
            pass
        body = div.select_one("div.d_post_content")
        if not body:
            continue
        for junk in body.select("img, .BDE_Smiley, script, style"):
            junk.decompose()
        lines = html_to_lines(body)
        if lines:
            posts.append({"floor": floor, "author": author, "lines": lines})
    return {"title": title, "total_pages": total, "posts": posts}
