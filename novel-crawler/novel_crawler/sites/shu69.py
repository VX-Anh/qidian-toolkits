"""69书吧 (69shuba) — có Cloudflare nên mặc định dùng Chrome.

Link thường gặp:
  sách     https://www.69shuba.com/book/<id>.htm
  mục lục  https://www.69shuba.com/book/<id>/
  chương   https://www.69shuba.com/txt/<id>/<chapter_id>
"""
from __future__ import annotations

import re
from urllib.parse import urlparse

from ..text import html_to_lines, strip_title_line
from .base import Book, ChapterPage, ChapterRef, Site, absolute, dedupe, meta, soup

_IDX = re.compile(r"^\s*\d+\s*[.、]\s*(?=第)")   # "12.第12章 xx" → "第12章 xx"


def _clean_title(t: str) -> str:
    return _IDX.sub("", t).strip()


class Shu69(Site):
    name = "69shu"
    domains = ("69shuba.com", "69shuba.cx", "69shu.com", "69shu.me", "69shuba.pro", "69shu.pro",
               "69xinshu.com", "69shux.com")
    needs_browser = True

    def book_id(self, url):
        m = re.search(r"/(?:book|txt)/(\d+)", url)
        if not m:
            raise ValueError(f"Không nhận ra mã sách 69shu trong {url}")
        return m.group(1)

    def catalog_url(self, url):
        p = urlparse(url)
        return f"{p.scheme}://{p.netloc}/book/{self.book_id(url)}/"

    def parse_catalog(self, html, url):
        doc = soup(html)
        title = meta(doc, "og:novel:book_name")
        if not title:
            el = doc.select_one(".bread a:last-of-type") or doc.select_one("h1")
            title = el.get_text(strip=True) if el else self.book_id(url)
        title = re.sub(r"(最新)?章节(列表|目录)$|全文阅读$", "", title).strip()
        items = doc.select("#catalog ul li") or doc.select(".catalog ul li") or doc.select(".mu_contain ul li")
        rows = []
        for i, li in enumerate(items):
            a = li.select_one("a[href]")
            if not a:
                continue
            try:
                num = int(li.get("data-num", ""))
            except ValueError:
                num = i
            rows.append((num, ChapterRef(_clean_title(a.get_text(strip=True)), absolute(url, a["href"]))))
        rows.sort(key=lambda r: r[0])   # có bản mục lục xếp mới nhất lên đầu
        author = meta(doc, "og:novel:author")
        if not author:   # mục lục 69shu để tác giả trong script: bookinfo = {... author:'忘语' ...}
            m = re.search(r"author\s*:\s*['\"]([^'\"]{1,30})['\"]", html)
            author = m.group(1).strip() if m else ""
        return Book(self.name, self.book_id(url), title, url,
                    author=author, chapters=dedupe([r[1] for r in rows]))

    def parse_chapter(self, html, url):
        doc = soup(html)
        box = doc.select_one("div.txtnav") or doc.select_one(".mybox .txtnav") or doc.select_one("#txtcontent")
        if not box:
            raise ValueError("Không thấy div.txtnav")
        h1 = box.select_one("h1")
        title = _clean_title(h1.get_text(strip=True)) if h1 else ""
        for junk in box.select("h1, .txtinfo, #txtright, .bottom-ad, .contentadv, script, style, .baocuo, a"):
            junk.decompose()
        lines = strip_title_line(html_to_lines(box), title)
        return ChapterPage(title, lines)
