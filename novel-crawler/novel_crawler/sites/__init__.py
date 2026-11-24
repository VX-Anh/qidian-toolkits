from .base import Book, ChapterPage, ChapterRef, Site
from .biquge import Biquge
from .k17 import K17
from .shu69 import Shu69
from .zongheng import Zongheng

# Biquge phải đứng cuối: nó nhận mọi URL.
SITES: list[Site] = [K17(), Zongheng(), Shu69(), Biquge()]


def site_for(url: str) -> Site:
    for s in SITES:
        if s.match(url):
            return s
    raise ValueError(url)


def site_by_name(name: str) -> Site:
    for s in SITES:
        if s.name == name:
            return s
    raise ValueError(f"Không có adapter '{name}'")


__all__ = ["Book", "ChapterPage", "ChapterRef", "Site", "SITES", "site_for", "site_by_name"]
