# Cơ chế chụp ảnh chapter của Extension

Tài liệu mô tả cách extension **Qidian Chapter Scraper** chụp ảnh nội dung một
chapter trên `qidian.com`. Toàn bộ logic chụp nằm trong
[`popup.js`](../popup.js); manifest khai báo quyền tại [`manifest.json`](../manifest.json).
Thiết kế nền tảng ban đầu cho cơ chế native ở
[`native-screenshot-tool-plan.md`](./native-screenshot-tool-plan.md).

> **Chụp ảnh giờ là đường dự phòng, không phải đường chính.** Luồng chính của
> extension là **trích xuất text** trực tiếp (nút "Copy text" / "Gửi text →
> server"). Chỉ khi trang dùng **font mã hóa** (class `r-font-encrypt`, đọc
> `innerText` ra chữ Hán lộn xộn) thì mới cần chụp ảnh để OCR bằng công cụ ngoài.
> Chi tiết luồng trích xuất text nằm ở phần cuối tài liệu này.

## Tổng quan

Extension chụp ảnh bằng **screenshot màn hình thật** — đọc thẳng pixel đã
composite trên màn hình, y hệt Windows Snipping Tool (Win+Shift+S) — thay vì
bất kỳ đường render nội bộ nào của Chrome.

**Vì sao không dùng CDP `Page.captureScreenshot`:** bản trước dùng
`chrome.debugger` gọi CDP với `captureBeyondViewport: true` để chụp cả phần
ngoài màn hình mà không cần cuộn. Nhưng Chromium render vùng "ngoài viewport"
này qua một đường composite riêng, không đi qua đúng chu trình paint/shape-glyph
mà nội dung *thực sự hiển thị* trải qua — với font CJK tùy biến theo từng
chương của Qidian, việc này gây **sai glyph ở một số vị trí cố định** (quan sát
thực tế: 三→八, 有→没, 不→是 ở cùng vị trí, lặp lại y hệt qua nhiều lần chụp cách
nhau nhiều giờ, dù DOM/font đều đã load đầy đủ — tức không phải lỗi timing).
Windows Snipping Tool luôn ra đúng vì nó chỉ đọc pixel đã thực sự paint.

