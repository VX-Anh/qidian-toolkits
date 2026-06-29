# Plan: Cải thiện phần "get text" của Qidian extension

> Đã được Codex review (có tra cứu internet). Các điểm chỉnh từ review được tích hợp vào bản này; xem mục
> "Ghi chú từ review" ở cuối.

## Context

Extension hiện lấy text chương qua `extractTextFromPage()` trong `popup.js`: chạy
`chrome.scripting.executeScript` rồi đọc `innerText` của 5 selector, lấy chuỗi dài nhất. Đây là **một lớp duy
nhất** và có một điểm yếu nghiêm trọng: **không phát hiện được trường hợp Qidian dùng custom font / Private
Use Area (PUA)**. Khi Qidian render chữ Hán bằng font tùy biến — nhìn bằng mắt thì đúng, nhưng `innerText` trả
ra ký tự PUA (`U+E000–U+F8FF` và Supplementary PUA) lộn xộn. Khi đó extension vẫn tưởng lấy thành công (chỉ
check `length < 50`) và **lưu/gửi text rác**.

> Lưu ý: KHÔNG khẳng định cứng "Qidian hiện nay luôn dùng cơ chế X". Mục tiêu là **phát hiện và ứng phó** khi
> gặp font obfuscation/PUA, xác nhận bằng DevTools trên chương thật đã đăng nhập (xem Verification).

Script tham chiếu `D:\TVPL\PRO\qidian-toolkits\qidian-extraction.py` (Playwright, standalone) gợi ý hướng:
- `looks_garbled()` — đếm tỉ lệ ký tự PUA để phát hiện font rối.
- `extract_chapter_text()` — nhiều lớp ưu tiên text sạch: (1) đọc biến JS đã giải mã (`window.content`,
  `window.__NUXT__`), (2) `innerText` nhiều selector, (3) OCR fallback.

Quyết định (đã chốt): **nâng cấp extension tại chỗ** — đưa cả phát hiện PUA lẫn nhiều lớp lấy text vào
`popup.js`, **không đổi kiến trúc** (vẫn là popup + content script, không thêm build step).

## Khác biệt kỹ thuật then chốt (phải xử lý đúng)

Script `.py` dùng `page.evaluate` chạy ở **page context (main world)** nên đọc được `window.content`. Còn
extension hiện gọi `executeScript({ func })` mặc định chạy ở **isolated world** của content script — **KHÔNG**
thấy biến JS context của trang. Vì vậy lớp "đọc biến JS đã giải mã" chỉ hoạt động nếu chạy với
**`world: "MAIN"`** (chrome.scripting hỗ trợ từ Chrome 95+, manifest v3). Đây là điểm bản port ngây thơ sẽ
thất bại âm thầm.

**Cảnh báo khi dùng `world: "MAIN"`** (từ Codex review):
- `func` bị serialize rồi chạy lại trong page → **mất closure**. Helper (vd `analyzeText`) phải **nằm bên
  trong** injected function, hoặc truyền qua `args`. Không tham chiếu biến ngoài.
- **Kết quả trả về phải serialize được** (structured-clone). Không trả DOM node, FontFaceSet, object vòng lặp
  — chỉ trả string/number/plain object.
- MAIN world dùng chung môi trường với page → page có thể monkey-patch `JSON.stringify`, `Array.prototype`…
  Với công cụ cá nhân thì chấp nhận được, nhưng code nên defensive (bọc try/catch từng bước).
- MAIN **không cần quyền mới** nếu đã có `scripting` + host permission/`activeTab`.

## Thiết kế giải pháp

Pipeline trong `extractTextFromPage()` áp dụng cho **cả** nút Copy text (`btnCopyTxt`) và Gửi server
(`btnSendServer`) vì cả hai cùng gọi hàm này. Mỗi lớp trả candidate kèm **metrics** để chấm điểm & debug.

### Lớp 0 — phân tích chất lượng text (`analyzeText`, thay cho `looksGarbled` đơn giản)
Heuristic cũ (`(o>=0xE000 && o<=0xF8FF) || o>0x2FA1F`, chia cho `text.length`) có 3 điểm yếu: bỏ sót
Supplementary PUA, ngưỡng `>0x2FA1F` quá rộng (gom nhầm CJK ext/emoji), và bị pha loãng bởi whitespace. Thay
bằng:

