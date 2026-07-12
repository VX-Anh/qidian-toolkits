# Native Screenshot Host

Chương trình Python nhỏ chạy **ngoài Chrome**, được Chrome khởi chạy làm
subprocess khi extension gọi `chrome.runtime.connectNative('com.qidian.screenshot_host')`.
Nó chụp đúng vùng màn hình vật lý bằng thư viện [`mss`](https://python-mss.readthedocs.io/)
— cùng cơ chế mà Windows Snipping Tool dùng — để né lỗi Chromium render sai
glyph khi chụp qua CDP `captureBeyondViewport`. Bối cảnh/kiến trúc đầy đủ:
[`../docs/native-screenshot-tool-plan.md`](../docs/native-screenshot-tool-plan.md).

## Yêu cầu

- Windows + Python 3 (khuyến nghị 3.9+) có trong PATH (`python` hoặc `py`).
- Thư viện: `mss`, `Pillow`.

## Cài đặt (một lần)

1. Cài dependencies:

   ```powershell
   pip install -r requirements.txt
   ```

   (hoặc chạy `install.ps1 -InstallDeps` ở bước 3, nó tự làm việc này.)

2. Mở `chrome://extensions`, bật **Developer mode**, **Load unpacked** trỏ vào
   thư mục `qidian-extension/` (nếu chưa load). Copy **Extension ID** hiển thị
   dưới tên extension (chuỗi 32 ký tự `a`-`p`, ví dụ
   `abcdefghijklmnopqrstuvwxyzabcdef`).

3. Chạy script cài đặt (PowerShell, **không cần quyền Admin** — chỉ ghi vào
   `HKCU`, tức registry của user hiện tại):

   ```powershell
   cd qidian-extension\native-host
   .\install.ps1 -ExtensionId "<extension-id-vừa-copy>"
   ```

   Thêm `-InstallDeps` nếu chưa chắc đã cài `mss`/`Pillow`:

   ```powershell
   .\install.ps1 -ExtensionId "<extension-id>" -InstallDeps
   ```

   Script sẽ:
   - Sinh file `com.qidian.screenshot_host.json` (manifest native messaging)
     với đường dẫn tuyệt đối tới `run_host.bat` trong đúng thư mục này.
   - Đăng ký đường dẫn manifest đó vào
     `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.qidian.screenshot_host`.

4. Mở lại một trang chapter trên `qidian.com`, bấm **`📷 Chụp ảnh → .jpg`** hoặc
   **`🖼️ Chụp ảnh → OCR server`** trong popup extension để kiểm tra.

## Nếu extension reload / đổi đường dẫn cài đặt

- **Reload lại extension** (đổi ID nếu thư mục cài đặt đổi đường dẫn) → phải
  chạy lại `install.ps1` với Extension ID mới.
- **Di chuyển thư mục dự án** → chạy lại `install.ps1` (đường dẫn `run_host.bat`
  ghi trong manifest là tuyệt đối, cần sinh lại).

## Xử lý sự cố

| Triệu chứng | Kiểm tra |
| --- | --- |
| Popup báo "Native host đã ngắt kết nối" ngay khi chụp | Đã chạy `install.ps1` với đúng Extension ID hiện tại chưa? Kiểm tra `chrome://extensions` xem ID có khớp `allowed_origins` trong `com.qidian.screenshot_host.json` không. |
| Lỗi liên quan `mss`/`Pillow`/`ModuleNotFoundError` | Chạy `pip install -r requirements.txt` (đúng Python mà `run_host.bat` gọi — kiểm tra `where python`). |
| Ảnh chụp bị đen/sai vùng | Cửa sổ Chrome có bị cửa sổ khác che lúc chụp không — tránh thao tác chuột/chuyển cửa sổ trong lúc đang chụp (thanh tiến trình đang chạy). Kiểm tra thiết lập DPI scaling nếu dùng nhiều màn hình có tỉ lệ scale khác nhau. |
| `run_host.bat` không chạy được | Kiểm tra `python`/`py` có trong PATH: mở PowerShell mới, gõ `python --version`. |

## Kiểm tra thủ công (không cần Chrome)

```powershell
python qidian_screenshot_host.py
```

Sẽ đứng chờ input trên stdin — không dùng trực tiếp qua terminal được vì giao
thức Native Messaging cần đúng khung 4-byte length-prefix. Để test roundtrip,
dùng script test đơn giản: viết một script Python ngắn tự đóng gói message
`{"action":"ping"}` theo đúng khung rồi đọc phản hồi qua `subprocess.Popen`.
