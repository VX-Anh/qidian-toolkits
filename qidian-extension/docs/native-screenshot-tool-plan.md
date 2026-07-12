# Kế hoạch: Native Screenshot Tool (chụp màn hình thật, giống Win+Shift+S)

> Tài liệu **kế hoạch thiết kế** — chưa có code triển khai. Mục đích: thống nhất
> kiến trúc trước khi bắt tay viết native host + sửa extension.

## 1. Bối cảnh & mục tiêu

### Vấn đề

Cơ chế chụp ảnh hiện tại của extension (xem
[`screenshot-capture.md`](./screenshot-capture.md)) dùng Chrome DevTools
Protocol (`chrome.debugger` → `Page.captureScreenshot` với
`captureBeyondViewport: true`) để chụp toàn bộ khối nội dung, kể cả phần nằm
ngoài viewport, mà không cần cuộn.

Điều tra lỗi "chụp ảnh ra sai chữ" ở chương 750
(`cau-tai-vo-dao-the-gioi-thanh-thanh`) — sai cố định 3 ký tự (三→八, 有→没,
不→是) lặp lại y hệt qua nhiều lần chụp cách nhau nhiều giờ, dù đã reload trang
đầy đủ — đã loại trừ các giả thuyết:

- **Không phải font-timing/FOUT**: `document.fonts.check()` xác nhận font tùy
  biến của trang đã load xong trước khi chụp.
- **Không phải watermark ở tầng DOM**: dump DOM qua CDP cho thấy toàn bộ
  `textContent` đã là cipher-text bị xáo trộn hoàn toàn (đúng cơ chế
  `r-font-encrypt`), không có "chữ đúng" nào lộ ra ở tầng DOM để đối chiếu.

**Nghi vấn chính:** `captureBeyondViewport: true` khiến Chromium render vùng
"ngoài viewport hiện tại" qua một đường composite riêng (resize ảo + chụp),
không đi qua đúng chu trình paint/shape-glyph mà nội dung *thực sự hiển thị
trên màn hình* trải qua. Với font CJK tùy biến phức tạp (font mã hóa theo từng
chương của Qidian), một số glyph ở vùng chưa từng được paint thật có thể bị
render sai.

**Bằng chứng quyết định:** người dùng xác nhận **chụp bằng công cụ chụp màn
hình của Windows (Snipping Tool / Win+Shift+S) luôn ra đúng chữ** — vì công cụ
đó chỉ đọc đúng pixel đã thực sự hiển thị trên màn hình (nội dung đã cuộn tới,
đã qua paint bình thường), không đi qua đường composite "ngoài viewport" của
CDP.

### Giới hạn kỹ thuật

Extension chạy trong sandbox trình duyệt, **không có API gọi thẳng chụp màn
hình OS**. Cách duy nhất để đạt được "chụp giống hệt Windows, không phụ thuộc
đường render nội bộ nào của Chrome" là **Native Messaging Host**: một chương
trình chạy ngoài Chrome trên máy người dùng, được Chrome khởi chạy làm
subprocess và giao tiếp qua `chrome.runtime.connectNative`.

### Mục tiêu

- Chụp ảnh chương **pixel-đúng**, tương đương chụp Windows thủ công.
- **Không đổi** API backend hiện có — vẫn dùng nguyên `/api/ocr/upload` và
  `/api/chapters/upload`:
  - `POST /api/ocr/upload` (`qidian-vietphase/backend/routers/ocr.py:24-51`):
    multipart `novel_slug` (Form), `chapter_title` (Form, optional), `engine`
    (Form, optional), `images` (File[]) → trả `{"job_id": ..., "engine": ...}`.
  - `POST /api/chapters/upload` (`qidian-vietphase/backend/routers/chapters.py:88-130`):
    multipart `novel_slug` (Form), `files` (File[], `.txt`) → trả
    `{"saved": [...], "errors": [...]}`.
- Tận dụng stack đã có trong dự án: backend (`qidian-vietphase/backend`,
  FastAPI), scraper (`qidian-scraper`), OCR service (`qidian-ocr`) đều là
  **Python** → native host cũng viết bằng Python, không thêm ngôn ngữ mới vào
  dự án.

## 2. Kiến trúc tổng quan

```
popup.js (extension)
  │  cuộn trang tới vùng cần chụp qua chrome.scripting.executeScript
  │  (không cần chrome.debugger/CDP cho bước này nữa)
  ▼
chrome.runtime.connectNative('com.qidian.screenshot_host')
  │  gửi {action:"capture", x, y, width, height}  (tọa độ VẬT LÝ màn hình)
  ▼
Native host — Python (subprocess do Chrome khởi chạy)
  │  dùng thư viện `mss` chụp đúng vùng màn hình vật lý
  │  encode JPEG → base64
  ▼
trả {"ok": true, "dataUrl": "data:image/jpeg;base64,..."}
  │  qua giao thức Native Messaging (stdin/stdout, 4-byte length prefix + JSON)
  ▼
popup.js nhận ảnh, tiếp tục luồng chunk/ghép/upload OCR hiện có — KHÔNG đổi
```

