"""17K小说网 — HTTP thường. Chỉ tải chương miễn phí (chương VIP có span.vip)."""
from __future__ import annotations

import re

from ..text import clean_lines
from .base import Book, ChapterPage, ChapterRef, Site, absolute, meta, soup


class K17(Site):
    name = "17k"
    domains = ("17k.com",)

    def book_id(self, url):
        m = re.search(r"/(?:book|list|chapter)/(\d+)", url)
        if not m:
            raise ValueError(f"Không nhận ra mã sách 17k trong {url}")
        return m.group(1)

    def catalog_url(self, url):
        return f"https://www.17k.com/list/{self.book_id(url)}.html"

    def parse_catalog(self, html, url):
        doc = soup(html)
        title = (doc.select_one("h1.Title") or doc.select_one("h1"))
        title = title.get_text(strip=True) if title else meta(doc, "og:novel:book_name")
        chapters = []
        for a in doc.select("dl.Volume dd a[href*='/chapter/']"):
            span = a.select_one("span")
            name = (span or a).get_text(" ", strip=True)
            locked = bool(span and "vip" in (span.get("class") or []))
            chapters.append(ChapterRef(name, absolute(url, a["href"]), locked))
        author_a = doc.select_one("a[href*='user.17k.com/see']")
        author = author_a.get_text(strip=True) if author_a else meta(doc, "og:novel:author")
        return Book(self.name, self.book_id(url), title, url, author=author, chapters=chapters)

    def parse_chapter(self, html, url):
        doc = soup(html)
        box = doc.select_one("div.readAreaBox")
        if not box:
            raise ValueError("Không thấy div.readAreaBox")
        h1 = box.select_one("h1")
        # <p> có class (vd p.copy) là lời nhắn bản quyền/quảng cáo, không phải truyện
        paras = [p.get_text() for p in box.select("div.p p") if not p.get("class")]
        lines = clean_lines(paras, junk_patterns=[r"17[Kk]小说网", r"本书首发"])
        return ChapterPage(h1.get_text(strip=True) if h1 else "", lines)
