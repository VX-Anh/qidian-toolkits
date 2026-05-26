import asyncio
import sys
import shutil
from pathlib import Path
from playwright.async_api import async_playwright
from playwright_stealth import Stealth

if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

URL = "https://www.qidian.com/chapter/1045003390/903387184/"

SRC_USER_DATA = Path(r"C:\Users\ASUS\AppData\Local\Google\Chrome\User Data")
PROFILE = "Default"
TMP_DIR = Path(r"C:\Users\ASUS\AppData\Local\Temp\chrome-pw-qidian")

# files needed for cookies/session — copy only these to keep it fast
PROFILE_FILES = [
    "Cookies",
    "Network/Cookies",
    "Preferences",
    "Local Storage",
    "IndexedDB",
    "Session Storage",
]

def prepare_temp_profile():
    src_profile = SRC_USER_DATA / PROFILE
    dst_profile = TMP_DIR / PROFILE

    if TMP_DIR.exists():
        shutil.rmtree(TMP_DIR)
    TMP_DIR.mkdir(parents=True)

    # copy Local State (contains encryption keys)
    local_state = SRC_USER_DATA / "Local State"
    if local_state.exists():
        shutil.copy2(local_state, TMP_DIR / "Local State")

    dst_profile.mkdir(parents=True)
    for item in PROFILE_FILES:
        src = src_profile / item
        dst = dst_profile / item
        if src.is_dir():
            try:
                shutil.copytree(src, dst, dirs_exist_ok=True)
            except (PermissionError, shutil.Error) as e:
                print(f"  Partial copy (some files locked): {src.name}")
        elif src.is_file():
            dst.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.copy2(src, dst)
            except PermissionError:
                print(f"  Skipped (locked): {src.name}")

    print(f"Profile copied to {TMP_DIR}")

async def main():
    prepare_temp_profile()

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=str(TMP_DIR),
            channel="chrome",
            headless=False,
            args=[
                f"--profile-directory={PROFILE}",
                "--disable-blink-features=AutomationControlled",
            ],
            locale="zh-CN",
            viewport={"width": 1280, "height": 900},
        )

        page = await ctx.new_page()
        await Stealth().apply_stealth_async(page)

        print(f"Navigating to {URL} ...")
        await page.goto(URL, wait_until="domcontentloaded", timeout=30_000)
        await page.wait_for_timeout(4_000)

        title = await page.title()
        print(f"Page title: {title}")

        html = await page.content()
        Path("page_dump.html").write_text(html, encoding="utf-8")
        print(f"HTML saved ({len(html)} chars)")

        selectors = [
            "#j_chapterContent",
            ".read-content",
            ".chapter-content",
            "[class*='content']",
            "article",
        ]
        text = ""
        for sel in selectors:
            try:
                el = page.locator(sel).first
                if await el.count():
                    candidate = await el.inner_text()
                    if len(candidate) > len(text):
                        text = candidate
                        print(f"Selector '{sel}': {len(text)} chars")
            except Exception:
                continue

        if text:
            out = Path("chapter.txt")
            out.write_text(text, encoding="utf-8")
            print(f"\nSaved to {out} ({len(text)} chars)")
            print("--- preview ---")
            print(text[:300])
        else:
            print("No content found — check page_dump.html")

        await page.wait_for_timeout(3_000)
        await ctx.close()

asyncio.run(main())
