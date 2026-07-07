# Cơ chế chụp ảnh chapter của Extension

Tài liệu mô tả cách extension **Qidian Chapter Scraper** chụp ảnh nội dung một
chapter trên `qidian.com`. Toàn bộ logic chụp nằm trong
[`popup.js`](../popup.js); manifest khai báo quyền tại [`manifest.json`](../manifest.json).

> **Chụp ảnh giờ là đường dự phòng, không phải đường chính.** Luồng chính của
> extension là **trích xuất text** trực tiếp (nút "Copy text" / "Gửi text →
> server"). Chỉ khi trang dùng **font mã hóa** (class `r-font-encrypt`, đọc
> `innerText` ra chữ Hán lộn xộn) thì mới cần chụp ảnh để OCR bằng công cụ ngoài.
> Chi tiết luồng trích xuất text nằm ở phần cuối tài liệu này.

## Tổng quan

Extension **không** dùng `chrome.tabs.captureVisibleTab` (chỉ chụp được vùng đang
hiển thị). Thay vào đó nó dùng **Chrome DevTools Protocol (CDP)** thông qua
`chrome.debugger`, gọi lệnh `Page.captureScreenshot` với cờ
`captureBeyondViewport: true`. Nhờ vậy có thể chụp **toàn bộ chiều cao** của khối
nội dung — kể cả phần nằm ngoài màn hình — mà không cần tự cuộn và ghép từng ảnh
viewport.

Vì dùng `chrome.debugger`, trình duyệt sẽ hiện **banner vàng cảnh báo** "extension
đang gỡ lỗi trình duyệt này". Đây là hành vi bình thường (popup có dòng nhắc người
dùng về banner này qua phần tử `#warning`).

### Quyền cần thiết (`manifest.json`)

```json
"permissions": ["activeTab", "downloads", "storage", "debugger", "scripting"],
"host_permissions": ["https://www.qidian.com/*", "http://*/*", "https://*/*"]
```

- `debugger` — bắt buộc để gọi CDP `Page.captureScreenshot`.
- `scripting` — bắt buộc cho luồng trích xuất text (`chrome.scripting.executeScript`
  chạy ở cả world `MAIN` và isolated để đọc nội dung trang).
- `downloads` — lưu ảnh `.jpg` (nút "Chụp ảnh") và `.txt` (nút "Copy text").
- `storage` — nhớ **Novel Slug** và **Server URL** người dùng nhập.
- `activeTab` — đọc tab đang mở.
- `host_permissions` mở rộng ra `http://*/*` + `https://*/*` để nút "Gửi text →
  server" POST được lên backend ở **bất kỳ host nào** người dùng cấu hình
  (mặc định `http://localhost:9999`), không còn cứng ở `localhost:9999`.

## Luồng chụp — hàm `captureChapter(tabId)`

Hàm `captureChapter` (popup.js) thực hiện 4 pha. Trước hết nó `dbgAttach(tabId)`
để gắn debugger vào tab, và luôn `dbgDetach` trong khối `finally` để gỡ ra dù
thành công hay lỗi.

### Pha 1 — Ổn định trang (pre-scroll)

Qidian nạp ads/JS động khi cuộn, làm chiều cao DOM thay đổi. Để tránh đo nhầm,
extension cuộn xuống đáy rồi cuộn về đầu, mỗi bước có thời gian chờ:

```js
window.scrollTo(0, document.body.scrollHeight)  // ép load nội dung động
await wait(PRE_SETTLE_MS)   // 600ms
window.scrollTo(0, 0)
await wait(POST_SCROLL_MS)  // 400ms
```

### Pha 2 — Dò vùng nội dung (`DETECT_EXPR`)

Một biểu thức JS được `Runtime.evaluate` chạy trong trang để đo tọa độ thật của
khối nội dung. Nó thử lần lượt các selector cho đến khi tìm thấy phần tử:

```js
["main[data-type='cjk']", "#j_chapterContent", ".read-content", ".chapter-content"]
```

Từ phần tử đó nó trả về một object gồm:

