from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup


@dataclass
class ChapterRef:
    title: str
    url: str
    locked: bool = False       # chương VIP/trả phí — tool không tải


@dataclass
class Book:
    site: str
    book_id: str
    title: str
    url: str                   # trang mục lục
    author: str = ""
    chapters: list[ChapterRef] = field(default_factory=list)


@dataclass
class ChapterPage:
    title: str
    lines: list[str]
    next_page: str | None = None   # chương bị cắt thành nhiều trang (xxx_2.html)


class Site:
    name = ""
    domains: tuple[str, ...] = ()
    needs_browser = False          # True: HTTP thường bị chặn, mặc định dùng Chrome

    def match(self, url: str) -> bool:
        host = urlparse(url).hostname or ""
        return any(host == d or host.endswith("." + d) for d in self.domains)

    def catalog_url(self, url: str) -> str:
        """Nhận link sách / mục lục / chương → trả link mục lục."""
        return url

    def book_id(self, url: str) -> str:
        m = re.search(r"/(\d+)", urlparse(url).path)
        return m.group(1) if m else urlparse(url).path.strip("/").replace("/", "_")

    def parse_catalog(self, html: str, url: str) -> Book:
        raise NotImplementedError

    def parse_chapter(self, html: str, url: str) -> ChapterPage:
        raise NotImplementedError


def soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "lxml")


def meta(doc: BeautifulSoup, prop: str) -> str:
    el = doc.find("meta", attrs={"property": prop}) or doc.find("meta", attrs={"name": prop})
    return (el.get("content") or "").strip() if el else ""


def absolute(base: str, href: str) -> str:
    return urljoin(base, href.strip())


def dedupe(chapters: list[ChapterRef]) -> list[ChapterRef]:
    """Nhiều trang Biquge/69shu đặt khối 'chương mới nhất' trước mục lục đầy đủ → bỏ trùng URL."""
    seen, out = set(), []
    for c in chapters:
        if c.url in seen:
            continue
        seen.add(c.url)
        out.append(c)
    return out
