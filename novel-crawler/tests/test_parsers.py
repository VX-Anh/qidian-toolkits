"""Test parser bằng HTML tự viết (mô phỏng cấu trúc trang thật, không chứa nội dung truyện)."""
from novel_crawler.fetch import decode_html, looks_blocked
from novel_crawler.sites import site_for
from novel_crawler.sites.biquge import Biquge
from novel_crawler.sites.k17 import K17
from novel_crawler.sites.shu69 import Shu69
from novel_crawler.sites.tieba import parse_page, thread_id
from novel_crawler.sites.zongheng import Zongheng
from novel_crawler.sites.base import ChapterRef
from novel_crawler.store import assign_numbers, cn_to_int, split_title


def test_site_detection():
    assert site_for("https://www.17k.com/book/1.html").name == "17k"
    assert site_for("https://read.zongheng.com/chapter/1/2.html").name == "zongheng"
    assert site_for("https://www.69shuba.com/txt/5/6").name == "69shu"
    assert site_for("https://www.bqg999.cc/book/1/").name == "biquge"


def test_catalog_urls():
    assert K17().catalog_url("https://www.17k.com/chapter/36/49.html") == "https://www.17k.com/list/36.html"
    assert Zongheng().catalog_url("https://www.zongheng.com/detail/14") == "https://book.zongheng.com/showchapter/14.html"
    assert Shu69().catalog_url("https://www.69shuba.com/book/58831.htm") == "https://www.69shuba.com/book/58831/"
    assert Biquge().catalog_url("https://www.x.cc/book/6909/12.html") == "https://www.x.cc/book/6909/"


def test_cn_numbers():
    assert cn_to_int("十二") == 12
    assert cn_to_int("一百零五") == 105
    assert cn_to_int("两千三百") == 2300
    assert cn_to_int("１２") == 12
    assert split_title("第十二章 风起") == (12, "风起")
    assert split_title("序章 开端") == (None, "序章 开端")


def test_assign_numbers_monotonic():
    refs = [ChapterRef(t, f"u{i}") for i, t in enumerate(
        ["序章 开端", "第1章 甲", "第2章 乙", "感言", "第3章 丙", "第1章 新卷"])]
    got = assign_numbers(refs)
    assert [n for n, _ in got] == [0, 1, 2, 2, 3, 4]
    assert got[3] == (2, "感言") and got[5] == (4, "第1章 新卷")
    assert len(set(got)) == len(got)


def test_17k():
    html = """<h1 class="Title">书名</h1><dl class="Volume"><dd>
      <a href="/chapter/9/1.html"><span class="ellipsis ">第1章 开始</span></a>
      <a href="/chapter/9/2.html"><span class="ellipsis vip">第2章 收费</span></a></dd></dl>"""
    book = K17().parse_catalog(html, "https://www.17k.com/list/9.html")
    assert book.title == "书名"
    assert [c.locked for c in book.chapters] == [False, True]
    assert book.chapters[0].url == "https://www.17k.com/chapter/9/1.html"
    ch = K17().parse_chapter("""<div class="readAreaBox content"><h1>第1章 开始</h1>
      <div class="p"><p>第一段。</p><p>　　第二段。</p><p class="copy">本书首发来自17K小说网</p></div></div>""", "")
    assert ch.title == "第1章 开始" and ch.lines == ["第一段。", "第二段。"]


def test_zongheng():
    html = """<div class="book-meta"><h1>书</h1></div><ul class="chapter-list">
      <li class=" col-4"><a href="https://book.zongheng.com/chapter/1/2.html">第1章 甲</a></li>
      <li class="vip col-4"><a href="https://book.zongheng.com/chapter/1/3.html">第2章 乙</a></li></ul>"""
    book = Zongheng().parse_catalog(html, "https://book.zongheng.com/showchapter/1.html")
    assert [c.locked for c in book.chapters] == [False, True]
    ch = Zongheng().parse_chapter("""<div class="reader-box"><div class="title_txtbox">第1章 甲</div>
      <div class="content" data-decoder=""><p>一。</p><p>二。</p></div></div>""", "")
    assert ch.lines == ["一。", "二。"]


def test_69shu_order_and_clean():
    html = """<div id="catalog"><ul>
      <li data-num="2"><a href="https://www.69shuba.com/txt/5/12">2.第2章 乙</a></li>
      <li data-num="1"><a href="https://www.69shuba.com/txt/5/11">1.第1章 甲</a></li></ul></div>
      <h1>书名章节列表</h1>"""
    book = Shu69().parse_catalog(html, "https://www.69shuba.com/book/5/")
    assert book.title == "书名"
    assert [c.title for c in book.chapters] == ["第1章 甲", "第2章 乙"]
    ch = Shu69().parse_chapter("""<div class="txtnav"><h1 class="hide720">1.第1章 甲</h1>
      <div class="txtinfo">作者</div><div id="txtright"></div>
      &emsp;&emsp;第1章 甲<br>&emsp;&emsp;正文一。<br><br>&emsp;&emsp;正文二。<br>(本章完)</div>""", "")
    assert ch.title == "第1章 甲"
    assert ch.lines[:2] == ["正文一。", "正文二。"]


def test_biquge_latest_block_and_pages():
    dd = "".join(f'<dd><a href="/book/7/{n}.html">第{n}章 x</a></dd>' for n in (99, 98))
    dd += "".join(f'<dd><a href="/book/7/{n}.html">第{n}章 x</a></dd>' for n in range(1, 4))
    book = Biquge().parse_catalog(f'<div id="list"><dl>{dd}</dl></div>', "https://b.cc/book/7/")
    assert [c.url.rsplit("/", 1)[1] for c in book.chapters] == ["1.html", "2.html", "3.html"]
    ch = Biquge().parse_chapter("""<div class="bookname"><h1>第1章 x</h1></div>
      <div id="content">　　正文足够长的一段文字用于测试内容提取是否正常工作。<br>
      　　请收藏本站：https://www.b.cc<br>　　第二段也要足够长才能通过最小长度检测这一关。</div>
      <a href="/book/7/1_2.html">下一页</a>""", "https://b.cc/book/7/1.html")
    assert len(ch.lines) == 2 and "收藏" not in "".join(ch.lines)
    assert ch.next_page == "https://b.cc/book/7/1_2.html"


def test_tieba():
    assert thread_id("https://tieba.baidu.com/p/123456?see_lz=1") == "123456"
    html = """<title>标题_xx吧_百度贴吧</title><h3 class="core_title_txt" title="第一章 起">第一章 起</h3>
      <li class="l_reply_num"><span class="red">10</span><span class="red">3</span></li>
      <div class="l_post" data-field='{"author":{"user_name":"lz"},"content":{"post_no":2}}'>
        <div class="d_post_content j_d_post_content">正文一<br>正文二<img src="x"></div></div>"""
    data = parse_page(html)
    assert data["total_pages"] == 3
    assert data["posts"][0] == {"floor": 2, "author": "lz", "lines": ["正文一", "正文二"]}


def test_encoding_and_block():
    assert decode_html("中文".encode("gbk") + b'<meta charset="gbk">') .startswith("中文")
    assert looks_blocked("<html><head><title>Just a moment...</title>")
    assert not looks_blocked("<html><head><title>第1章</title>")
