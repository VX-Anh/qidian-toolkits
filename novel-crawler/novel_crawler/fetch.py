"""Hai cách tải trang: HTTP thường (nhanh) và Chrome thật (cho trang có màn kiểm tra).

Chế độ Chrome dùng một profile RIÊNG của tool (không đụng profile Chrome hằng ngày).
Gặp màn kiểm tra (Cloudflare "Just a moment", "百度安全验证"...) thì tool chờ người dùng
tự hoàn tất trong cửa sổ Chrome; cookie được giữ trong profile cho các lần sau.
"""
from __future__ import annotations

import random
import re
import time
from pathlib import Path

import httpx

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0 Safari/537.36")

# Tiêu đề / dấu hiệu của trang chặn, chưa phải nội dung thật.
CHALLENGE_MARKERS = [
    "Just a moment", "请稍候", "Attention Required", "百度安全验证",
    "加载中……", "Checking your browser", "安全验证",
]

DEFAULT_PROFILE = Path.home() / ".novel-crawler" / "chrome-profile"


class FetchError(RuntimeError):
    pass


def decode_html(content: bytes, header_charset: str | None = None) -> str:
    """Đoán bảng mã: header → thẻ meta → utf-8 → gb18030."""
    cands = []
    if header_charset:
        cands.append(header_charset)
    m = re.search(rb'charset=["\']?([\w-]+)', content[:4096], re.I)
    if m:
        cands.append(m.group(1).decode("ascii", "ignore"))
    cands += ["utf-8", "gb18030"]
    for enc in cands:
        enc = enc.lower()
        if enc in ("gbk", "gb2312"):
            enc = "gb18030"   # gb18030 là tập cha, đỡ lỗi chữ hiếm
        try:
            return content.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
    return content.decode("utf-8", "replace")


def looks_blocked(html: str) -> bool:
    head = html[:3000]
    m = re.search(r"<title>(.*?)</title>", head, re.S | re.I)
    title = m.group(1) if m else ""
    return any(k in title for k in CHALLENGE_MARKERS) or "cf-challenge" in head or "/cdn-cgi/challenge-platform" in head


class Throttle:
    """Giãn cách giữa các request để không dội trang nguồn."""

    def __init__(self, delay: float):
        self.delay = delay
        self._last = 0.0

    def wait(self):
        if self.delay <= 0:
            return
        gap = self.delay * random.uniform(0.7, 1.3)
        sleep = self._last + gap - time.monotonic()
        if sleep > 0:
            time.sleep(sleep)
        self._last = time.monotonic()


class HttpFetcher:
    def __init__(self, delay: float = 1.0, retries: int = 3, timeout: float = 30):
        self.throttle = Throttle(delay)
        self.retries = retries
        self.client = httpx.Client(
            headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"},
            follow_redirects=True, timeout=timeout,
        )

    def get(self, url: str, referer: str | None = None) -> str:
        err = None
        for attempt in range(1, self.retries + 1):
            self.throttle.wait()
            try:
                r = self.client.get(url, headers={"Referer": referer} if referer else None)
            except httpx.HTTPError as e:
                err = e
            else:
                html = decode_html(r.content, r.charset_encoding)
                if looks_blocked(html) or r.status_code == 403:
                    raise FetchError(f"Trang chặn HTTP thường ({url}) — chạy lại với --browser")
                if r.status_code in (429, 500, 502, 503, 504):
                    err = f"HTTP {r.status_code}"
                elif r.status_code >= 400:
                    raise FetchError(f"HTTP {r.status_code} khi tải {url}")
                else:
                    return html
            time.sleep(2 * attempt)
        raise FetchError(f"Tải thất bại sau {self.retries} lần: {url} ({err})")

    def close(self):
        self.client.close()


class BrowserFetcher:
    def __init__(self, delay: float = 1.5, profile_dir: Path = DEFAULT_PROFILE,
                 headless: bool = False, challenge_wait: float = 180, channel: str = "chrome"):
        from playwright.sync_api import sync_playwright

        self.throttle = Throttle(delay)
        self.challenge_wait = challenge_wait
        profile_dir.mkdir(parents=True, exist_ok=True)
        self._pw = sync_playwright().start()
        try:
            self.ctx = self._pw.chromium.launch_persistent_context(
                user_data_dir=str(profile_dir),
                channel=channel or None,
                headless=headless,
                locale="zh-CN",
                viewport={"width": 1200, "height": 860},
            )
        except Exception as e:
            self._pw.stop()
            raise FetchError(
                f"Không mở được Chrome ({e}). Cài Chrome, hoặc chạy "
                "`uv run playwright install chromium` rồi thêm --channel chromium") from None
        self.page = self.ctx.pages[0] if self.ctx.pages else self.ctx.new_page()

    def get(self, url: str, referer: str | None = None) -> str:
        self.throttle.wait()
        last = None
        for attempt in range(1, 4):
            try:
                self.page.goto(url, wait_until="domcontentloaded", timeout=45_000, referer=referer)
                break
            except Exception as e:  # timeout / lỗi mạng
                last = e
                time.sleep(2 * attempt)
        else:
            raise FetchError(f"Chrome không mở được {url}: {last}")
        return self._wait_real_content(url)

    def _wait_real_content(self, url: str) -> str:
        deadline = time.monotonic() + self.challenge_wait
        warned = False
        while True:
            try:
                html = self.page.content()
            except Exception:   # trang đang chuyển hướng
                html = ""
            if html and not looks_blocked(html):
                # Nhiều mirror nạp nội dung chương bằng AJAX sau khi trang mở → chờ mạng rảnh
                try:
                    self.page.wait_for_load_state("networkidle", timeout=10_000)
                    html = self.page.content()
                except Exception:
                    pass
                if not looks_blocked(html):
                    return html
            if time.monotonic() > deadline:
                raise FetchError(f"Hết {self.challenge_wait:.0f}s mà vẫn kẹt ở màn kiểm tra: {url}")
            if not warned and html:
                print("  ⚠ Trang đang hiện màn kiểm tra — nếu cần, hãy bấm xác minh trong cửa sổ Chrome. "
                      "Tool sẽ tự chạy tiếp khi qua.", flush=True)
                warned = True
            time.sleep(1.5)

    def close(self):
        try:
            self.ctx.close()
        finally:
            self._pw.stop()
