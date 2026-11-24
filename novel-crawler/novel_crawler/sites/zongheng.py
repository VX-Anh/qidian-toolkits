"""纵横中文网 — HTTP thường. Mục lục ở book.zongheng.com/showchapter/<id>.html,
chương free có sẵn trong HTML (.reader-box .content p). Chương VIP: li.vip → bỏ qua."""
from __future__ import annotations

import re

from ..text import clean_lines
from .base import Book, ChapterPage, ChapterRef, Site, absolute, meta, soup


class Zongheng(Site):
    name = "zongheng"
    domains = ("zongheng.com",)

    def book_id(self, url):
        m = re.search(r"/(?:book|detail|showchapter|chapter)/(\d+)", url)
        if not m:
            raise ValueError(f"Không nhận ra mã sách Zongheng trong {url}")
        return m.group(1)

    def catalog_url(self, url):
        return f"https://book.zongheng.com/showchapter/{self.book_id(url)}.html"

    def parse_catalog(self, html, url):
        doc = soup(html)
        h1 = doc.select_one(".book-meta h1") or doc.select_one("h1")
        title = h1.get_text(strip=True) if h1 else meta(doc, "og:novel:book_name")
        chapters = []
        for li in doc.select("ul.chapter-list li"):
            a = li.select_one("a[href]")
            if not a:
                continue
            locked = "vip" in (li.get("class") or [])
            chapters.append(ChapterRef(a.get_text(strip=True), absolute(url, a["href"]), locked))
        author = ""
        a = doc.select_one(".book-meta a[href*='people']") or doc.select_one(".book-meta p a")
        if a:
            author = a.get_text(strip=True)
        return Book(self.name, self.book_id(url), title, url, author=author, chapters=chapters)

    def parse_chapter(self, html, url):
        doc = soup(html)
        box = doc.select_one(".reader-box")
        if not box:
            raise ValueError("Không thấy .reader-box (chương VIP hoặc trang đổi giao diện?)")
        content = box.select_one(".content")
        if content is not None and content.get("data-decoder"):
            raise ValueError("Chương dùng font mã hoá (data-decoder) — text trong HTML sai chữ")
        title = box.select_one(".title_txtbox")
        paras = [p.get_text() for p in box.select(".content p")]
        return ChapterPage(title.get_text(strip=True) if title else "",
                           clean_lines(paras, junk_patterns=[r"纵横中文网"]))
