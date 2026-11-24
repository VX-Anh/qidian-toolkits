"""`find`: tên truyện → tìm nguồn → chọn nguồn tốt nhất → tải full → vá chỗ thiếu → báo cáo."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from .search import Hit, author_from_title, norm_title, search_web, title_matches
from .sites import site_for
from .sites.base import Book, ChapterRef, Site, absolute, soup
from .store import BookStore, assign_numbers, split_title

CACHE_DIR = Path.home() / ".novel-crawler"
NAME_CACHE = CACHE_DIR / "names.json"
PRIORITY = {"69shu": 3, "biquge": 2, "17k": 1, "zongheng": 1}
MAX_CANDIDATES = 8
# Trang chính thống / app đọc: không có bản raw đọc được bằng adapter Biquge → bỏ khỏi ứng viên
SKIP_DOMAINS = (
    "qidian.com", "qimao.com", "shuqi.com", "qq.com", "iqiyi.com", "fanqienovel.com", "jjwxc.net",
    "zhihu.com", "baidu.com", "douban.com", "bilibili.com", "weibo.com", "sohu.com", "163.com",
    "ciweimao.com", "sfacg.com", "faloo.com", "hongxiu.com", "xxsy.net", "readnovel.com",
    "youdubook.com", "dushu.com", "amazon.com", "amazon.cn", "jd.com", "wikipedia.org", "baike.com",
)
CATALOG_LINK = re.compile(r"全部章节|章节目录|查看目录|完整目录|查看全部|点击阅读|开始阅读|目录")


# ---------------------------------------------------------------- tên Việt → tên Trung

def has_cjk(s: str) -> bool:
    return bool(re.search(r"[一-鿿]", s))


def resolve_name(name: str, log=print) -> list[dict]:
    """Trả danh sách [{zh, author}] ứng viên. Tên Trung → dùng luôn. Tên Việt → hỏi Claude CLI."""
    if has_cjk(name):
        return [{"zh": name.strip(), "author": ""}]
    cache = _load_cache()
    key = name.strip().lower()
    if key in cache:
        log(f"Tên Trung (cache): {', '.join(c['zh'] for c in cache[key])}")
        return cache[key]
    cands = ask_claude_zh_name(name, log)
    if cands:
        cache[key] = cands
        _save_cache(cache)
    return cands


def ask_claude_zh_name(name: str, log=print) -> list[dict]:
    exe = os.environ.get("NOVEL_CRAWLER_CLAUDE_BIN") or shutil.which("claude")
    if not exe:
        raise SystemExit("Tên tiếng Việt cần Claude Code CLI (`claude`) để đổi sang tên Trung — "
                         "cài CLI hoặc dùng --zh \"<tên Trung>\".")
    prompt = (
        "Đây là tên tiếng Việt (convert/dịch) của một truyện mạng Trung Quốc: «" + name + "».\n"
        "Cho biết tên gốc tiếng Trung giản thể và tác giả. Nếu không chắc, liệt kê tối đa 3 khả năng, "
        "khả năng cao nhất trước. Chỉ trả về JSON đúng một dòng, không giải thích:\n"
        '{"candidates":[{"zh":"<tên Trung>","author":"<tác giả hoặc rỗng>"}]}'
    )
    cmd = [exe, "-p", prompt]
    model = os.environ.get("NOVEL_CRAWLER_CLAUDE_MODEL")
    if model:
        cmd += ["--model", model]
    log(f"Hỏi Claude tên Trung của «{name}»...")
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                             timeout=180, stdin=subprocess.DEVNULL).stdout
    except (OSError, subprocess.TimeoutExpired) as e:
        raise SystemExit(f"Gọi Claude CLI lỗi: {e}. Dùng --zh \"<tên Trung>\".")
    m = re.search(r"\{.*\}", out or "", re.S)
    try:
        cands = json.loads(m.group(0))["candidates"] if m else []
    except (json.JSONDecodeError, KeyError, TypeError):
        cands = []
    cands = [{"zh": c.get("zh", "").strip(), "author": (c.get("author") or "").strip()}
             for c in cands if isinstance(c, dict) and has_cjk(c.get("zh", ""))]
    if not cands:
        raise SystemExit(f"Claude không trả được tên Trung (trả về: {out[:200]!r}). Dùng --zh.")
    log("Claude đoán: " + "; ".join(f"{c['zh']} ({c['author'] or '?'})" for c in cands))
    return cands[:3]


def _load_cache() -> dict:
    try:
        return json.loads(NAME_CACHE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_cache(cache: dict):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    NAME_CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")


# ---------------------------------------------------------------- ứng viên

@dataclass
class Candidate:
    site: Site
    url: str                       # link lấy từ kết quả tìm kiếm
    hint_author: str = ""
    book: Book | None = None
    error: str = ""
    consistent: bool = True        # 5 chương đầu khớp với nguồn tham chiếu
    probe_ok: bool | None = None   # tải thử 1 chương

    @property
    def free(self) -> int:
        return sum(not c.locked for c in self.book.chapters) if self.book else 0

    @property
    def key(self) -> str:
        return f"{self.site.name}:{urlparse(self.url).hostname}:{self.site.book_id(self.url)}"

    def label(self) -> str:
        if not self.book:
            return f"[{self.site.name}] {self.url} — lỗi: {self.error}"
        locked = len(self.book.chapters) - self.free
        return (f"[{self.site.name}] {self.book.title} / {self.book.author or '?'} — "
                f"{self.free} chương tải được{f' (+{locked} VIP)' if locked else ''} — {urlparse(self.book.url).hostname}")


def _skip_host(host: str) -> bool:
    return any(host == d or host.endswith("." + d) for d in SKIP_DOMAINS)


def hits_to_candidates(hits: list[Hit]) -> list[Candidate]:
    """Gom kết quả tìm kiếm thành ứng viên (bỏ trùng). Luôn giữ ứng viên của các trang có
    adapter riêng (69shu, 17k, Zongheng), chỗ còn lại cho mirror Biquge theo thứ tự tìm thấy."""
    known, generic, seen = [], [], set()
    for h in hits:
        if _skip_host(urlparse(h.url).hostname or ""):
            continue
        site = site_for(h.url)
        try:
            c = Candidate(site, h.url, author_from_title(h.title))
            key = c.key
        except ValueError:
            continue
        if key in seen:      # 69shu: trang sách /book/1.htm và mục lục /book/1/ là một
            continue
        seen.add(key)
        (generic if site.name == "biquge" else known).append(c)
    known.sort(key=lambda c: -PRIORITY.get(c.site.name, 0))
    return (known + generic)[:max(MAX_CANDIDATES, len(known))]


def load_candidate(fetcher, c: Candidate, query: str, log=print):
    """Đọc mục lục; trang giới thiệu chỉ có vài chương thì đi theo link 'xem mục lục'."""
    try:
        url = c.site.catalog_url(c.url)
        html = fetcher.get(url, quick=True)
        book = c.site.parse_catalog(html, url)
        if c.site.name == "biquge" and len(book.chapters) < 30:
            doc = soup(html)
            for a in doc.find_all("a", href=True):
                if CATALOG_LINK.search(a.get_text(strip=True)):
                    u2 = absolute(url, a["href"])
                    if u2.rstrip("/") != url.rstrip("/") and urlparse(u2).hostname == urlparse(url).hostname:
                        b2 = c.site.parse_catalog(fetcher.get(u2, url, quick=True), u2)
                        if len(b2.chapters) > len(book.chapters):
                            book = b2
                        break
        if not title_matches(query, book.title):
            c.error = f"tên sách trên trang là «{book.title}»"
            return
        if not book.author:
            book.author = c.hint_author
        c.book = book
    except Exception as e:  # mạng, chặn, trang lạ — bỏ ứng viên này
        c.error = (str(e).splitlines() or ["lỗi"])[0][:150]


def chapter_keys(book: Book, n: int = 5) -> list[str]:
    keys = []
    for c in book.chapters[:n * 2]:
        num, rest = split_title(c.title)
        if num is not None:
            keys.append(f"{num}:{norm_title(rest)}")
        if len(keys) >= n:
            break
    return keys


def check_consistency(cands: list[Candidate]):
    """Gom nguồn thành nhóm theo 5 chương đầu (chung ≥ 2 tiêu đề = cùng sách). Nhóm đông nguồn
    nhất (hoà thì nhóm có nguồn ưu tiên/nhiều chương hơn) là sách đúng; nguồn ngoài nhóm bị đánh
    dấu nghi sách khác. Không lấy 'nguồn nhiều chương nhất' làm chuẩn: sách trùng tên dài hơn
    sẽ kéo cả kết quả sai theo. Nguồn ít hơn 3 chương có số thì không xét."""
    ok = [(c, set(chapter_keys(c.book))) for c in cands if c.book]
    ok = [(c, k) for c, k in ok if len(k) >= 3]
    if len(ok) < 2:
        return
    groups: list[list[tuple[Candidate, set]]] = []
    for c, keys in ok:
        for g in groups:
            if any(len(keys & k2) >= 2 for _, k2 in g):
                g.append((c, keys))
                break
        else:
            groups.append([(c, keys)])
    if len(groups) == 1:
        return
    best = max(groups, key=lambda g: (len(g), max(PRIORITY.get(c.site.name, 0) for c, _ in g),
                                      max(c.free for c, _ in g)))
    keep = {id(c) for c, _ in best}
    for c, _ in ok:
        if id(c) not in keep:
            c.consistent = False


def author_ok(c: Candidate, want: str) -> bool:
    return not want or not c.book.author or norm_title(c.book.author) == norm_title(want)


def rank(cands: list[Candidate], want_author: str) -> list[Candidate]:
    good = [c for c in cands if c.book and c.consistent and c.free > 0 and author_ok(c, want_author)]
    return sorted(good, key=lambda c: (c.free, PRIORITY.get(c.site.name, 0)), reverse=True)


def probe(fetcher, c: Candidate) -> bool:
    """Tải thử chương đầu tiên không khoá để chắc trang đọc được."""
    from .cli import fetch_chapter
    first = next((ch for ch in c.book.chapters if not ch.locked), None)
    if not first:
        return False
    try:
        _, lines = fetch_chapter(fetcher, c.site, first.url, c.book.url)
        c.probe_ok = sum(len(x) for x in lines) >= 200
    except Exception as e:
        c.error = f"tải thử lỗi: {str(e)[:100]}"
        c.probe_ok = False
    return c.probe_ok


def ambiguous(ranked: list[Candidate]) -> bool:
    """Các ứng viên có tác giả khác nhau → không chắc là cùng một sách."""
    authors = {norm_title(c.book.author) for c in ranked if c.book.author}
    return len(authors) > 1


# ---------------------------------------------------------------- vá chỗ thiếu + báo cáo

def gap_fill(fetcher, store: BookStore, primary: Book, files: dict[str, str],
             others: list[Candidate], log=print) -> int:
    from .cli import fetch_chapter
    nums = assign_numbers(primary.chapters)
    missing = [(c, n, rest) for c, (n, rest) in zip(primary.chapters, nums)
               if c.url not in files and split_title(c.title)[0] is not None]
    if not missing or not others:
        return 0
    log(f"Vá {len(missing)} chương thiếu từ nguồn phụ...")
    filled = 0
    for o in others:
        by_num: dict[int, ChapterRef] = {}
        for ch in o.book.chapters:
            n, _ = split_title(ch.title)
            if n is not None and not ch.locked:
                by_num.setdefault(n, ch)
        still = []
        for c, n, rest in missing:
            src = by_num.get(split_title(c.title)[0])
            if not src:
                still.append((c, n, rest))
                continue
            try:
                title, lines = fetch_chapter(fetcher, o.site, src.url, o.book.url)
                if sum(len(x) for x in lines) < 200:
                    raise ValueError("quá ngắn")
            except Exception as e:
                log(f"  ✗ {c.title} ({o.site.name}): {str(e)[:80]}")
                still.append((c, n, rest))
                continue
            fname = store.chapter_filename(n, rest)
            store.write_chapter(fname, title or c.title, lines)
            files[c.url] = fname
            filled += 1
            log(f"  ✓ vá {fname} từ {o.site.name}")
        missing = still
        if not missing:
            break
    store.save_meta(primary, files)
    return filled


def write_report(store: BookStore, chosen: Candidate, others: list[Candidate], query: str,
                 limited: bool = False) -> Path:
    meta = store.load()
    chs = meta.get("chapters", [])
    have = [c for c in chs if c.get("file")]
    lines = [f"Truy vấn: {query}", f"Sách: {meta.get('title')} / {meta.get('author') or '?'}",
             f"Nguồn chính: {chosen.site.name} {chosen.book.url}",
             f"Chương: có {len(have)}/{len(chs)} (VIP không tải: {sum(1 for c in chs if c.get('locked'))})"]
    lost = [c["title"] for c in chs if not c.get("file") and not c.get("locked")]
    if limited:
        lines.append(f"Chỉ tải theo --from/--to: còn {len(lost)} chương chưa tải (chạy lại không giới hạn để lấy đủ).")
    elif lost:
        lines.append(f"Không tải được ({len(lost)}): " + "; ".join(lost[:50]) + (" ..." if len(lost) > 50 else ""))
    nums = sorted({n for c in have if (n := split_title(c["title"])[0]) is not None})
    holes = [n for a, b in zip(nums, nums[1:]) for n in range(a + 1, b)] if nums else []
    if holes:
        lines.append(f"Số chương bị nhảy ({len(holes)}): " + ", ".join(map(str, holes[:80])))
    short = []
    for c in have:
        p = store.chapters_dir / c["file"]
        if p.exists() and len(p.read_text(encoding="utf-8")) < 800:
            short.append(c["file"])
    if short:
        lines.append(f"Chương ngắn bất thường (<800 chữ, nên xem lại): {len(short)} — " + "; ".join(short[:20]))
    if others:
        lines.append("Nguồn khác tìm được:")
        lines += ["  " + o.label() + ("" if o.consistent else "  ⚠ 5 chương đầu khác — có thể là sách khác")
                  for o in others]
    path = store.root / "report.txt"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


# ---------------------------------------------------------------- lệnh find

def run_find(args, fetcher, log=print) -> int:
    from .cli import download

    if args.zh:
        names = [{"zh": args.zh, "author": args.author or ""}]
    else:
        names = resolve_name(args.name, log)
    for i, nm in enumerate(names):
        query, want_author = nm["zh"], args.author or nm.get("author", "")
        log(f"\n=== Tìm «{query}»{f' — tác giả {want_author}' if want_author else ''}")
        hits = search_web(fetcher, query, log)
        cands = hits_to_candidates(hits)
        if not cands:
            log("  Không có kết quả khớp tên.")
            continue
        log(f"Đọc mục lục {len(cands)} ứng viên...")
        dead_hosts: set[str] = set()   # tên miền đã kẹt màn kiểm tra / không kết nối được
        for c in cands:
            host = urlparse(c.url).hostname or ""
            if host in dead_hosts:
                c.error = "bỏ qua (tên miền vừa lỗi)"
                continue
            load_candidate(fetcher, c, query, log)
            if c.error and re.search(r"màn kiểm tra|không mở được|thất bại", c.error):
                dead_hosts.add(host)
            log("  " + c.label())
        check_consistency(cands)
        ranked = rank(cands, want_author)
        if not ranked:
            log("  Không ứng viên nào dùng được.")
            continue

        if ambiguous(ranked) and not args.yes and sys.stdin.isatty():
            log("\nCác nguồn có tác giả khác nhau — chọn sách đúng:")
            for k, c in enumerate(ranked, 1):
                log(f"  {k}. {c.label()}")
            pick = input("Số (Enter = 1, 0 = bỏ): ").strip() or "1"
            if pick == "0":
                continue
            chosen_author = ranked[int(pick) - 1].book.author
            ranked = [c for c in ranked if not c.book.author or norm_title(c.book.author) == norm_title(chosen_author)]

        chosen = None
        for c in ranked:
            log(f"Tải thử 1 chương từ {c.site.name} ({urlparse(c.book.url).hostname})...")
            if probe(fetcher, c):
                chosen = c
                break
            log(f"  ✗ {c.error or 'nội dung quá ngắn'} → thử nguồn kế")
        if not chosen:
            log("  Không nguồn nào tải được chương.")
            continue
        others = [c for c in ranked if c is not chosen and c.probe_ok is not False]
        log(f"\n→ Chọn: {chosen.label()}")
        if args.dry_run:
            return 0

        rc = download(fetcher, chosen.site, chosen.book, args.out, args.start, args.end)
        store = BookStore.for_book(args.out, chosen.book)
        files = {c["url"]: c["file"] for c in store.load().get("chapters", []) if c.get("file")}
        if args.start is None and args.end is None:
            if gap_fill(fetcher, store, chosen.book, files, others, log):
                rc = 0 if all(c.url in files for c in chosen.book.chapters if not c.locked) else rc
        merged = store.merge()
        report = write_report(store, chosen, [c for c in cands if c is not chosen], query,
                              limited=args.start is not None or args.end is not None)
        log(f"\nFile gộp: {merged}\nBáo cáo: {report}")
        log(report.read_text(encoding="utf-8"))
        return rc
    log("Không tìm được sách." + ("" if args.zh else " Thử --zh \"<tên Trung>\" nếu tên Trung đoán sai."))
    return 1