## 3. Các thành phần cần xây

### 3.1 Native host script

`qidian-extension/native-host/qidian_screenshot_host.py`

- Đọc/ghi đúng **giao thức Native Messaging** của Chrome: mỗi message có 4
  byte độ dài (little-endian uint32) đứng trước payload JSON UTF-8, cả chiều
  đọc từ stdin lẫn ghi ra stdout (không dùng `print()` thường — phải ghi
  byte thô qua `sys.stdout.buffer`).
- Dùng thư viện [`mss`](https://python-mss.readthedocs.io/) (nhẹ, cross-platform,
  không cần `pywin32`) để chụp vùng màn hình theo **tọa độ vật lý**
  (`{"left":x, "top":y, "width":w, "height":h}`).
- Input message: `{"action": "capture", "x": ..., "y": ..., "width": ..., "height": ...}`
- Output: `{"ok": true, "dataUrl": "data:image/jpeg;base64,..."}` hoặc
  `{"ok": false, "error": "..."}`
- Chạy như một vòng lặp đọc message liên tục (giữ process sống xuyên suốt một
  phiên `connectNative`), thoát khi stdin đóng (Chrome tự đóng port khi
  extension gọi `port.disconnect()` hoặc khi popup đóng).

### 3.2 Native messaging host manifest

File JSON riêng (**khác** với `manifest.json` của extension):
`com.qidian.screenshot_host.json`

```json
{
  "name": "com.qidian.screenshot_host",
  "description": "Qidian extension screen capture helper",
  "path": "C:\\path\\to\\qidian-host-launcher.bat",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<EXTENSION_ID>/"]
}
```

- `path` phải trỏ tới một **executable** — vì Chrome không chạy `.py` trực
  tiếp, cần một file `.bat` wrapper gọi `python.exe qidian_screenshot_host.py`
  (hoặc đóng gói bằng PyInstaller thành `.exe` độc lập — xem mục 4).
- `allowed_origins` cần đúng **Extension ID**. Vì extension đang là *unpacked*
  (`chrome://extensions` → Load unpacked), ID sinh ổn định theo đường dẫn
  thư mục cài đặt — phải lấy ID thật sau khi load extension rồi điền vào đây
  (ghi rõ bước này trong hướng dẫn cài đặt, không thể tự động hoàn toàn).

### 3.3 Script cài đặt

`qidian-extension/native-host/install.ps1`

- Đăng ký registry (mỗi máy chỉ cần chạy 1 lần):
  ```powershell
  reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.qidian.screenshot_host" `
    /ve /t REG_SZ /d "<đường-dẫn-tuyệt-đối-tới-manifest.json>" /f
  ```
- Nếu có thể, tự dò Extension ID (đọc từ một file cấu hình do người dùng dán
  vào, hoặc hỏi qua tham số dòng lệnh) — nếu không tự động được, in hướng dẫn
  thủ công rõ ràng (copy ID từ `chrome://extensions`, dán vào
  `allowed_origins`).

### 3.4 Cập nhật `qidian-extension/manifest.json`

Permissions hiện tại (`manifest.json:6`):
`["activeTab", "downloads", "storage", "debugger", "scripting"]` — **chưa có**
`"nativeMessaging"`. Cần thêm.

### 3.5 Cập nhật `qidian-extension/popup.js`

- Thay `captureWithRetry` / CDP `Page.captureScreenshot`
  (`popup.js:198-213`, hiện gọi qua `dbgSend(tabId, 'Page.captureScreenshot', {...captureBeyondViewport:true...})`)
  bằng gọi native host qua `chrome.runtime.connectNative(...)`.
- **Giữ nguyên** toàn bộ logic đã có và đã được kiểm chứng:
  - Phase 1 (pre-scroll ổn định trang, `popup.js:219-231`)
  - Phase 1.5 (chờ font mã hóa load, `FONT_WAIT_EXPR`, `popup.js:233-253`) —
    vẫn có giá trị phòng vệ dù không phải nguyên nhân chính của bug ảnh sai chữ.
  - `DETECT_EXPR` đo vùng nội dung (`popup.js:31-52`)
  - Cách chia chunk theo `CHUNK_H` / `OVERLAP_H` / `SAFE_PADDING`
    (`popup.js:15-19`, vòng lặp `popup.js:278-302`)
- Các bước đo/cuộn (`Runtime.evaluate` qua CDP) có thể chuyển sang
  `chrome.scripting.executeScript` (permission `"scripting"` đã có sẵn) — nhờ
  đó **bỏ được hẳn `chrome.debugger` và banner vàng cảnh báo** khỏi toàn bộ
  luồng chụp ảnh. Lợi ích phụ đáng kể, không phải mục tiêu chính.