```js
function analyzeText(text) {
  let total = 0, pua = 0, suspicious = 0, cjk = 0;
  for (const ch of text || '') {
    if (/\s/.test(ch)) continue;            // tính trên ký tự non-whitespace
    total++;
    const cp = ch.codePointAt(0);
    const isPua =
      (cp >= 0xE000 && cp <= 0xF8FF) ||      // BMP PUA
      (cp >= 0xF0000 && cp <= 0xFFFFD) ||    // Supplementary PUA-A
      (cp >= 0x100000 && cp <= 0x10FFFD);    // Supplementary PUA-B
    const isCjk =
      (cp >= 0x3400 && cp <= 0x9FFF) ||      // CJK + Ext A
      (cp >= 0x20000 && cp <= 0x323AF);      // CJK Ext B..H
    if (isPua) pua++;
    else if (!isCjk && cp > 0xFFFF) suspicious++;
    if (isCjk) cjk++;
  }
  const puaRatio = total ? pua / total : 1;
  return {
    total, pua, suspicious, cjk, puaRatio,
    garbled: total < 20 || puaRatio > 0.03 || (pua > 20 && cjk < pua),
  };
}
```
Trả cả metrics (`pua`, `cjk`, `puaRatio`) để log/debug, không chỉ một boolean.

### Lớp 1 — quét page context tìm candidate sạch (world: "MAIN")
**Không** đặt kỳ vọng riêng vào `__NUXT__`. Thay vào đó inject 1 func (world MAIN) thu thập **nhiều candidate**
rồi chấm điểm:
- `window.content` nếu là string.
- Quét `window` theo **whitelist/pattern key**: `content`, `chapter`, `read`, `initial`, `state` — **không**
  stringify toàn bộ `window`/toàn bộ `__NUXT__`.
- JSON nhúng: `<script type="application/json">`, `#__NEXT_DATA__`, hoặc script chứa initial state nếu có.
- Với object state: recursive walk **chỉ lấy string dài** (vd > 500 ký tự), lọc theo score: tỉ lệ CJK cao,
  PUA thấp, ít `{`/`":`/URL/HTML tag.
- Mỗi candidate chạy `analyzeText` → chọn candidate `!garbled` có điểm tốt nhất.

Nếu Lớp 1 ra text sạch → dùng luôn, **không cần chụp ảnh** ngay cả khi font hiển thị bị mã hóa. Đây là nâng
cấp giá trị nhất — nhưng là **best effort** (biến có thể bị dọn sau render / đổi tên), luôn có Lớp 2 + chụp ảnh
làm lưới an toàn.

### Lớp 2 — innerText nhiều selector, **chấm điểm từng selector** (không lấy chuỗi dài nhất)
"Chuỗi dài nhất" có thể là container gồm cả menu/comment/recommendation. Thay bằng: với mỗi selector lấy
`innerText`, chạy `analyzeText`, chọn theo score (ưu tiên `!garbled`, CJK cao, độ dài hợp lý). Selector hợp
nhất: `main[data-type='cjk']`, `#j_chapterContent`, `#j_chapterBox`, `.read-content`,
`.read-content.j_readContent`, `.chapter-content`, `main .content`, `main.content`.

### Lớp 3 — quyết định cuối
- Có candidate sạch (Lớp 1 hoặc 2) → trả `{ title, text, source, metrics, garbled: false }`.
- Chỉ có text rối → trả `{ title, text, source, metrics, garbled: true }` để popup **cảnh báo rõ ràng** và gợi
  ý nút Chụp ảnh (extension đã có chụp + OCR phía server — không nhồi OCR vào popup).

### Cập nhật nơi gọi (`btnCopyTxt`, `btnSendServer`)
Thay điều kiện `text.length < 50` bằng đọc cờ trả về:
- `garbled` → `setStatus("Trang dùng font mã hóa — hãy bấm '📷 Chụp ảnh' để OCR thay vì lấy text.")` và dừng.
- rỗng → thông báo như cũ.
- sạch → tiếp tục lưu/gửi như hiện tại.

