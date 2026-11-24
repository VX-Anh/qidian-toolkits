"""Tìm link sách theo tên qua công cụ tìm kiếm.

Vì sao không dùng ô tìm kiếm của từng trang (đã dò 24/11/2026):
  - 69shu: ô tìm kiếm bắt giải Cloudflare Turnstile mỗi lần → không tự động được.
  - 17k: trang kết quả bị lớp chống bot (antidom) làm trống.
  - Mirror Biquge: mỗi cái một kiểu, nhiều cái tắt tìm kiếm.
Bing (mở bằng Chrome) trả kết quả ổn định cho cả 4 nguồn, tiêu đề kết quả thường có sẵn
tên sách + tác giả. DuckDuckGo bản HTML làm dự phòng (nhanh nhưng hay chặn sau vài lượt).
"""
from __future__ import annotations

import base64
import html as htmlmod
import re
import unicodedata
from dataclasses import dataclass
from urllib.parse import quote, unquote, urlparse

from bs4 import BeautifulSoup

try:
    from opencc import OpenCC
    _t2s = OpenCC("t2s").convert
except Exception:      # thiếu thư viện thì bỏ qua bước phồn → giản
    def _t2s(s: str) -> str:
        return s


@dataclass
class Hit:
    url: str
    title: str
    engine: str


# Câu truy vấn: (nhãn, mẫu). {q} = tên sách.
# Không dùng toán tử site: — Bing trả kết quả thất thường với nó; kèm tên trang thì ổn định.
QUERIES = [
    ("69shu", "{q} 69书吧"),
    ("biquge", "{q} 笔趣阁"),
    ("17k", "{q} 17k小说网"),
    ("zongheng", "{q} 纵横中文网"),
]

# Sau tên sách trong tiêu đề kết quả, phải là một trong các đuôi này thì mới tính là trùng tên
# (để "凡人修仙传" không khớp "凡人修仙传之仙界篇").
# Không có ":" "：" "·" "之": tên phụ đề kiểu "凡人修仙传：从一介散修开始" là sách khác.
_TAIL = re.compile(
    r"^($|[\s_\-,，|｜()（）【】\[\]《》<>]|最新|无弹窗|全文|小说|txt|TXT|章节|免费|在线|"
    r"全集|目录|列表|全本|完本|下载|阅读|内容|简介|介绍|by|作者)")

_PUNCT = re.compile(r"[\s　·•・,，.。:：;；!！?？'\"“”‘’()（）\[\]【】《》<>〈〉_\-—～~、|｜/]+")


def norm_title(s: str) -> str:
    """So tên: giản thể, bỏ dấu câu/khoảng trắng, chữ thường, full-width → half-width."""
    s = unicodedata.normalize("NFKC", s or "")
    return _PUNCT.sub("", _t2s(s)).lower()


def title_matches(query: str, text: str) -> bool:
    """`text` (tiêu đề kết quả hoặc tên sách) có phải đúng sách `query` không."""
    q = norm_title(query)
    if not q:
        return False
    raw = unicodedata.normalize("NFKC", _t2s(text or ""))
    # Bỏ tiền tố kiểu "《" rồi tìm tên ở đầu chuỗi (sau khi bỏ dấu câu đầu)
    i = 0
    for i, ch in enumerate(raw):
        if not _PUNCT.match(ch):
            break
    rest = raw[i:]
    # Ghép từng ký tự, bỏ dấu câu, đến khi đủ tên
    got, j = "", 0
    while j < len(rest) and len(got) < len(q):
        ch = rest[j]
        if not _PUNCT.match(ch):
            got += ch.lower()
        j += 1
    if got != q:
        return False
    tail = rest[j:]
    # Tên kết thúc bằng dấu câu (vd "...破案的？") → dấu đó thuộc tên, bỏ đi trước khi xét đuôi
    q_end = re.search(r"[^\w]+$", unicodedata.normalize("NFKC", query.strip()))
    if q_end and tail.startswith(q_end.group(0)):
        tail = tail[len(q_end.group(0)):]
    if tail.startswith("》") and raw[:i].endswith("《"):   # 《tên》... → tên đã đóng ngoặc, chắc chắn đúng
        return True
    return bool(_TAIL.match(tail))


def _bing_real_url(href: str) -> str:
    """Link Bing dạng bing.com/ck/a?...&u=a1<base64url> → URL thật."""
    m = re.search(r"[?&]u=a1([^&]+)", href)
    if not m:
        return href
    s = m.group(1)
    s += "=" * (-len(s) % 4)
    try:
        return base64.urlsafe_b64decode(s).decode("utf-8", "replace")
    except ValueError:
        return href


def parse_bing(html: str) -> list[Hit]:
    doc = BeautifulSoup(html, "lxml")
    hits = []
    for li in doc.select("li.b_algo"):
        a = li.select_one("h2 a[href]")
        if not a:
            continue
        hits.append(Hit(_bing_real_url(htmlmod.unescape(a["href"])), a.get_text(" ", strip=True), "bing"))
    return hits


def parse_ddg(html: str) -> list[Hit]:
    doc = BeautifulSoup(html, "lxml")
    hits = []
    for a in doc.select("a.result__a[href]"):
        href = htmlmod.unescape(a["href"])
        m = re.search(r"uddg=([^&]+)", href)
        hits.append(Hit(unquote(m.group(1)) if m else href, a.get_text(" ", strip=True), "ddg"))
    return hits


def bing_url(q: str) -> str:
    # mkt=en-US: thị trường zh-CN của Bing lọc bớt trang raw (thử 24/11/2026 ra 0 kết quả)
    return "https://www.bing.com/search?q=" + quote(q) + "&mkt=en-US&cc=US"


def ddg_url(q: str) -> str:
    return "https://html.duckduckgo.com/html/?q=" + quote(q)


def search_web(fetcher, query: str, log=print) -> list[Hit]:
    """Chạy các câu truy vấn trong QUERIES, trả các kết quả có tiêu đề khớp tên sách."""
    hits: list[Hit] = []
    for label, pattern in QUERIES:
        q = pattern.format(q=query)
        found: list[Hit] = []
        try:
            found = parse_bing(fetcher.get_browser(bing_url(q)))
        except Exception as e:
            log(f"  Bing lỗi ({label}): {e}")
        if not found:
            try:
                found = parse_ddg(fetcher.get_http(ddg_url(q)))
            except Exception as e:
                log(f"  DuckDuckGo lỗi ({label}): {e}")
        ok = [h for h in found if title_matches(query, h.title)]
        log(f"  tìm [{label}] «{q}»: {len(found)} kết quả, {len(ok)} khớp tên")
        hits += ok
    seen, out = set(), []
    for h in hits:
        key = h.url.rstrip("/")
        if key not in seen and urlparse(h.url).scheme in ("http", "https"):
            seen.add(key)
            out.append(h)
    return out


def author_from_title(text: str) -> str:
    """Tiêu đề kiểu '凡人修仙传 (忘语)_...' hoặc '...-笔趣阁-忘语-仙侠小说' → đoán tác giả (có thể rỗng)."""
    m = re.search(r"[（(]([^()（）]{1,12})[)）]", text)
    if m and not re.search(r"笔趣|小说|免费|最新", m.group(1)):
        return m.group(1).strip()
    m = re.search(r"作者[：:]\s*([^\s_,，\-|]{1,12})", text)
    return m.group(1) if m else ""
