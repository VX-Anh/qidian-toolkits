"""Thử nghiệm: mở một chương Qidian bằng Chrome thật (dùng bản sao cookie của
profile Chrome đã đăng nhập) rồi lấy text chương.

Dùng:
    uv run scrape.py <URL chương> [--profile Default] [--user-data-dir <thư mục User Data>]
                     [--out chapter.txt] [--dump page_dump.html]

Mặc định user-data-dir = %LOCALAPPDATA%\\Google\\Chrome\\User Data (hoặc biến môi
trường CHROME_USER_DATA). Profile được copy vào một thư mục tạm riêng của lần chạy
(tự xoá khi xong) để không đụng tới profile Chrome đang mở.

Chương dùng font mã hoá (class r-font-encrypt) sẽ KHÔNG được lưu: text trong DOM là
chữ Hán thật nhưng sai chữ. Với chương đó dùng extension (chụp màn hình) + qidian-ocr.
"""
import argparse
import asyncio
import os
import shutil
import sys
import tempfile
from pathlib import Path

# Thứ tự ưu tiên: selector cụ thể của khối nội dung trước. Lấy selector ĐẦU TIÊN có
# nội dung đủ dài — không lấy "chuỗi dài nhất" (selector chung như [class*='content']
# dễ trúng cả khung trang, kéo theo menu/bình luận).
SELECTORS = ["#j_chapterContent", ".read-content", ".chapter-content", "main article"]
MIN_CHARS = 200

# Chỉ copy các file cần cho cookie/session để nhanh.
PROFILE_FILES = [
    "Cookies",
    "Network/Cookies",
    "Preferences",
    "Local Storage",
    "IndexedDB",
    "Session Storage",
]


def default_user_data_dir() -> Path:
    env = os.environ.get("CHROME_USER_DATA")
    if env:
        return Path(env)
    return Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "User Data"


def prepare_temp_profile(src_user_data: Path, profile: str) -> Path:
    if not (src_user_data / profile).is_dir():
        raise SystemExit(f"Không thấy profile Chrome: {src_user_data / profile} "
                         "(chỉnh --user-data-dir / --profile)")
    tmp_dir = Path(tempfile.mkdtemp(prefix="chrome-pw-qidian-"))
    dst_profile = tmp_dir / profile

    local_state = src_user_data / "Local State"   # chứa khoá giải mã cookie
    if local_state.exists():
        shutil.copy2(local_state, tmp_dir / "Local State")

    dst_profile.mkdir(parents=True)
    for item in PROFILE_FILES:
        src = src_user_data / profile / item
        dst = dst_profile / item
        if src.is_dir():
            try:
                shutil.copytree(src, dst, dirs_exist_ok=True)
            except (PermissionError, shutil.Error):
                print(f"  Copy thiếu (file đang bị khoá): {src.name}")
        elif src.is_file():
            dst.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.copy2(src, dst)
            except PermissionError:
                print(f"  Bỏ qua (đang bị khoá): {src.name}")

    print(f"Đã copy profile vào {tmp_dir}")
    return tmp_dir


async def scrape(url: str, user_data: Path, profile: str, out: Path, dump: Path | None) -> int:
    from playwright.async_api import async_playwright
    from playwright_stealth import Stealth

    tmp_dir = prepare_temp_profile(user_data, profile)
    try:
        async with async_playwright() as p:
            ctx = await p.chromium.launch_persistent_context(
                user_data_dir=str(tmp_dir),
                channel="chrome",
                headless=False,
                args=[f"--profile-directory={profile}",
                      "--disable-blink-features=AutomationControlled"],
                locale="zh-CN",
                viewport={"width": 1280, "height": 900},
            )
            try:
                page = await ctx.new_page()
                await Stealth().apply_stealth_async(page)

                print(f"Mở {url} ...")
                await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
                await page.wait_for_timeout(4_000)
                print(f"Tiêu đề trang: {await page.title()}")

                if dump:
                    html = await page.content()
                    dump.write_text(html, encoding="utf-8")
                    print(f"Đã lưu HTML ({len(html)} ký tự) → {dump}")

                if await page.locator("[class*='r-font-encrypt']").count():
                    print("Chương dùng FONT MÃ HOÁ — text trong DOM sai chữ, không lưu. "
                          "Dùng extension (chụp màn hình) + qidian-ocr cho chương này.")
                    return 2

                for sel in SELECTORS:
                    el = page.locator(sel).first
                    if not await el.count():
                        continue
                    text = (await el.inner_text()).strip()
                    if len(text) >= MIN_CHARS:
                        out.write_text(text, encoding="utf-8")
                        print(f"Selector '{sel}': {len(text)} ký tự → {out}")
                        print("--- xem trước ---")
                        print(text[:300])
                        return 0
                print("Không tìm thấy nội dung chương" + (f" — xem {dump}" if dump else " (thêm --dump để xem HTML)"))
                return 1
            finally:
                await ctx.close()
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)   # chỉ xoá thư mục tạm của chính lần chạy này


def main() -> None:
    if sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="Lấy text một chương Qidian bằng Chrome đã đăng nhập")
    ap.add_argument("url", help="URL chương, vd https://www.qidian.com/chapter/<book>/<chapter>/")
    ap.add_argument("--user-data-dir", type=Path, default=default_user_data_dir())
    ap.add_argument("--profile", default="Default")
    ap.add_argument("--out", type=Path, default=Path("chapter.txt"))
    ap.add_argument("--dump", type=Path, default=None, help="Lưu HTML trang để debug selector")
    args = ap.parse_args()
    sys.exit(asyncio.run(scrape(args.url, args.user_data_dir, args.profile, args.out, args.dump)))


if __name__ == "__main__":
    main()