| Trường            | Ý nghĩa                                                        |
| ----------------- | ------------------------------------------------------------- |
| `left`, `width`   | Vị trí và bề rộng khối nội dung (để cắt theo trục X)          |
| `top`, `height`   | Đỉnh tuyệt đối + `scrollHeight` (fallback khi không có `<p>`) |
| `firstPTop`       | Tọa độ Y tuyệt đối của đỉnh đoạn `<p>` đầu tiên               |
| `lastPBottom`     | Tọa độ Y tuyệt đối của đáy đoạn `<p>` cuối cùng              |
| `paragraphBottoms`| Mảng tọa độ đáy của **từng** đoạn `<p>` (để snap điểm cắt)    |

Tọa độ đều cộng `window.scrollY` để thành tọa độ **tuyệt đối trong tài liệu**,
khớp với hệ tọa độ mà `captureBeyondViewport` dùng. Nếu không tìm thấy phần tử nào,
hàm trả về `[]` (không chụp).

### Pha 3 — Tính vùng crop

```js
const cropX = (info.left  > 0) ? info.left  : FALLBACK_CROP_X;  // 600
const cropW = (info.width > 0) ? info.width : FALLBACK_CROP_W;  // 695
```

- Ưu tiên dùng đoạn `<p>` đầu/cuối làm biên dọc: `startY = firstPTop - SAFE_PADDING`,
  `endY = lastPBottom + SAFE_PADDING` (`SAFE_PADDING = 20`).
- Nếu trang không có `<p>`, lùi về dùng `top` / `height` của khối.
- `totalH = endY - startY`; nếu `<= 0` thì bỏ qua.

### Pha 4 — Chụp theo từng đoạn (chunked capture)

Ảnh quá cao dễ vượt giới hạn của trình duyệt, nên nội dung được cắt thành nhiều
"chunk" cao tối đa `CHUNK_H = 1400px`. Vòng lặp chạy từ `startY` tới `endY`:

1. **Snap điểm cắt theo đáy đoạn văn.** Để không cắt ngang một dòng chữ, điểm cắt
   được "snap" về đáy đoạn `<p>` gần nhất nằm trong khoảng
   `[y + CHUNK_H*MIN_CHUNK_RATIO, y + CHUNK_H]` (`MIN_CHUNK_RATIO = 0.55`) qua hàm
   `pickLastInRange`. Nếu không có đoạn nào phù hợp thì cắt thẳng tại `CHUNK_H`.

2. **Vùng chồng lấn (overlap).** Từ chunk thứ hai trở đi, điểm bắt đầu chụp được
   kéo lùi `OVERLAP_H = 120px` so với điểm cắt trước. Phần chồng này giúp OCR phía
   backend ghép/khử trùng lặp văn bản giữa các ảnh mà không mất dòng ở mép.

3. **Gọi CDP chụp** qua `captureWithRetry`:

   ```js
   Page.captureScreenshot({
     format: 'jpeg',
     quality: JPEG_QUALITY,          // 95
     captureBeyondViewport: true,    // chụp cả phần ngoài viewport
     clip: { x: cropX, y: captureY, width: cropW, height: captureH, scale: 1 },
   })
   ```

   Có cơ chế thử lại tối đa `MAX_RETRY = 2` lần, mỗi lần chờ tăng dần
   (`300ms * attempt`).

4. Kết quả base64 được bọc thành data URL `data:image/jpeg;base64,...` và đẩy vào
   mảng `shots`. Tiến độ thanh progress cập nhật tới ~80% trong pha này.

Hàm trả về mảng các data URL — mỗi phần tử là một ảnh JPEG của một đoạn chapter.

## Hằng số điều chỉnh (đầu `popup.js`)

