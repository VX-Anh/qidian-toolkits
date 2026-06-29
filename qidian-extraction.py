"""
qidian_extract.py
=================
Trích text MỘT bộ truyện Qidian mà BẠN ĐÃ MUA, cho mục đích nghiên cứu cá nhân.

Nguyên tắc: KHÔNG đảo ngược thuật toán mã hóa. Thay vào đó, để chính trình duyệt
đã đăng nhập (session đã trả phí của bạn) tự chạy Fock và render text, rồi mình
chỉ "đọc lại" phần đã hiển thị. Như vậy chỉ lấy được đúng chương bạn có quyền đọc.

Cài đặt (Windows PowerShell):
    pip install playwright
    playwright install chromium
    # (tuỳ chọn, cho OCR fallback):  pip install ddddocr pillow

Cách dùng:
    1. Sửa BOOK_ID bên dưới (lấy từ URL: book.qidian.com/info/<BOOK_ID>).
    2. Chạy:  python qidian_extract.py
    3. Lần đầu: cửa sổ Chrome mở ra -> ĐĂNG NHẬP TAY vào tài khoản đã mua truyện
       -> quay lại terminal, bấm Enter. Cookie được lưu trong ./qd_profile nên
       các lần sau không cần đăng nhập lại.
    4. Script tự duyệt mục lục, vào từng chương, lưu .txt vào ./output/<BOOK_ID>/.
"""

import re
import time
import random
import pathlib
from playwright.sync_api import sync_playwright

# ----------------------------- CẤU HÌNH -----------------------------
BOOK_ID = "1004608738"          # <-- ĐỔI: id bộ truyện của bạn
USER_DATA_DIR = "./qd_profile"  # thư mục lưu session đăng nhập (giữ nguyên)
OUT_ROOT = pathlib.Path("./output") / BOOK_ID
HEADLESS = False                # để False để đăng nhập tay; sau đó có thể đổi True
MIN_DELAY, MAX_DELAY = 3.0, 7.0 # nghỉ ngẫu nhiên giữa các chương (giây) -> lịch sự, tránh bị chặn
USE_OCR_FALLBACK = True         # bật OCR nếu text lấy ra có vẻ bị rối font
# --------------------------------------------------------------------

OUT_ROOT.mkdir(parents=True, exist_ok=True)


def looks_garbled(text: str) -> bool:
    """Heuristic: nếu nhiều ký tự thuộc vùng Private Use Area / lạ -> nghi font rối."""
    if not text or len(text) < 20:
        return True
    weird = sum(1 for c in text if 0xE000 <= ord(c) <= 0xF8FF or ord(c) > 0x2FA1F)
    return weird / len(text) > 0.05


def extract_chapter_text(page) -> str:
    """3 lớp lấy text, ưu tiên sạch nhất."""
    # Lớp 1: đọc biến JS đã giải mã (tên biến có thể đổi theo thời gian -> thử vài cái)
    for js in ("() => window.content",
               "() => window.__NUXT__ && JSON.stringify(window.__NUXT__)",
               "() => document.querySelector('.read-content') && document.querySelector('.read-content').innerText"):
        try:
            val = page.evaluate(js)
            if isinstance(val, str) and len(val) > 50 and not looks_garbled(val):
                return val.strip()
        except Exception:
            pass

    # Lớp 2: innerText của các selector nội dung thường gặp
    for sel in (".read-content", ".read-content.j_readContent", "main .content", "#j_chapterBox"):
        try:
            el = page.query_selector(sel)
            if el:
                txt = el.inner_text().strip()
                if txt and not looks_garbled(txt):
                    return txt
        except Exception:
            pass

    # Lớp 3: OCR fallback (chụp khối nội dung rồi nhận dạng)
    if USE_OCR_FALLBACK:
        try:
            import ddddocr  # noqa
            ocr = ddddocr.DdddOcr(show_ad=False)
            el = page.query_selector(".read-content") or page.query_selector("main")
            if el:
                png = el.screenshot()
                return ocr.classification(png).strip()
        except Exception as e:
            print("    [OCR fallback lỗi]", e)

    return ""  # thất bại


def get_chapter_links(page) -> list:
    """Lấy danh sách (tiêu đề, url) từ trang mục lục của sách."""
    page.goto(f"https://book.qidian.com/info/{BOOK_ID}/", wait_until="domcontentloaded")
    time.sleep(2)
    # các <a> chương thường nằm trong khối mục lục .volume / .catalog
    anchors = page.query_selector_all(".volume a, .catalog a, .chapter-list a")
    links = []
    for a in anchors:
        href = a.get_attribute("href") or ""
        title = (a.inner_text() or "").strip()
        if "/chapter/" in href:
            if href.startswith("//"):
                href = "https:" + href
            links.append((title, href))
    # khử trùng lặp, giữ thứ tự
    seen, uniq = set(), []
    for t, h in links:
        if h not in seen:
            seen.add(h); uniq.append((t, h))
    return uniq


def safe_name(s: str, idx: int) -> str:
    s = re.sub(r'[\\/:*?"<>|]', "_", s).strip() or "chuong"
    return f"{idx:04d}_{s[:60]}.txt"


def main():
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            USER_DATA_DIR,
            headless=HEADLESS,
            args=["--disable-blink-features=AutomationControlled"],
            viewport={"width": 1280, "height": 900},
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        # --- Đăng nhập tay (chỉ lần đầu) ---
        page.goto("https://www.qidian.com", wait_until="domcontentloaded")
        input(">>> Hãy ĐĂNG NHẬP tài khoản đã mua truyện trong cửa sổ Chrome, "
              "xong rồi quay lại đây bấm Enter... ")

        chapters = get_chapter_links(page)
        print(f"Tìm thấy {len(chapters)} chương.")
        if not chapters:
            print("Không lấy được mục lục — kiểm tra lại BOOK_ID hoặc đã đăng nhập chưa.")
            ctx.close(); return

        for i, (title, url) in enumerate(chapters, 1):
            out = OUT_ROOT / safe_name(title, i)
            if out.exists():
                print(f"[{i}/{len(chapters)}] bỏ qua (đã có): {out.name}")
                continue

            try:
                page.goto(url, wait_until="domcontentloaded")
                # đợi nội dung được Fock giải mã & render
                try:
                    page.wait_for_selector(".read-content", timeout=15000)
                except Exception:
                    pass
                time.sleep(random.uniform(1.5, 3.0))

                text = extract_chapter_text(page)
                if text:
                    out.write_text(f"{title}\n\n{text}\n", encoding="utf-8")
                    print(f"[{i}/{len(chapters)}] OK  -> {out.name}  ({len(text)} ký tự)")
                else:
                    print(f"[{i}/{len(chapters)}] TRỐNG/RỐI: {title} — {url}")
            except Exception as e:
                print(f"[{i}/{len(chapters)}] LỖI: {e}")

            time.sleep(random.uniform(MIN_DELAY, MAX_DELAY))  # nghỉ giữa các chương

        ctx.close()
        print("Xong. File nằm trong:", OUT_ROOT.resolve())


if __name__ == "__main__":
    main()