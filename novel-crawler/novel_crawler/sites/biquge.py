"""Biquge (笔趣阁) và các trang raw cùng kiểu.

Biquge không có một tên miền cố định: hàng trăm mirror, đổi tên liên tục. Adapter này
đoán theo bộ selector phổ biến nên dùng được cho hầu hết mirror (và làm adapter dự phòng
cho mọi URL lạ). Mirror nào khác kiểu thì thêm selector vào CATALOG_SEL / CONTENT_SEL.
"""
from __future__ import annotations

import re
from urllib.parse import urlparse

from ..text import html_to_lines, strip_title_line
from .base import Book, ChapterPage, ChapterRef, Site, absolute, dedupe, meta, soup

CATALOG_SEL = [
    "#list dd a", ".listmain dd a", "#list-chapterAll dd a", "#chapterlist li a",
    ".chapterlist li a", "#chapter-list li a", ".section-box ul li a", ".book_list ul li a",
    "#at td a", ".mulu_list li a", "dl.chapterlist dd a",
]
CONTENT_SEL = [
    "#chaptercontent", "#content", "#booktxt", "#chapterContent", "#htmlContent",
    "#nr1", "#novelcontent", "#TextContent", ".readcontent", ".read-content", "div.content",
]
TITLE_SEL = [".bookname h1", ".content h1", "h1.title", ".reader-main h1", "h1"]

# Link "xem thêm / chương mới" lẫn trong mục lục, không phải chương
NOT_CHAPTER = re.compile(r"展开全部|点击查看|全部章节|查看更多|返回|最新章节")


class Biquge(Site):
    name = "biquge"
    domains = ()

    def match(self, url):
        return True    # dự phòng cho mọi tên miền

    def book_id(self, url):
        path = urlparse(url).path
        m = re.search(r"/(?:book|txt|html|read|xs|novel|b)?/?(\d+(?:_\d+)?)/?", path)
        return m.group(1) if m else path.strip("/").replace("/", "_") or "book"

    def catalog_url(self, url):
        # link chương dạng /book/123/456.html → mục lục /book/123/
        p = urlparse(url)
        if re.search(r"/\d+(?:_\d+)?\.html?$", p.path) and p.path.count("/") >= 3:
            return f"{p.scheme}://{p.netloc}{p.path.rsplit('/', 1)[0]}/"
        return url

    def parse_catalog(self, html, url):
        doc = soup(html)
        title = meta(doc, "og:novel:book_name") or meta(doc, "og:title")
        if not title:
            for sel in ("#info h1", ".info h2", ".book h1", "h1"):
                el = doc.select_one(sel)
                if el:
                    title = el.get_text(strip=True)
                    break
        best: list[ChapterRef] = []
        for sel in CATALOG_SEL:
            refs = [ChapterRef(a.get_text(strip=True), absolute(url, a["href"]))
                    for a in doc.select(sel)
                    if a.get("href") and not a["href"].startswith("javascript")
                    and not NOT_CHAPTER.search(a.get_text(strip=True))]
            if len(refs) > len(best):
                best = refs
        best = _drop_latest_block(dedupe(best))
        return Book(self.name, self.book_id(url), title or self.book_id(url), url,
                    author=meta(doc, "og:novel:author"), chapters=best)

    def parse_chapter(self, html, url):
        doc = soup(html)
        title = ""
        for sel in TITLE_SEL:
            el = doc.select_one(sel)
            if el and el.get_text(strip=True):
                title = el.get_text(strip=True)
                break
        box = None
        for sel in CONTENT_SEL:
            el = doc.select_one(sel)
            if el and len(el.get_text(strip=True)) >= 50:
                box = el
                break
        if box is None:
            raise ValueError("Không tìm thấy khối nội dung chương (thêm selector vào CONTENT_SEL)")
        for junk in box.select("script, style, h1, .readinline, .bottem, .bottem2, .chapter-page-btn, a, p.noshow"):
            junk.decompose()
        lines = strip_title_line(html_to_lines(box), title)
        return ChapterPage(title, lines, _next_page(doc, url))


def _drop_latest_block(chapters: list[ChapterRef]) -> list[ChapterRef]:
    """Kiểu cũ: '#list dl' mở đầu bằng ~9 'chương mới nhất' rồi mới tới chương 1. Nếu thấy
    'chương 1' ở vị trí > 0 và trước đó toàn chương số lớn hơn → cắt khối đầu."""
    for i, c in enumerate(chapters[:30]):
        if i and re.match(r"^\s*第\s*[1一]\s*章", c.title):
            return chapters[i:]
    return chapters


def _next_page(doc, url):
    """Chương cắt nhiều trang: link '下一页' trỏ tới xxx_2.html cùng chương."""
    base = urlparse(url).path.rsplit("/", 1)[-1].split(".")[0].split("_")[0]
    for a in doc.find_all("a", href=True):
        if a.get_text(strip=True) in ("下一页", "下一頁", "下页"):
            href = absolute(url, a["href"])
            name = urlparse(href).path.rsplit("/", 1)[-1]
            if base and name.startswith(base + "_"):
                return href
    return None
