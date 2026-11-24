"""Test phần tìm kiếm / chọn nguồn / vá chương (không gọi mạng)."""
import base64

from novel_crawler.finder import (Candidate, check_consistency, gap_fill, has_cjk,
                                  hits_to_candidates, rank)
from novel_crawler.search import Hit, author_from_title, parse_bing, parse_ddg, title_matches
from novel_crawler.sites import site_by_name
from novel_crawler.sites.base import Book, ChapterPage, ChapterRef
from novel_crawler.store import BookStore


def test_title_matches():
    q = "让你演死尸，谁叫你起来破案的？"
    assert title_matches(q, "《让你演死尸，谁叫你起来破案的？》幽铭人生著-17K小说网")
    assert title_matches(q, "让你演死尸，谁叫你起来破案的？内容介绍_作品目录")
    assert title_matches("凡人修仙传", "凡人修仙传 最新章节列表")
    assert title_matches("凡人修仙传", "凡人修仙传-笔趣阁-忘语")
    assert title_matches("凡人修仙传", "凡人修仙傳最新章節")            # phồn thể
    assert not title_matches("凡人修仙传", "凡人修仙之仙界篇无弹窗")
    assert not title_matches("凡人修仙传", "凡人修仙传：从一介散修开始")
    assert not title_matches("凡人修仙传", "我在凡人修仙传里修仙")


def test_author_from_title():
    assert author_from_title("凡人修仙传 (忘语)_凡人修仙传无弹窗") == "忘语"
    assert author_from_title("人道大圣最新章节_(笔趣阁)") == ""


def test_parse_bing_decodes_redirect():
    real = "https://www.69shuba.com/book/1296/"
    enc = base64.urlsafe_b64encode(real.encode()).decode().rstrip("=")
    html = f"""<ol><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=x&amp;u=a1{enc}&amp;ntb=1">
      凡人修仙传最新章节列表-69书吧</a></h2></li></ol>"""
    hits = parse_bing(html)
    assert hits[0].url == real and "凡人修仙传" in hits[0].title


def test_parse_ddg():
    html = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.17k.com%2Fbook%2F1.html&amp;rut=x">书</a>'
    assert parse_ddg(html)[0].url == "https://www.17k.com/book/1.html"


def test_candidates_skip_official_and_keep_known_sites():
    hits = [Hit(f"https://bq{i}.cc/book/{i}/", "x", "bing") for i in range(10)]
    hits += [Hit("https://www.qimao.com/shuku/1/", "x", "bing"),
             Hit("https://www.17k.com/book/5.html", "x", "bing"),
             Hit("https://www.69shuba.com/book/7.htm", "x", "bing"),
             Hit("https://www.69shuba.com/book/7/", "x", "bing")]
    cands = hits_to_candidates(hits)
    names = [c.site.name for c in cands]
    assert names[:2] == ["69shu", "17k"]                 # trang có adapter riêng luôn được giữ
    assert names.count("69shu") == 1                      # /book/7.htm và /book/7/ là một
    assert not any("qimao" in c.url for c in cands)
    assert len(cands) == 8


def _cand(site, titles, locked=(), author="a"):
    s = site_by_name(site)
    chs = [ChapterRef(t, f"https://{site}.x/{i}", i in locked) for i, t in enumerate(titles)]
    c = Candidate(s, f"https://{site}.x/book/1/")
    c.book = Book(site, "1", "书", f"https://{site}.x/book/1/", author, chs)
    return c


def test_rank_consistency_and_author():
    titles = [f"第{i}章 题{i}" for i in range(1, 11)]
    a = _cand("69shu", titles)
    b = _cand("biquge", titles[:8])
    other = _cand("biquge", [f"第{i}章 别的{i}" for i in range(1, 30)])   # sách trùng tên khác
    check_consistency([a, b, other])
    # sách trùng tên dài hơn nhưng lẻ loi → bị loại, nhóm đông nguồn (a, b) được giữ
    assert a.consistent and b.consistent and not other.consistent
    ranked = rank([a, b, other], want_author="")
    assert ranked == [a, b]
    # lọc theo tác giả
    b.book.author = "khác"
    assert rank([a, b], want_author="a") == [a]


def test_has_cjk():
    assert has_cjk("凡人修仙传") and not has_cjk("Phàm Nhân Tu Tiên")


class FakeFetcher:
    def __init__(self, pages):
        self.pages = pages

    def get(self, url, referer=None, quick=False):
        return self.pages[url]


def test_gap_fill(tmp_path, monkeypatch):
    primary = _cand("69shu", ["第1章 甲", "第2章 乙", "第3章 丙"])
    backup = _cand("biquge", ["第1章 甲", "第2章 乙", "第3章 丙"])
    store = BookStore(tmp_path / "book")
    store.write_chapter("第1章 甲.txt", "第1章 甲", ["x"])
    store.write_chapter("第3章 丙.txt", "第3章 丙", ["x"])
    files = {primary.book.chapters[0].url: "第1章 甲.txt", primary.book.chapters[2].url: "第3章 丙.txt"}

    def fake_parse(html, url):
        return ChapterPage("第2章 乙", ["正文" * 150])
    monkeypatch.setattr(backup.site, "parse_chapter", fake_parse)
    fetcher = FakeFetcher({backup.book.chapters[1].url: "<html>"})
    n = gap_fill(fetcher, store, primary.book, files, [backup], log=lambda *a: None)
    assert n == 1
    assert (store.chapters_dir / "第2章 乙.txt").exists()
    assert files[primary.book.chapters[1].url] == "第2章 乙.txt"
