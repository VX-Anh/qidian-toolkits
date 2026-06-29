# Plan: Giao diện responsive cho mobile — VietPhase frontend

## Context

Frontend VietPhase (`qidian-vietphase/frontend`) là một SPA **desktop-first thuần CSS**, không build step
(React UMD + Babel standalone qua CDN, FastAPI serve `/static`). Toàn bộ layout dùng CSS Grid với cột cố
định (rail 240px, activity rail 320px, các view chia 2-3 cột), `html,body { overflow: hidden }` toàn cục,
và **không có một `@media` query nào**. Vì vậy trên điện thoại, app hiện vỡ hoàn toàn: rail + main + activity
ép vào màn hình hẹp, bảng chương 7 cột tràn ngang, Translation View 3 cột không đọc được.

Mục tiêu (đã chốt với người dùng): **responsive toàn bộ** cả 5 tab + Translation View, dùng **CSS thuần
(media query)** là chính, giữ JS gần như nguyên. Đây là cách phù hợp nhất với codebase không build step —
mọi thứ làm được bằng cách thêm CSS vào `styles.css`/`tokens.css` và một vài thay đổi DOM nhỏ.

**Quyết định đã chốt:**
- Điều hướng mobile: **bottom tab bar** cố định đáy (5 tab, icon + count).
- Bảng chương mobile: **ẩn cột phụ thuần CSS** (giữ #, Tên Việt, Trạng thái, nút Mở) — không đụng JS.

Breakpoint chuẩn: **`@media (max-width: 768px)`** = mobile (1 cột); cân nhắc thêm `(max-width: 1024px)` cho
tablet (ẩn activity rail). Toàn bộ thay đổi nằm trong frontend, không đụng backend.

## Nguyên tắc chung

1. **Gom rule mobile vào một khối `@media (max-width: 768px) { ... }` ở cuối `styles.css`** — dễ đọc/bảo trì,
   không rải rác, không sửa rule gốc desktop (trừ chỗ `overflow` toàn cục buộc phải đảo trên mobile).
2. **Sụp grid về 1 cột**: mọi `grid-template-columns` nhiều cột → `1fr` trên mobile.
3. **Cho phép scroll dọc trên mobile**: `overflow:hidden` toàn cục (`styles.css:4`) phải được nới trên mobile,
   nếu không nội dung dài bị cắt. Đổi sang cho `body`/`.app` cao tự nhiên + scroll.
4. **Ẩn cái không thiết yếu trên mobile** thay vì cố nhồi: activity rail, một số nút phụ, cột bảng ít quan trọng.
5. **Tăng vùng chạm**: nút/tab tối thiểu ~40px chiều cao trên mobile (hiện nhiều nút chỉ 28-30px).

## Thay đổi theo khu vực

### 1. Nền tảng layout — `styles.css`
- `html, body` (dòng 4): trên mobile bỏ `overflow:hidden`, cho `height:auto`/scroll dọc.
- `.app` (dòng 106-114): mobile → `grid-template-columns: 1fr; grid-template-rows: auto 1fr; height: 100dvh`
  (dùng `100dvh` để tránh thanh địa chỉ mobile che nội dung).
- **Left rail → off-canvas drawer**: `.rail` (dòng 117) trên mobile thành drawer trượt từ trái
  (`position: fixed; transform: translateX(-100%)`, thêm class `.rail.open` để hiện + scrim overlay).
  Cần thêm 1 nút hamburger ở topbar (thay đổi DOM nhỏ — xem mục JS).

### 2. Topbar + Tabs (bottom bar) — `styles.css` + `shell.jsx`
- `.topbar` (dòng 253): mobile cho `flex-wrap` / giảm padding; ẩn `.crumb` dài, thu gọn `.search-pill`
  (dòng 283) thành chỉ icon (bỏ text + kbd; mobile không có phím ⌘K nhưng giữ icon để mở cmdk).
- `.tabs`/`.tab-btn` (dòng 322-359): mobile → **bottom tab bar** cố định đáy (`position: fixed; bottom: 0`),
  ẩn label, chỉ icon + (count), 5 tab chia đều. Chừa khoảng đáy cho toast + safe-area iOS.
- DOM: thêm nút hamburger vào `TopBar` (`shell.jsx:81`) — chỉ hiện trên mobile (ẩn bằng CSS ở desktop).

### 3. Chapters workbench — `styles.css` (bảng CSS-only)
- `.workbench` (dòng 434): mobile → 1 cột; **ẩn `.activity`** (dòng 441 đã có cơ chế `data-activity="hidden"`
  → mobile luôn ẩn bằng CSS).
- `.work-toolbar` (dòng 450) + `.work-filters` (dòng 459): mobile cho `flex-wrap: wrap`, nút rộng hơn,
  thanh tiến trình + status pills xuống hàng.
- **Bảng chương `.ch-table` (dòng 475)** — phương án CSS-only: ẩn cột checkbox, "Thuật ngữ", "Review",
  thu "Tên Trung"; giữ #, Tên Việt, Trạng thái, nút Mở. **Không cần sửa `ChapterRow` (`chapters.jsx:229`).**

### 4. Translation View (overlay) — `styles.css` + nhẹ `translation_view.jsx`
- `.tv-body` (dòng 647-654): mobile → luôn `grid-template-columns: 1fr` bất kể `data-cols`. Chuyển pane bằng
  `SegControl` đã có sẵn (Nguồn/Đối chiếu/Bản dịch). Trên mobile, "split"/"all" nên hiện 1 pane chính
  (ưu tiên Bản dịch), pane khác chọn qua SegControl.
- `.tv-head` (dòng 638): head rất dài → mobile `flex-wrap` + ẩn bớt nút phụ (Glossary toggle, Đưa-vào-Wiki
  có thể gom vào menu "…"), hoặc cho head cao 2 hàng. `.tv-pane-body` padding giảm (dòng 675: `24px 32px` → `16px`).
- `.filmstrip` (dòng 716) đã `overflow-x:auto` — ổn, chỉ giảm kích thước thumb.
- Popover thêm thuật ngữ `.term-form` (dòng 1476, width 320px): clamp `width: min(320px, calc(100vw - 24px))`;
  `AddTermForm` đã clamp `left` ở `translation_view.jsx:670`.

### 5. Glossary / Settings / Reader (Output) — `styles.css`
- `.glossary-layout` (dòng 1153, `200px 1fr`): mobile → 1 cột; `.glossary-tabs` (dòng 1159) thành thanh ngang
  scroll-x ở trên thay vì cột trái.
- `.settings-layout` (dòng 1241, `1fr 320px`): mobile → 1 cột, `.settings-side` (dòng 1299) xuống dưới cùng.
- `.reader` (dòng 924, `240px 1fr`): mobile → ẩn `.reader-sidebar` (dòng 931) hoặc biến thành drawer;
  `.reader-page` (dòng 990) giảm padding mạnh (`48px 64px` → `20px 16px`), giữ body ~16px cho dễ đọc.

### 6. Modal / Command palette / Toast — `styles.css`
- `.modal` (dòng 1038, width 460px): mobile → `width: min(460px, calc(100vw - 24px))`.
- `.cmdk` (dòng 1070) đã dùng `min(540px, calc(100vw - 40px))` — ổn, chỉ chỉnh `padding-top` scrim.
- `.toast` (dòng 1132): mobile → căn giữa/đáy, chừa khoảng cách để không đè bottom-tab bar.

## Các file sẽ sửa

- `frontend/src/styles.css` — **chủ lực**: thêm khối `@media (max-width: 768px)` (và có thể `1024px`) ở cuối,
  phủ tất cả khu vực trên. Phần lớn công việc nằm ở đây.
- `frontend/src/shell.jsx` — thêm nút hamburger vào `TopBar`; truyền prop mở/đóng rail drawer.
- `frontend/src/app.jsx` — thêm state `railOpen` + scrim; truyền xuống `LeftRail`/`TopBar`; đóng drawer khi
  chọn truyện. (Thay đổi nhỏ, cục bộ.)
- `frontend/index.html` — viewport meta **đã có sẵn** (dòng 5: `width=device-width, initial-scale=1`), không
  cần thêm. Có thể thêm `viewport-fit=cover` nếu xử lý safe-area iOS.
- (Tùy chọn) `frontend/src/translation_view.jsx` — mobile auto chọn 1 pane hợp lý (vd "translated" khi
  `max-width:768px`); làm thuần CSS trước, JS sau.

## Thứ tự thực hiện

1. **Nền tảng**: nới `overflow`, `.app` 1 cột + bottom-tab bar + rail drawer (shell.jsx + app.jsx + CSS).
   Làm xong là điều hướng mobile chạy được.
2. **Chapters** (tab mặc định): toolbar wrap, ẩn activity, bảng ẩn cột phụ (CSS-only).
3. **Translation View**: 1 pane + SegControl, head wrap, padding giảm.
4. **Glossary / Settings / Output**: sụp 1 cột, sidebar → thanh ngang/drawer.
5. **Modal / cmdk / toast** polish + tăng vùng chạm + safe-area.

## Verification (kiểm thử end-to-end)

1. Chạy server dev:
   `cd qidian-vietphase && uv run uvicorn backend.main:app --reload --reload-include "*.css" --reload-include "*.jsx" --port 9999`
   (đã xác nhận server chạy được; `/health` trả `{"status":"ok"}`).
2. Mở `http://127.0.0.1:9999`, bật **DevTools → Device Toolbar** (Ctrl+Shift+M), chọn iPhone/Pixel
   (vd 390×844) và một tablet (768×1024).
3. Kiểm từng mục:
   - Rail mở/đóng bằng hamburger, scrim đóng được; chọn truyện → drawer tự đóng.
   - Bottom-tab bar chuyển đủ 5 tab; không che nội dung/toast.
   - **Chapters**: không tràn ngang, mở được chương; toolbar không vỡ.
   - **Translation View**: chuyển pane bằng SegControl; đọc bản dịch thoải mái; thêm thuật ngữ từ bôi đen không
     tràn mép; chương ảnh (OCR) xem được ảnh + chuyển trang.
   - **Glossary/Settings/Output**: 1 cột, không có cột cố định tràn; reader đọc tốt.
   - Modal "Tạo truyện" + Command palette vừa màn hình.
4. Quay lại desktop (≥1280px) xác nhận **không hồi quy** layout cũ.
5. (Nếu có máy thật) mở qua `IP:9166` từ điện thoại để kiểm tap target + safe-area thực tế.

## Ghi chú / rủi ro

- **Không build step** → mọi `.jsx` chạy qua Babel standalone trên trình duyệt; chỉ cần reload, không cần bundler.
- `<table>` khó responsive nhất; phương án ẩn cột là đánh đổi an toàn cho bản đầu, có thể nâng lên card layout sau.
- `100dvh`/`dvh` + safe-area (`env(safe-area-inset-*)`) giúp iOS Safari không bị thanh địa chỉ che bottom-bar.
- Giữ desktop nguyên trạng: tất cả rule mobile nằm trong media query.