## Các file sẽ sửa

- `qidian-extension/popup.js` — **chủ lực**:
  - Thêm `analyzeText()` (helper module-level dùng trong popup; bản copy đặt **trong** injected func cho Lớp 1
    vì MAIN world mất closure).
  - Viết lại `extractTextFromPage()` thành pipeline: `executeScript` lần 1 `world:"MAIN"` (quét candidate page
    context + chấm điểm), lần 2 mặc định (innerText + chấm điểm selector). Trả `{ title, text, source,
    metrics, garbled }`.
  - Cập nhật `btnCopyTxt` (~dòng 311) và `btnSendServer` để xử lý cờ `garbled`.
  - `cleanExtractedText()` giữ nguyên (lọc badge số + gộp dòng trống); chạy sau khi đã có text sạch.
  - **Debug log**: console.log `source` được chọn, `puaRatio`, selector, length — bật khi cần soi.
- `qidian-extension/manifest.json` — `scripting` đã có; `world:"MAIN"` không cần quyền mới; host permission
  qidian đã có. **Không cần đổi.**

## Rủi ro / lưu ý

- **Lớp 1 là best effort**: biến page có thể bị dọn sau render hoặc đổi tên → KHÔNG giả định luôn chạy.
- **Không stringify toàn bộ `__NUXT__`/`window`** (tốn bộ nhớ, dễ lấy nhầm metadata/HTML). Đi theo whitelist
  key + recursive walk có score.
- Không port OCR `ddddocr` vào extension: đã có luồng chụp ảnh → OCR phía server tốt hơn.
- Công cụ cá nhân cho truyện **đã mua** (như `.py` ghi rõ) — không đổi bản chất sử dụng.

## Verification

1. Load lại extension (chrome://extensions → Reload) sau khi sửa.
2. **(Bắt buộc) Xác nhận cơ chế bằng DevTools trên 2 chương thật đã đăng nhập:**
   - Một chương copy ra text sạch (CJK bình thường).
   - Một chương bị font obfuscation (hiển thị đúng nhưng copy ra PUA) — dùng để kiểm Lớp 1 + cảnh báo.
   - Trong Console thử các candidate (`window.content`, các `<script type=application/json>`…) để xác nhận
     nguồn nào còn lấy được text sạch.
3. Chương sạch → Copy text: lấy được text như trước (không hồi quy); kiểm preview + số ký tự + log `source`.
4. Chương font mã hóa:
   - Nếu Lớp 1 (MAIN) lấy được candidate sạch → ra text đúng (kỳ vọng tốt nhất), log `source` ≠ DOM.
   - Nếu không → extension **cảnh báo "dùng font mã hóa, hãy chụp ảnh"** thay vì lưu rác.
5. Nút Gửi server: lặp bước 3–4, xác nhận không gửi text rác lên backend.
6. Chương có badge số (段评) vẫn được `cleanExtractedText` lọc đúng.

## Ghi chú từ review (Codex, có tra internet)

- ✅ Xác nhận đúng: content script mặc định ở isolated world không đọc được biến page; cần `world:"MAIN"`.
  Nguồn: Chrome docs content-scripts & `chrome.scripting` (ExecutionWorld MAIN/ISOLATED).
- ✅ Xác nhận đúng: PUA `U+E000..U+F8FF` là nền kỹ thuật của custom-font obfuscation (Unicode PUA FAQ).
- ✏️ Chỉnh: hạ kỳ vọng `window.content`/`__NUXT__` → chỉ là candidate trong bước quét có score; `__NUXT__`
  không có bằng chứng công khai Qidian đang dùng, không nêu riêng với kỳ vọng cao.
- ✏️ Chỉnh: heuristic dùng `analyzeText` (thêm Supplementary PUA, bỏ ngưỡng `>0x2FA1F` quá rộng, tính trên
  non-whitespace, trả metrics).
- ✏️ Chỉnh: Lớp 2 chấm điểm từng selector thay vì lấy chuỗi dài nhất.
- ✏️ Thêm: cảnh báo `world:"MAIN"` (mất closure, kết quả phải serialize, page có thể monkey-patch) + debug log
  + verification bắt buộc bằng DevTools trên chương thật.