| Hằng số            | Giá trị | Vai trò                                                   |
| ------------------ | ------- | --------------------------------------------------------- |
| `FALLBACK_CROP_X`  | 600     | Tọa độ X dự phòng khi không đo được `left`                |
| `FALLBACK_CROP_W`  | 695     | Bề rộng dự phòng khi không đo được `width`                |
| `CHUNK_H`          | 1400    | Chiều cao tối đa mỗi ảnh chunk (px)                       |
| `OVERLAP_H`        | 120     | Độ chồng lấn giữa các chunk liên tiếp (px)               |
| `SAFE_PADDING`     | 20      | Đệm thêm ở biên trên/dưới (px)                            |
| `JPEG_QUALITY`     | 95      | Chất lượng JPEG (0–100)                                   |
| `MAX_RETRY`        | 2       | Số lần thử lại khi `captureScreenshot` lỗi                |
| `PRE_SETTLE_MS`    | 600     | Chờ sau khi cuộn xuống đáy (ổn định DOM)                  |
| `POST_SCROLL_MS`   | 400     | Chờ sau khi cuộn về đầu                                   |
| `MIN_CHUNK_RATIO`  | 0.55    | Ngưỡng tối thiểu để chấp nhận snap điểm cắt theo `<p>`    |
| `EXPORT_BASE_DIR`  | `data/vietphase` | Thư mục gốc (trong Downloads) để lưu ảnh/text   |
| `DEFAULT_SERVER`   | `http://localhost:9999` | Server mặc định cho nút "Gửi text → server" |

## Ba nút thao tác trong popup

Popup ([`popup.html`](../popup.html)) có 3 nút. **Chỉ nút đầu tiên dùng cơ chế
chụp ảnh CDP ở trên**; hai nút còn lại đi theo luồng trích xuất text (xem phần
sau). Cả ba đều chỉ chạy khi tab đang mở URL chứa `qidian.com/chapter/`, và đều
dùng chung ô **Novel Slug** để đặt tên thư mục lưu.

- **`📷 Chụp ảnh → .jpg`** — `btnCapture`: gọi `captureChapter(tab.id)` rồi lưu
  từng ảnh ra `Downloads/` qua `chrome.downloads.download`, đường dẫn dạng
  `data/vietphase/<slug>/<số-chương>/<tên>_NN.jpg`. Đây là đường **dự phòng** khi
  trang dùng font mã hóa, không lấy được text sạch. Số chương suy ra từ tiêu đề
  tab qua `extractChapterNumber`.

- **`📋 Copy text → .txt`** — `btnCopyTxt`: chạy `extractTextFromPage` để đọc
  `innerText`, làm sạch bằng `cleanExtractedText`, rồi tải file `.txt` về cùng
  cây thư mục `data/vietphase/<slug>/<số-chương>/<tên>.txt`. Nếu phát hiện font
  mã hóa (`garbled`) thì báo người dùng chuyển sang nút chụp ảnh.

- **`🚀 Gửi text → server`** — `btnSendServer`: cũng trích xuất text như trên
  nhưng thay vì tải về Downloads thì `POST` multipart (`novel_slug` + file
  `.txt`) lên `${Server URL}/api/chapters/upload`. Server URL lấy từ ô nhập
  (mặc định `http://localhost:9999`, bỏ dấu `/` cuối). Bắt buộc nhập Novel Slug
  trước khi gửi; phản hồi phải là JSON, nếu không sẽ báo lỗi cấu hình URL.

> Extension **không còn** luồng OCR/EventSource/auto-translate như bản cũ. OCR
> ảnh chụp (nếu cần) do công cụ/back-end bên ngoài đảm nhận, không nằm trong
> extension.

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

## Tóm tắt vì sao dùng CDP thay vì API thông thường

| Vấn đề                                  | Cách extension giải quyết                                 |
| --------------------------------------- | --------------------------------------------------------- |
| Nội dung dài hơn viewport               | `captureBeyondViewport: true` (chụp ngoài màn hình)       |
| Chỉ muốn cắt đúng khối chữ              | Đo `left/width` + biên `<p>` đầu/cuối từ DOM thật         |
| Ads động làm DOM nhảy chiều cao        | Pre-scroll + chờ `PRE_SETTLE_MS`/`POST_SCROLL_MS`         |
| Ảnh quá cao gây lỗi/giới hạn trình duyệt | Cắt thành chunk cao tối đa `CHUNK_H`                      |
| Cắt ngang dòng chữ làm hỏng OCR        | Snap điểm cắt về đáy `<p>` + chồng lấn `OVERLAP_H`        |
| Lỗi chụp tạm thời                       | `captureWithRetry` thử lại tới `MAX_RETRY` lần            |