- Thêm bước tính **tọa độ màn hình vật lý thật** từ tọa độ trang (CSS px) —
  đây là phần khó nhất về mặt kỹ thuật:
  1. `chrome.windows.get(windowId)` → vị trí/kích thước cửa sổ Chrome trên
     màn hình (`left`, `top`, `width`, `height`).
  2. Đọc `window.devicePixelRatio` trong trang (qua `chrome.scripting`) để
     quy đổi CSS px → pixel vật lý.
  3. Ước lượng chiều cao thanh công cụ trình duyệt bằng
     `window.outerHeight - window.innerHeight` (đọc trong trang).
  4. Cộng dồn: `tọa độ màn hình = vị trí cửa sổ + offset thanh công cụ + tọa độ nội dung trong trang (đã trừ scrollY hiện tại) × devicePixelRatio`.
- Trước mỗi lần chụp: `chrome.windows.update(windowId, {focused: true})` để
  đảm bảo cửa sổ Chrome không bị cửa sổ khác che (chụp OS thật sẽ dính bất kỳ
  nội dung nào đang hiển thị đè lên tại đúng tọa độ đó).

## 4. Rủi ro / vấn đề cần giải quyết khi thiết kế chi tiết

| Rủi ro | Ghi chú |
| --- | --- |
| Đa màn hình (multi-monitor) | `mss` chụp theo tọa độ ảo toàn cục (virtual screen); cần cộng đúng offset màn hình đang chứa cửa sổ Chrome, không mặc định màn hình chính. |
| DPI scaling (125%/150%...) | Sai `devicePixelRatio` → crop lệch vùng. Cần đọc đúng giá trị thật tại thời điểm chụp (có thể đổi nếu người dùng kéo cửa sổ sang màn hình khác DPI). |
| Chiều cao thanh công cụ trình duyệt không cố định | Có thể xê dịch do thanh bookmark, thông báo, v.v. Cần calibration hoặc chấp nhận sai số nhỏ, bù bằng `SAFE_PADDING` đã có sẵn trong logic crop. |
| Cửa sổ Chrome bị che / mất focus giữa chừng | Ảnh chụp sai hoàn toàn nếu cửa sổ khác đè lên đúng lúc chụp. Giảm thiểu bằng `chrome.windows.update(focused:true)` trước mỗi chunk, nhưng không loại trừ hoàn toàn được (vd popup hệ thống, thông báo Windows). |
| Overhead khởi động process | Khởi động Python interpreter mỗi lần chụp tốn ~100-300ms. Nên dùng `connectNative` (giữ 1 process xuyên suốt `captureChapter`, nhiều chunk dùng chung) thay vì `sendNativeMessage` one-shot mỗi chunk. |
| Đóng gói/phân phối | Chạy trực tiếp bằng `python.exe` có sẵn trên máy (nhanh triển khai, phụ thuộc môi trường Python + đã cài `mss`) hay đóng gói bằng PyInstaller thành `.exe` độc lập (ổn định hơn cho người dùng cuối, tốn công build/maintain). |
| Cài đặt 1 lần | Người dùng phải tự chạy `install.ps1` để đăng ký native host trong registry — cần hướng dẫn rõ, kèm bước lấy Extension ID thủ công. |

## 5. Kế hoạch triển khai theo giai đoạn (cho lượt code sau)

1. Native host cơ bản: giao thức Native Messaging, test ping/pong roundtrip
   từ `popup.js` (chưa chụp ảnh thật).
2. Thêm chụp thật bằng `mss`, test 1 vùng cố định, so khớp thủ công với
   Windows Snipping Tool (đối chiếu pixel/mắt thường).
3. Tích hợp vào `captureChapter`: thay CDP bằng native message trong vòng lặp
   chunk, thêm bước tính tọa độ màn hình thật (mục 3.5).
4. Bỏ `chrome.debugger` khỏi luồng chụp, chuyển đo đạc (`DETECT_EXPR`,
   `FONT_WAIT_EXPR`, pre-scroll) sang `chrome.scripting`.
5. Test end-to-end trên chương 750 (`cau-tai-vo-dao-the-gioi-thanh-thanh`, đã
   biết lỗi), xác nhận hết sai chữ ở câu "第三层十有四四不是真的".
6. Viết README cài đặt cho `qidian-extension/native-host/`.

## 6. Câu hỏi mở (quyết định ở lượt code, chưa cần trả lời ngay)

- Đóng gói host bằng PyInstaller (`.exe` độc lập) hay chạy trực tiếp bằng
  `python.exe` có sẵn trên máy?
- Xử lý multi-monitor ngay từ bản đầu, hay giả định 1 màn hình cho bản đầu
  tiên rồi mở rộng sau?
