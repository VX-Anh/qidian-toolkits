"""Dòng lệnh novel-crawler.

  get <link sách/mục lục/chương>   tải truyện (chạy lại = tải tiếp phần còn thiếu)
  update [thư mục ...]              tải chương mới cho sách đã tải (mặc định: mọi sách trong --out)
  info <link>                       xem tên sách, số chương, số chương khoá
  merge <thư mục sách>              gộp các chương thành 1 file .txt
  tieba <link thread>               tải thread Tieba (chỉ bài chủ thread)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .fetch import DEFAULT_PROFILE, BrowserFetcher, FetchError, HttpFetcher
from .sites import site_by_name, site_for
from .sites import tieba as tieba_site
from .store import BookStore, assign_numbers
from .text import safe_filename

DEFAULT_OUT = Path("downloads")
MAX_PAGES_PER_CHAPTER = 20


class Fetcher:
    """mode: auto (HTTP trước, bị chặn thì chuyển sang Chrome và giữ luôn), http, browser."""

    def __init__(self, args, prefer_browser: bool = False):
        self.args = args
        self.mode = args.mode
        if self.mode == "auto" and prefer_browser:
            self.mode = "browser"
        self._http = None
        self._browser = None

    def _get_browser(self):
        if self._browser is None:
            print("Mở Chrome (profile riêng của tool)...", flush=True)
            self._browser = BrowserFetcher(delay=self.args.delay, profile_dir=self.args.profile,
                                           headless=self.args.headless, channel=self.args.channel)
        return self._browser

    def get(self, url: str, referer: str | None = None) -> str:
        if self.mode == "browser":
            return self._get_browser().get(url, referer)
        if self._http is None:
            self._http = HttpFetcher(delay=self.args.delay)
        try:
            return self._http.get(url, referer)
        except FetchError as e:
            if self.mode == "auto" and "--browser" in str(e):
                print("  HTTP thường bị chặn → chuyển sang Chrome.", flush=True)
                self.mode = "browser"
                return self._get_browser().get(url, referer)
            raise

    def close(self):
        for f in (self._http, self._browser):
            if f:
                try:
                    f.close()
                except Exception:
                    pass


# ---------------------------------------------------------------- sách

def load_book(fetcher: Fetcher, site, url: str):
    cat = site.catalog_url(url)
    print(f"[{site.name}] Đọc mục lục {cat}", flush=True)
    book = site.parse_catalog(fetcher.get(cat), cat)
    if not book.chapters:
        raise SystemExit("Không thấy chương nào trong mục lục — trang đổi giao diện hoặc link sai.")
    return book


def fetch_chapter(fetcher: Fetcher, site, url: str, referer: str):
    page = site.parse_chapter(fetcher.get(url, referer), url)
    title, lines, seen = page.title, list(page.lines), {url}
    nxt = page.next_page
    while nxt and nxt not in seen and len(seen) < MAX_PAGES_PER_CHAPTER:
        seen.add(nxt)
        more = site.parse_chapter(fetcher.get(nxt, url), nxt)
        lines += more.lines
        nxt = more.next_page
    return title, lines


def download(fetcher: Fetcher, site, book, out_dir: Path, start: int | None, end: int | None,
             retry_failed: bool = True) -> int:
    store = BookStore.for_book(out_dir, book)
    old = {c["url"]: c.get("file") for c in store.load().get("chapters", [])}
    files: dict[str, str] = {u: f for u, f in old.items()
                             if f and (store.chapters_dir / f).exists()}
    numbers = assign_numbers(book.chapters)
    locked = sum(c.locked for c in book.chapters)
    todo = [(c, n, rest) for c, (n, rest) in zip(book.chapters, numbers)
            if not c.locked and c.url not in files
            and (start is None or n >= start) and (end is None or n <= end)]

    print(f"《{book.title}》 {book.author or ''} — {len(book.chapters)} chương"
          f"{f', {locked} chương VIP (bỏ qua)' if locked else ''}; đã có {len(files)}; cần tải {len(todo)}")
    print(f"Lưu vào: {store.root}", flush=True)
    store.save_meta(book, files)

    ok = fail = 0
    try:
        for i, (c, n, rest) in enumerate(todo, 1):
            try:
                title, lines = fetch_chapter(fetcher, site, c.url, book.url)
                if sum(len(x) for x in lines) < 30:
                    raise ValueError("nội dung quá ngắn (chương khoá / trang lỗi?)")
            except (FetchError, ValueError) as e:
                fail += 1
                print(f"  ✗ [{i}/{len(todo)}] {c.title}: {e}", flush=True)
                if fail >= 5 and ok == 0:
                    print("5 chương đầu đều lỗi — dừng. Kiểm tra link / thử --browser.")
                    break
                continue
            fname = old.get(c.url) or store.chapter_filename(n, rest)
            store.write_chapter(fname, title or c.title, lines)
            files[c.url] = fname
            ok += 1
            print(f"  ✓ [{i}/{len(todo)}] {fname}  ({sum(len(x) for x in lines)} chữ)", flush=True)
            if ok % 10 == 0:
                store.save_meta(book, files)
    except KeyboardInterrupt:
        print("\nDừng theo yêu cầu — đã lưu tiến độ, chạy lại lệnh để tải tiếp.")
    finally:
        store.save_meta(book, files)
    print(f"Xong: tải {ok}, lỗi {fail}. Thư mục chương: {store.chapters_dir}")
    return 0 if fail == 0 else 1


def cmd_get(args):
    site = site_by_name(args.site) if args.site else site_for(args.url)
    fetcher = Fetcher(args, prefer_browser=site.needs_browser)
    try:
        book = load_book(fetcher, site, args.url)
        rc = download(fetcher, site, book, args.out, args.start, args.end)
        if args.merge:
            print("Gộp:", BookStore.for_book(args.out, book).merge())
        return rc
    finally:
        fetcher.close()


def cmd_update(args):
    dirs = [Path(d) for d in args.dirs] or sorted(p.parent for p in args.out.glob("*/book.json"))
    if not dirs:
        raise SystemExit(f"Không có sách nào trong {args.out}")
    rc = 0
    fetchers: dict[bool, Fetcher] = {}
    try:
        for d in dirs:
            meta = json.loads((d / "book.json").read_text(encoding="utf-8"))
            site = site_by_name(meta["site"])
            f = fetchers.setdefault(site.needs_browser, Fetcher(args, prefer_browser=site.needs_browser))
            print(f"\n=== {meta['title']}")
            try:
                book = load_book(f, site, meta["catalog_url"])
                rc |= download(f, site, book, d.parent, None, None)
            except (FetchError, SystemExit) as e:
                print(f"  Bỏ qua: {e}")
                rc = 1
    finally:
        for f in fetchers.values():
            f.close()
    return rc


def cmd_info(args):
    site = site_by_name(args.site) if args.site else site_for(args.url)
    fetcher = Fetcher(args, prefer_browser=site.needs_browser)
    try:
        book = load_book(fetcher, site, args.url)
    finally:
        fetcher.close()
    nums = assign_numbers(book.chapters)
    print(f"Sách: {book.title}\nTác giả: {book.author}\nMục lục: {book.url}")
    print(f"Chương: {len(book.chapters)} (khoá VIP: {sum(c.locked for c in book.chapters)})")
    show = book.chapters if args.all else book.chapters[:5] + book.chapters[-5:]
    for c, (n, _) in zip(book.chapters, nums):
        if c in show:
            print(f"  {n:>5} {'🔒' if c.locked else '  '} {c.title}  {c.url}")
    return 0


def cmd_merge(args):
    print("Đã gộp:", BookStore(Path(args.dir)).merge(Path(args.output) if args.output else None))
    return 0


def cmd_tieba(args):
    tid = tieba_site.thread_id(args.url)
    fetcher = Fetcher(args, prefer_browser=True)
    posts, title, pn, total = [], "", 1, 1
    try:
        while pn <= total and (args.max_pages is None or pn <= args.max_pages):
            url = tieba_site.page_url(tid, pn, lz_only=not args.all_users)
            data = tieba_site.parse_page(fetcher.get(url))
            title = title or data["title"]
            total = data["total_pages"]
            posts += data["posts"]
            print(f"  trang {pn}/{total}: {len(data['posts'])} tầng", flush=True)
            pn += 1
    except KeyboardInterrupt:
        print("\nDừng — lưu phần đã tải.")
    finally:
        fetcher.close()
    if not posts:
        raise SystemExit("Không lấy được tầng nào (thread bị xoá / cần đăng nhập Baidu trong cửa sổ Chrome?).")
    root = args.out / safe_filename(f"tieba_{tid} {title}")
    root.mkdir(parents=True, exist_ok=True)
    min_len = args.min_chars
    kept = [p for p in posts if sum(len(x) for x in p["lines"]) >= min_len]
    whole = root / (safe_filename(title or tid) + ".txt")
    with whole.open("w", encoding="utf-8") as f:
        f.write(title + "\n\n")
        for p in kept:
            f.write(f"#{p['floor'] or '?'}楼 {p['author']}\n\n" + "\n\n".join(p["lines"]) + "\n\n")
    if args.split:
        cdir = root / "chapters"
        cdir.mkdir(exist_ok=True)
        for i, p in enumerate(kept, 1):
            head = p["lines"][0][:40]
            (cdir / (safe_filename(f"第{i}章 {head}", 100) + ".txt")).write_text(
                "\n\n".join(p["lines"]) + "\n", encoding="utf-8")
    print(f"Xong: {len(kept)}/{len(posts)} tầng (≥{min_len} chữ) → {whole}")
    return 0


# ---------------------------------------------------------------- main

def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--out", type=Path, default=DEFAULT_OUT, help="thư mục lưu (mặc định ./downloads)")
    common.add_argument("--delay", type=float, default=1.2, help="giây nghỉ giữa 2 request (mặc định 1.2)")
    g = common.add_mutually_exclusive_group()
    g.add_argument("--browser", dest="mode", action="store_const", const="browser",
                   help="luôn dùng Chrome")
    g.add_argument("--http", dest="mode", action="store_const", const="http",
                   help="chỉ dùng HTTP thường, không mở Chrome")
    common.set_defaults(mode="auto")
    common.add_argument("--headless", action="store_true", help="Chrome chạy ẩn (không bấm được màn kiểm tra)")
    common.add_argument("--profile", type=Path, default=DEFAULT_PROFILE, help="thư mục profile Chrome của tool")
    common.add_argument("--channel", default="chrome", help="chrome (mặc định), msedge, hoặc chromium")

    ap = argparse.ArgumentParser(prog="novel-crawler", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("get", parents=[common], help="tải truyện")
    p.add_argument("url")
    p.add_argument("--from", dest="start", type=int, help="từ chương số")
    p.add_argument("--to", dest="end", type=int, help="đến chương số")
    p.add_argument("--site", help="ép adapter: 17k, zongheng, 69shu, biquge")
    p.add_argument("--merge", action="store_true", help="tải xong gộp thành 1 file .txt")
    p.set_defaults(func=cmd_get)

    p = sub.add_parser("update", parents=[common], help="tải chương mới cho sách đã tải")
    p.add_argument("dirs", nargs="*")
    p.set_defaults(func=cmd_update)

    p = sub.add_parser("info", parents=[common], help="xem thông tin sách")
    p.add_argument("url")
    p.add_argument("--site")
    p.add_argument("--all", action="store_true", help="liệt kê mọi chương")
    p.set_defaults(func=cmd_info)

    p = sub.add_parser("merge", help="gộp chương thành 1 file")
    p.add_argument("dir")
    p.add_argument("-o", "--output")
    p.set_defaults(func=cmd_merge)

    p = sub.add_parser("tieba", parents=[common], help="tải thread Tieba")
    p.add_argument("url")
    p.add_argument("--all-users", action="store_true", help="lấy cả bài người khác (mặc định chỉ chủ thread)")
    p.add_argument("--split", action="store_true", help="mỗi tầng thành 1 file chương")
    p.add_argument("--min-chars", type=int, default=200, help="bỏ tầng ngắn hơn (mặc định 200 chữ)")
    p.add_argument("--max-pages", type=int)
    p.set_defaults(func=cmd_tieba)
    return ap


def main():
    for s in (sys.stdout, sys.stderr):
        if s.encoding and s.encoding.lower() != "utf-8":
            s.reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args()
    try:
        sys.exit(args.func(args))
    except FetchError as e:
        sys.exit(f"Lỗi: {e}")