**Giải pháp:** một **Native Messaging Host** — chương trình Python
(`native-host/qidian_screenshot_host.py`) chạy ngoài Chrome trên máy người
dùng, dùng thư viện [`mss`](https://python-mss.readthedocs.io/) chụp đúng vùng
màn hình vật lý. Extension cuộn thật tới từng vùng cần chụp (không cuộn ảo)
rồi gọi native host qua `chrome.runtime.connectNative`. Xem chi tiết cài đặt ở
[`native-host/README.md`](../native-host/README.md).

### Quyền cần thiết (`manifest.json`)

```json
"permissions": ["activeTab", "downloads", "storage", "scripting", "nativeMessaging"],
"host_permissions": ["https://www.qidian.com/*", "http://*/*", "https://*/*"]
```

- `nativeMessaging` — bắt buộc để gọi native host chụp màn hình thật.
- `scripting` — dùng cho cả luồng chụp (đo vùng nội dung, chờ font, cuộn) lẫn
  luồng trích xuất text (`chrome.scripting.executeScript` chạy ở cả world
  `MAIN` và isolated). **Không còn dùng `chrome.debugger`/CDP cho bất cứ việc
  gì** — không còn banner vàng cảnh báo "extension đang gỡ lỗi trình duyệt".
- `downloads` — lưu ảnh `.jpg` (nút "Chụp ảnh") và `.txt` (nút "Copy text").
- `storage` — nhớ **Novel Slug** và **Server URL** người dùng nhập.
- `activeTab` — đọc tab đang mở.
- `host_permissions` mở rộng ra `http://*/*` + `https://*/*` để nút "Gửi text →
  server" POST được lên backend ở **bất kỳ host nào** người dùng cấu hình
  (mặc định `http://localhost:9999`).

## Luồng chụp — hàm `captureChapter(tabId)`

### Pha 1 — Ổn định trang (pre-scroll)

Qidian nạp ads/JS động khi cuộn, làm chiều cao DOM thay đổi. Để tránh đo nhầm,
extension cuộn xuống đáy rồi cuộn về đầu qua `chrome.scripting.executeScript`,
mỗi bước có thời gian chờ:

```js
window.scrollTo(0, document.body.scrollHeight)  // ép load nội dung động
await wait(PRE_SETTLE_MS)   // 600ms
window.scrollTo(0, 0)
await wait(POST_SCROLL_MS)  // 400ms
```

### Pha 1.5 — Chờ đúng font mã hóa load + paint xong (`waitForEncryptedFont`)

Qidian dùng **font mã hóa** (`r-font-encrypt`): mã ký tự trong DOM bị xáo trộn và
chỉ hiển thị **đúng** khi web-font tùy biến đã được apply. `document.fonts.ready`
không đủ tin (resolve sớm khi font nạp lazy chưa được request), nên
`waitForEncryptedFont(waitMs, pollMs)` — chạy qua
`chrome.scripting.executeScript({func: waitForEncryptedFont, args: [FONT_WAIT_MS, FONT_POLL_MS]})`
— chủ động:

1. **Tìm phần tử mang font mã hóa** — `[class*='r-font-encrypt'], main[class*='encrypt']`
   (cùng selector với `scanDomSelectors`); không có thì fallback khối nội dung theo
   `SELS` của `detectContentBounds`.
2. **Đọc `getComputedStyle(el).fontFamily`**, loại các font hệ thống phổ biến —
   còn lại là web-font tùy biến. Không còn family nào → trang thường, khỏi chờ.
3. **Ép request font** bằng `document.fonts.load(spec, sampleText)`, với
   `sampleText` = ~30 ký tự đầu của chính nội dung để check đúng dải glyph.
4. **Poll `document.fonts.check(spec, sampleText)`** mỗi `FONT_POLL_MS` (200ms) tới
   khi `true` hoặc quá deadline `FONT_WAIT_MS` (12s).
5. Loaded xong thì chờ **double-`requestAnimationFrame`** (đợi paint thật) và trả
   `{ encrypted, loaded, family, waitedMs }`.

Phía popup: nếu `encrypted && !loaded` → **throw, dừng hẳn** với thông báo yêu cầu
reload trang. Nếu loaded thì đệm thêm `FONT_SETTLE_MS` (250ms) rồi mới sang Pha 2.

### Pha 2 — Dò vùng nội dung (`detectContentBounds`)

Một hàm JS thật (không phải string+eval — CSP của Qidian chặn `unsafe-eval`
trong injected script) chạy qua `chrome.scripting.executeScript({func: detectContentBounds})`
để đo tọa độ thật của khối nội dung. Thử lần lượt các selector:

```js
["main[data-type='cjk']", "#j_chapterContent", ".read-content", ".chapter-content"]
```

Trả về object gồm:

| Trường             | Ý nghĩa                                                        |
| ------------------ | --------------------------------------------------------------|
| `left`, `width`    | Vị trí và bề rộng khối nội dung (để cắt theo trục X)          |
| `top`, `height`    | Đỉnh tuyệt đối + `scrollHeight` (fallback khi không có `<p>`) |
| `firstPTop`        | Tọa độ Y tuyệt đối của đỉnh đoạn `<p>` đầu tiên               |
| `lastPBottom`      | Tọa độ Y tuyệt đối của đáy đoạn `<p>` cuối cùng               |
| `paragraphBottoms` | Mảng tọa độ đáy của **từng** đoạn `<p>` (để snap điểm cắt)    |
| `viewportHeight`   | `window.innerHeight` — dùng để giới hạn chiều cao mỗi chunk   |

Tọa độ đều cộng `window.scrollY` để thành tọa độ **tuyệt đối trong tài liệu**.
Nếu không tìm thấy phần tử nào, hàm trả về `null` (không chụp).

### Pha 3 — Tính vùng crop

```js
const cropX = (info.left  > 0) ? info.left  : FALLBACK_CROP_X;  // 600
const cropW = (info.width > 0) ? info.width : FALLBACK_CROP_W;  // 695
```

- Ưu tiên dùng đoạn `<p>` đầu/cuối làm biên dọc: `startY = firstPTop - SAFE_PADDING`,
  `endY = lastPBottom + SAFE_PADDING` (`SAFE_PADDING = 20`).
- Nếu trang không có `<p>`, lùi về dùng `top` / `height` của khối.
- `totalH = endY - startY`; nếu `<= 0` thì bỏ qua.

### Pha 4 — Chụp theo từng đoạn (chunked capture, cuộn thật)

Vì giờ chụp bằng screen thật (không còn `captureBeyondViewport`), **mỗi chunk
phải được cuộn thật vào trong viewport rồi mới chụp được** — không thể chụp
vùng đang nằm ngoài màn hình. Chiều cao mỗi chunk vì vậy bị giới hạn bởi
viewport thật:

```js
const effectiveChunkH = Math.max(300,
  Math.min(CHUNK_H, info.viewportHeight - SAFE_PADDING - VIEWPORT_MARGIN - OVERLAP_H));
```

Vòng lặp chạy từ `startY` tới `endY`:

1. **Snap điểm cắt theo đáy đoạn văn** — như trước, nhưng dùng `effectiveChunkH`
   thay vì `CHUNK_H` cố định: điểm cắt "snap" về đáy đoạn `<p>` gần nhất trong
   khoảng `[y + effectiveChunkH*MIN_CHUNK_RATIO, y + effectiveChunkH]` qua hàm
   `pickLastInRange`.

2. **Vùng chồng lấn (overlap)** — từ chunk thứ hai trở đi, điểm bắt đầu chụp
   lùi `OVERLAP_H = 120px` so với điểm cắt trước, giúp OCR ghép/khử trùng lặp
   văn bản giữa các ảnh mà không mất dòng ở mép.

3. **Cuộn thật + đọc tọa độ màn hình.** Gọi
   `chrome.scripting.executeScript({func: scrollAndReport, args: [captureY]})`:
   cuộn `window.scrollTo(0, captureY)`, chờ 2 khung `requestAnimationFrame`
   (paint thật xong), rồi trả về
   `{ scrollY, innerWidth, innerHeight, outerWidth, outerHeight, screenX, screenY, devicePixelRatio }`.
   Hỗ trợ multi-monitor (tọa độ có thể âm nếu cửa sổ ở màn hình phụ bên trái/trên
   màn chính).

   > **Lưu ý quan trọng:** MDN mô tả `window.screenY` là đỉnh **viewport nội
   > dung** (dưới thanh tab/toolbar), nhưng thực đo trên Chrome lại ra đỉnh
   > **cửa sổ ngoài** (kể cả thanh tab) — tin thẳng giá trị này làm ảnh chụp
   > dính nguyên thanh tab phía trên. Phải tự bù bằng
   > `chromeUIHeight = outerHeight - innerHeight` (đo cùng lúc, cùng đơn vị CSS
   > px, nên không lệch do quy đổi DPI giữa các API khác nhau).

4. **Quy đổi sang tọa độ vật lý** (`toPhysicalRect`): cộng `chromeUIHeight` vào
   `screenY` rồi nhân `devicePixelRatio` để ra pixel vật lý cho native host —
   vì `mss` chụp theo tọa độ vật lý màn hình, không phải CSS px.

   ```js
   const viewportRelY = captureY - scrollInfo.scrollY;  // >0 nếu bị kẹp cuối trang
   const clipH = Math.max(1, Math.min(captureH, scrollInfo.innerHeight - viewportRelY));
   const rect = toPhysicalRect(scrollInfo, cropX, viewportRelY, cropW, clipH);
   ```

5. **Gọi native host chụp** qua `captureViaNativeHost` (retry tối đa
   `MAX_RETRY = 2` lần, mỗi lần chờ tăng dần `300ms * attempt`) — gửi
   `{action:'capture', x, y, width, height}` (tọa độ vật lý) qua
   `chrome.runtime.connectNative('com.qidian.screenshot_host')`, nhận lại
   `{ok, dataUrl}`.

6. Nếu viewport thật buộc chụp **ngắn hơn dự kiến** (hiếm — vd bị kẹp ở cuối
   trang, không cuộn xa hơn được), vòng lặp tiếp tục đúng từ điểm **đã chụp
   được** (`captureY + clipH`) thay vì điểm lý thuyết `endAt`, để không mất nội
   dung ở khoảng bị hụt.

**Không** gọi `chrome.windows.update({focused: true})` để ép cửa sổ Chrome lên
trước — tưởng chừng hợp lý (chụp màn hình thật sẽ dính bất kỳ cửa sổ nào đè lên)
nhưng nó chuyển focus OS sang cửa sổ Chrome, mà **popup extension tự đóng ngay
khi mất focus**, giết luôn tiến trình chụp đang chạy dở giữa chừng (kể cả kết
nối native host). Chấp nhận đánh đổi: giả định cửa sổ Chrome đã ở trên cùng vì
người dùng vừa bấm nút ngay trong popup đó.

Hàm trả về mảng các data URL — mỗi phần tử là một ảnh JPEG của một đoạn chapter.

## Hằng số điều chỉnh (đầu `popup.js`)

| Hằng số                 | Giá trị          | Vai trò                                                   |
| ------------------------| ---------------- | --------------------------------------------------------- |
| `FALLBACK_CROP_X`       | 600              | Tọa độ X dự phòng khi không đo được `left`                |
| `FALLBACK_CROP_W`       | 695              | Bề rộng dự phòng khi không đo được `width`                |
| `CHUNK_H`               | 1400             | Trần tối đa mỗi chunk (px) — thực tế còn bị giới hạn bởi viewport thật |
| `OVERLAP_H`             | 120              | Độ chồng lấn giữa các chunk liên tiếp (px)                |
| `SAFE_PADDING`          | 20               | Đệm thêm ở biên trên/dưới (px)                            |
| `MAX_RETRY`             | 2                | Số lần thử lại khi gọi native host chụp lỗi               |
| `PRE_SETTLE_MS`         | 600              | Chờ sau khi cuộn xuống đáy (ổn định DOM)                  |
| `POST_SCROLL_MS`        | 400              | Chờ sau khi cuộn về đầu                                   |
| `FONT_WAIT_MS`          | 12000            | Deadline tổng chờ font mã hóa load xong (quá hạn → dừng)  |
| `FONT_POLL_MS`          | 200              | Chu kỳ poll `document.fonts.check()` khi chờ font         |
| `FONT_SETTLE_MS`        | 250              | Đệm sau khi font ready + paint để chắc chắn vẽ xong       |
| `MIN_CHUNK_RATIO`       | 0.55             | Ngưỡng tối thiểu để chấp nhận snap điểm cắt theo `<p>`    |
| `CHUNK_SCROLL_SETTLE_MS`| 150              | Đệm sau khi cuộn thật tới từng chunk, trước khi chụp      |
| `VIEWPORT_MARGIN`       | 20               | Đệm an toàn dưới viewport thật khi tính chunk cao tối đa  |
| `NATIVE_HOST_NAME`      | `com.qidian.screenshot_host` | Tên native messaging host đăng ký trong registry |
| `EXPORT_BASE_DIR`       | `data/vietphase` | Thư mục gốc (trong Downloads) để lưu ảnh/text             |
| `DEFAULT_SERVER`        | `http://localhost:9999` | Server mặc định cho nút "Gửi text → server"        |

Chất lượng JPEG (`quality=95`) giờ cấu hình ở phía **native host**
(`native-host/qidian_screenshot_host.py`, hằng `JPEG_QUALITY`), không còn trong `popup.js`.

## Bốn nút thao tác trong popup

Popup ([`popup.html`](../popup.html)) có 4 nút. **Hai nút đầu dùng cơ chế chụp
ảnh native host ở trên**; hai nút còn lại đi theo luồng trích xuất text (xem
phần sau). Cả bốn đều chỉ chạy khi tab đang mở URL chứa `qidian.com/chapter/`,
và đều dùng chung ô **Novel Slug** để đặt tên thư mục lưu.

- **`📷 Chụp ảnh → .jpg`** — `btnCapture`: gọi `captureChapter(tab.id)`
  rồi lưu từng ảnh ra `Downloads/` qua `chrome.downloads.download`, đường dẫn dạng
  `data/vietphase/<slug>/<số-chương>/<tên>_NN.jpg`. Đây là đường **dự phòng** khi
  trang dùng font mã hóa, không lấy được text sạch. Số chương suy ra từ tiêu đề
  tab qua `extractChapterNumber`.

- **`🖼️ Chụp ảnh → OCR server`** — `btnSendImages`: cũng gọi `captureChapter`
  nhưng thay vì tải về Downloads thì `POST` multipart (`novel_slug` +
  `chapter_title` thô của tab + các ảnh `shot_NN.jpg`) lên
  `${Server URL}/api/ocr/upload`. Server trả `job_id`, popup mở **EventSource**
  (`streamOcr`) theo dõi tiến trình OCR trên server tới khi `ocr_done`/`ocr_error`.
  Bắt buộc nhập Novel Slug trước khi gửi.

- **`📋 Copy text → .txt`** — `btnCopyTxt`: chạy `extractTextFromPage` để đọc
  `innerText`, làm sạch bằng `cleanExtractedText`, rồi tải file `.txt` về cùng
  cây thư mục `data/vietphase/<slug>/<số-chương>/<tên>.txt`. Nếu phát hiện font
  mã hóa (`garbled`) thì báo người dùng chuyển sang nút chụp ảnh.

- **`🚀 Gửi text → server`** — `btnSendServer`: cũng trích xuất text như trên
  nhưng thay vì tải về Downloads thì `POST` multipart (`novel_slug` + file
  `.txt`) lên `${Server URL}/api/chapters/upload`. Server URL lấy từ ô nhập
  (mặc định `http://localhost:9999`, bỏ dấu `/` cuối). Bắt buộc nhập Novel Slug
  trước khi gửi; phản hồi phải là JSON, nếu không sẽ báo lỗi cấu hình URL.

> OCR **không chạy trong extension** — extension chỉ chụp và đẩy ảnh lên backend
> (`/api/ocr/upload`), việc nhận dạng chữ do server đảm nhận (mặc định engine
> paddle); extension chỉ theo dõi kết quả qua EventSource.

## Luồng trích xuất text (đường chính)

Hai nút "Copy text" và "Gửi text → server" dùng chung `extractTextFromPage(tabId)`,
một pipeline nhiều lớp để lấy text **sạch** và phát hiện trang mã hóa font:

1. **Lớp 2 — quét DOM (`scanDomSelectors`, isolated world).** Thử nhiều selector
   (kể cả layout mới `main[id^='c-']`, `main.content` lẫn layout cũ
   `#j_chapterContent`, `.read-content`…), chấm điểm từng selector bằng
   `analyzeText` (ưu tiên nhiều ký tự CJK, ít ký tự PUA). Đồng thời kiểm tra class
   `r-font-encrypt`/`*encrypt*` để bắt trang **font mã hóa** → ép cờ `garbled`.

2. **Lớp 1 — quét page context (`scanPageContext`, world `MAIN`).** Đọc biến JS
   của trang (`window.*` theo whitelist key, JSON nhúng trong
   `<script type="application/json">`/`#__NEXT_DATA__`) để tìm bản text sạch mà
   isolated world không thấy. Nếu trang mã hóa font thì **bỏ qua** lớp này.

3. **Lớp 3 — quyết định.** Nếu trang mã hóa font → trả `garbled: true` (buộc chụp
   ảnh). Nếu không, ưu tiên candidate sạch từ Lớp 1, sau đó tới Lớp 2.

`analyzeText` đếm tỉ lệ ký tự **Private Use Area (PUA)** trên tổng ký tự
non-whitespace để phát hiện font tùy biến (nhìn đúng nhưng `innerText` ra ký tự
rác). Hàm này có **3 bản copy** (bản gốc + trong `scanPageContext` + trong
`scanDomSelectors`) vì injected function chạy ở world khác nên mất closure và
không truyền qua string được (CSP chặn `eval`). **Sửa heuristic thì phải sửa cả 3.**

## Tóm tắt các vấn đề & cách giải quyết

| Vấn đề                                     | Cách extension giải quyết                                              |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| Nội dung dài hơn viewport                  | Cuộn thật tới từng chunk (`scrollAndReport`) rồi mới chụp               |
| Chụp vùng "ngoài viewport" Chromium render sai glyph | Bỏ hẳn CDP `captureBeyondViewport`; chụp bằng native host qua `mss` (đọc đúng pixel màn hình thật) |
| Chỉ muốn cắt đúng khối chữ                 | Đo `left/width` + biên `<p>` đầu/cuối từ DOM thật (`detectContentBounds`) |
| Ads động làm DOM nhảy chiều cao            | Pre-scroll + chờ `PRE_SETTLE_MS`/`POST_SCROLL_MS`                        |
| Chụp trước khi font mã hóa apply → chữ sai | `waitForEncryptedFont`: ép `fonts.load` + poll `fonts.check` + double-rAF; quá hạn thì dừng |
| Ảnh quá cao gây lỗi/giới hạn trình duyệt   | Cắt thành chunk cao tối đa `effectiveChunkH` (≤ viewport thật)           |
| Cắt ngang dòng chữ làm hỏng OCR            | Snap điểm cắt về đáy `<p>` + chồng lấn `OVERLAP_H`                       |
| Quy đổi tọa độ trang → tọa độ màn hình thật | `window.screenX/screenY` (đã gồm vị trí cửa sổ + toolbar) × `devicePixelRatio` |
| Lỗi chụp tạm thời                          | `captureViaNativeHost` thử lại tới `MAX_RETRY` lần                      |
