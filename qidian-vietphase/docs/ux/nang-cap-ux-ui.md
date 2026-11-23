# Nâng cấp UX/UI VietPhase — T-950d2566

Tài liệu rà soát, nghiên cứu và định hướng thiết kế cho VietPhase (read.aico.io.vn).
Ưu tiên trải nghiệm **đọc truyện đã dịch**; phần làm việc (dịch, OCR, thuật ngữ) gọn và nhất quán.
Giao diện và văn bản tiếng Việt. Chữ Hán chỉ ở nội dung truyện/thuật ngữ.

**Phạm vi ticket:** tokens sáng/tối, chế độ đọc, `/login`, khung app (route/theme/shell), sửa lỗi nặng, áp component cho các màn làm việc.
**Không đổi:** API `/api/*`, logic dịch/OCR, định dạng dữ liệu, bảo vệ Esc/⌘←→ khi đang gõ, confirm bỏ bản sửa dở, lưu `novel.md` theo `version` (409).

---

## 1. Quyết định đã chốt (Q1–Q12)

| # | Quyết định |
|---|---|
| **Q1** | `#/<slug>/output/<n>` là chương đang đọc, **không** mở overlay. Overlay từ màn đọc: `#/<slug>/output/<n>/doi-chieu` (pushState; Back đóng overlay về màn đọc). Tab khác giữ hành vi cũ (`#/<slug>/chapters/3` vẫn mở overlay). Chuyển chương khi đọc dùng `replaceState`. |
| **Q2** | Có tiến độ → mở tiếp chỗ đã đọc. Chưa có → mở chương `done` đầu tiên. |
| **Q3** | Trước/sau bỏ qua chương chưa dịch. Mục lục chỉ liệt kê chương `done`. |
| **Q4** | Dấu nhỏ «chưa duyệt» chỉ trong mục lục, kèm chữ (không phụ thuộc màu). |
| **Q5** | Không thêm webfont mới. Font đọc có chân: `Noto Serif` (+ Georgia, Times New Roman). Không chân: `system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial`. Tweak `fontReading` là nguồn duy nhất; bảng Aa sửa cùng giá trị. `@import` Google Fonts (không SRI) → ticket sau (tự host). |
| **Q6** | Lưu `{ num, filename, para, frac, at }`: `para` = chỉ số đoạn đầu đang thấy; `frac` dự phòng. Khôi phục theo `para` trước. |
| **Q7** | Cài đặt đọc dùng chung mọi truyện: `vp:reader:prefs:v1`. |
| **Q8** | Theme app: Hệ thống / Sáng / Tối (`data-theme`, khoá `vp:theme`). Nền đọc: Theo giao diện / Sáng / Sepia / Tối — sepia chỉ vùng đọc. |
| **Q9** | Nặng + sửa trong ticket: lỗi chèn vào nội dung, «Lọc» vô tác dụng, «Đã lưu ✓» sai nghĩa. «Phút đọc» giữ, tính theo âm tiết/250, bỏ «ký tự» (mức nhẹ). |
| **Q10** | Mỗi dòng không rỗng = một đoạn (tách `\n`, bỏ dòng trống). Bỏ drop cap. |
| **Q11** | Phím ←/→ trong màn đọc. Không kích hoạt khi có modifier, đang `INPUT`/`TEXTAREA`/`SELECT`/`contenteditable`, hoặc overlay mở (`suspendKeys`). |
| **Q12** | Ưu tiên lỗi chặn luồng đọc và sửa bản dịch. Phần còn lại → «Để ticket sau». |

---

## 2. Nghiên cứu ngắn

### 2.1 App / web đọc truyện

Tham chiếu hành vi phổ biến (Apple Books, Kindle/Amazon, Google Play Books, Wattpad, WebNovel reader, Moon+ / Lithium kiểu Android):

| Khía cạnh | Thực tế tốt | Áp vào VietPhase |
|---|---|---|
| **Bố cục đọc** | Cột hẹp (~60–80 ký tự / ~65–70ch), lề rộng, ít chrome khi đang đọc | `--measure: 68ch`; mobile ẩn topbar/tabs khi `data-reading` |
| **Tuỳ chỉnh** | Cỡ chữ, giãn dòng, nền sáng / tối / sepia; lưu theo thiết bị | Bảng Aa; `vp:reader:prefs:v1` (try/catch) |
| **Điều hướng** | Mục lục, trước/sau, vuốt hoặc phím; cuối chương gợi ý chương tiếp | Mục lục `done`; ←/→; khối «Chương sau ›» |
| **Nhớ vị trí** | Chương + vị trí cuộn theo sách; mở lại đúng chỗ | `vp:reader:progress:v1:<slug>` (`para` + `frac`) |
| **Mobile** | Toàn màn hình, vùng chạm lớn, thanh ẩn khi cuộn xuống | Drawer mục lục; nút ≥44px; thanh ẩn/hiện |
| **Trạng thái** | Loading / lỗi / trống tách khỏi nội dung | `StatusBlock`; không ghi lỗi vào `content` |

Nguồn tham khảo công khai: [Apple Human Interface — Reading](https://developer.apple.com/design/human-interface-guidelines/reading); thực hành typography đọc dài (line length ~45–75 ký tự, WCAG 1.4.3 tương phản ≥4.5:1); `prefers-reduced-motion` (WCAG 2.3.3).

### 2.2 Công cụ dịch / đối chiếu song ngữ

Tham chiếu: DeepL Desktop (song song đoạn), MateCat / OmegaT (segment), LingQ / Readlang (highlight + chú thích), overlay hiện tại VietPhase (Ảnh | Bản gốc | Bản dịch):

| Khía cạnh | Thực tế tốt | Giữ / nâng trong ticket |
|---|---|---|
| **Đối chiếu đoạn** | Cột song song, đoạn căn theo đơn vị dịch | Giữ 3 cột; không đổi luồng sửa |
| **Sửa tại chỗ** | Lưu rõ trạng thái; hủy có confirm nếu dở | Giữ Esc/⌘←→ khi gõ; confirm đóng |
| **Thuật ngữ từ bôi đen** | Thêm nhanh không rời ngữ cảnh | Giữ luồng gloss hiện có |
| **Điều hướng chương** | Trước/sau không phá bản đang sửa | Giữ `guardedPrev`/`guardedNext` |

Ticket này **không** redesign sâu overlay; chỉ áp token/component và sửa lỗi nặng liên quan khung (route đọc vs overlay — Q1).

---

## 3. Bảng vấn đề (Nielsen)

Heuristic: **H1** Hiện trạng hệ thống · **H2** Khớp thế giới thật · **H3** Kiểm soát người dùng · **H4** Nhất quán · **H5** Phòng lỗi · **H6** Nhận diện hơn nhớ · **H7** Linh hoạt · **H8** Thẩm mỹ & tối giản · **H9** Nhận diện / phục hồi lỗi · **H10** Trợ giúp.

Cột **Đầu việc:** W2 tokens/style · W3 đọc · W4 login · W5 khung · W6 màn làm việc + cập nhật tài liệu.

### 3.1 Màn đọc (`output.jsx` + `.reader*`)

| Heuristic | Mức | Mô tả | Hướng sửa | Đầu việc |
|---|---|---|---|---|
| H1, H9 | **Nặng** | Lỗi tải ghi vào `content` → Sao chép / .txt lấy luôn dòng lỗi | State lỗi riêng + `StatusBlock`; vô hiệu copy/download khi lỗi/đang tải | W3 |
| H1, H2 | **Nặng** | «Đã lưu ✓» hiện khi chỉ đọc (không có thao tác lưu) | Bỏ nhãn | W3 |
| H4, H8 | **Nặng** | Nút «Lọc» không làm gì | Bỏ nút | W3 |
| H3, H7 | **Nặng** | ≤768px `.reader-sidebar { display:none }` — điện thoại **không có mục lục** | Drawer/bottom sheet mục lục; thanh dưới Trước \| Mục lục \| Sau | W3, W5 |
| H4 | **Nặng** | Chữ phụ `--fg-4` (~4.2:1) / `--fg-5` (~2.7:1) trên nền tối trượt WCAG AA | Sửa token tối + theme sáng; script `check-contrast.mjs` | W2 |
| H3 | Trung bình | Nút trước/sau không `disabled` ở đầu/cuối danh sách | `disabled` + `aria-disabled` + kiểu riêng; bỏ qua chưa dịch | W3 |
| H7 | Trung bình | Không tuỳ chỉnh cỡ chữ / giãn dòng / nền; không nhớ vị trí | Bảng Aa + localStorage prefs/progress | W3 |
| H5 | Trung bình | Drop cap `charAt(0)` có thể tách sai dấu tổ hợp tiếng Việt | Bỏ drop cap; tách đoạn theo `\n` | W3 |
| H6 | Trung bình | Lần đầu mở chương **mới nhất** thay vì đầu danh sách `done` | Q2: tiến độ hoặc chương `done` đầu | W3 |
| H1 | Trung bình | Đổi truyện lúc `chapters=[]` dễ báo «Chưa có chương nào được dịch» | `chaptersStatus` loading/ready/error | W5, W3 |
| H4 | Nhẹ | «Phút đọc» theo từ tiếng Anh + hiện «ký tự» | Âm tiết/250; bỏ «ký tự» | W3 |
| H3 | Nhẹ | Mục lục / item là `div onClick`, khó bàn phím | Button / focus rõ trong mục lục mới | W3 |

### 3.2 Màn chương (`chapters.jsx`)

| Heuristic | Mức | Mô tả | Hướng sửa | Đầu việc |
|---|---|---|---|---|
| H4 | **Nặng** | Phụ thuộc `--fg-4`/`--fg-5` và một số `--gray-*` / màu cứng — tương phản & theme sáng | Token vai trò + class component | W2, W6 |
| H1 | Trung bình | Trạng thái rỗng/lỗi chưa thống nhất (`StatusBlock`) | Dùng `StatusBlock` | W6 |
| H8 | Trung bình | Toolbar nhiều nút (Upload, OCR, Quét, Dịch…) dễ rối trên mobile | Giữ hành vi; xếp lại khoảng cách/chip theo token; không đổi API | W6 |
| H4 | Nhẹ | Nút «Tải xuống» / «more» khi chọn hàng gần như trang trí | Ticket sau hoặc ẩn nếu chưa có hành vi | Sau |

### 3.3 Đối chiếu (`translation_view.jsx`)

| Heuristic | Mức | Mô tả | Hướng sửa | Đầu việc |
|---|---|---|---|---|
| H4 | **Nặng** | Hash `#/.../output/<n>` hiện mở overlay cho mọi tab có số chương — xung đột với chế độ đọc | Q1: chỉ `/doi-chieu` mở overlay từ tab đọc | W5 |
| H4 | Trung bình | Màu phụ / chip dùng fg thấp tương phản | Token + component | W2, W6 |
| H7 | Nhẹ | Zoom ảnh / OCR menu dày trên màn hẹp | Giữ; kiểm không cuộn ngang 360px | W6 |
| — | — | Guard Esc/⌘←→ và confirm khi sửa — **giữ nguyên** | Không đụng | — |

### 3.4 Thuật ngữ (`glossary.jsx`)

| Heuristic | Mức | Mô tả | Hướng sửa | Đầu việc |
|---|---|---|---|---|
| H4 | **Nặng** | Chữ phụ `--fg-5` trên nền tối; thiếu theme sáng | Token + class | W2, W6 |
| H1 | Trung bình | Bảng trống chỉ một dòng chữ, không có CTA rõ | `StatusBlock` empty | W6 |
| H3 | Nhẹ | Một số điều khiển nhỏ (`icon-btn` 34px trên mobile) | `@media (pointer: coarse)` ≥44px | W2 |

### 3.5 Story-Wiki (`wiki.jsx`)

| Heuristic | Mức | Mô tả | Hướng sửa | Đầu việc |
|---|---|---|---|---|
| H4 | **Nặng** | Nhiều `span onClick` chọn thực thể — không focus bàn phím; fg-4/5 yếu | Đổi `button`/`a`; token | W6 |
| H1 | Trung bình | Empty / «chọn thực thể» chưa theo `StatusBlock` | `StatusBlock` | W6 |
| H6 | Nhẹ | Lọc loại bằng chip; trạng thái lọc ít `aria` | `aria-pressed` / nhãn rõ | W6 |

### 3.6 Cài đặt (`settings.jsx`)

| Heuristic | Mức | Mô tả | Hướng sửa | Đầu việc |
|---|---|---|---|---|
| H4 | **Nặng** | Phụ thuộc token fg yếu; chưa có chọn theme app trên UI chính (theme chỉ qua đọc sau này ở TopBar) | Token; nút theme ở TopBar (W5) | W2, W5, W6 |
| H9 | Trung bình | Xung đột `version` (409) đã có — cần giữ UX dialog rõ | Giữ logic 409; chỉ đồng bộ style | W6 |
| H8 | Nhẹ | Editor mono dài trên mobile | `overflow-wrap`; không cuộn ngang | W2, W6 |

### 3.7 Đăng nhập (`/login` — `backend/main.py`)

| Heuristic | Mức | Mô tả | Hướng sửa | Đầu việc |
|---|---|---|---|---|
| H4 | **Nặng** | HTML inline nền xám nhạt `#f5f5f4`, không dùng `tokens.css` — lệch hoàn toàn với app tối | Link `/static/tokens.css` + CSS token; script `vp:theme` | W4 |
| H9 | Trung bình | Lỗi «Sai token» ngắn, không `role="alert"` | Câu tiếng Việt rõ + `role="alert"` | W4 |
| H2 | Trung bình | Input thiếu `<label>`; placeholder tiếng Anh «API token» | `<label>` + `autocomplete` | W4 |
| H3 | Nhẹ | Chưa tôn trọng reduced-motion / focus ring theo hệ thống app | CSS focus + reduced-motion | W4 |

### 3.8 Khung chung (shell / styles / tokens) — ảnh hưởng mọi màn

| Heuristic | Mức | Mô tả | Hướng sửa | Đầu việc |
|---|---|---|---|---|
| H3 | **Nặng** | Mục truyện và «Tìm & lệnh» trong rail là `div onClick` — **không dùng được bàn phím** | Đổi `<button>` | W5 |
| H3 | **Nặng** | `.input-field` / nhiều ô đặt `outline: none` **không** có `:focus-visible` thay thế rõ | `:focus-visible` toàn cục + `--focus-ring` | W2 |
| H7 | **Nặng** | **Không có** `@media (prefers-reduced-motion: reduce)` | Khối reduced-motion toàn cục; reader không trượt khi reduce | W2, W3 |
| H4 | **Nặng** | `tokens.css` dark-only; `--fg-4`/`--fg-5` dưới AA | Theme light + sửa fg | W2 |
| H4 | Trung bình | Tab «Bản dịch» không phản ánh việc đọc; thiếu `aria-current` | Đổi nhãn «Đọc»; `aria-current` | W5 |
| H3 | Trung bình | `.icon-btn` mobile 34px &lt; 44px | Coarse pointer ≥44px; `--tap-min` | W2 |

---

## 4. Định hướng thị giác

### 4.1 Màu

- **App:** nền trung tính lạnh (xám gần đen / xám rất nhạt), accent indigo giữ từ hệ hiện tại (`data-accent` vẫn hoạt động ở cả hai theme).
- **Vai trò:** mọi UI dùng `--bg-*`, `--fg-1..5`, `--border*`, `--accent*`, `--success/warn/danger(-bg)` — không gọi `--gray-*` / `--indigo-*` trực tiếp ngoài `tokens.css`.
- **Đọc:** bốn nền (auto / light / sepia / dark) qua `--reader-{light|sepia|dark}-*`; sepia ấm nhẹ chỉ vùng đọc, không đổi chrome app.
- **Tương phản:** chữ thường và chữ phụ ≥ **4.5:1** (WCAG AA); kiểm bằng `frontend/tools/check-contrast.mjs`.

### 4.2 Typography tiếng Việt

- **UI:** Geist / system (`--font-ui`) — nhãn, bảng, nút.
- **Đọc có chân:** Noto Serif (đã `@import`) — phủ tốt dấu Việt; dự phòng Georgia, Times New Roman → token `--font-reading-serif`.
- **Đọc không chân:** system stack → `--font-reading-sans`.
- **Độ dài dòng:** `max-width: var(--measure)` (= 68ch); `line-height` đọc 1.5–2.1 (mặc định 1.9); cỡ 14–28px (mặc định 18).
- **Tránh:** drop cap; phụ thuộc `charAt` Unicode; webfont mới trong ticket này.

### 4.3 Icon

- Giữ bộ `Icon` SVG hiện có; bổ sung: `sun`, `moon`, `monitor`, `type`, `menu`, `refresh`, `wifiOff`.
- Icon thiếu → `null` (không vỡ layout).
- Kích thước chạm: vùng bấm ≥ `--tap-min` (44px) trên pointer coarse.

### 4.4 Chuyển động

- Giữ thang `--dur-fast` / `--dur` / `--dur-slow` + `--ease`.
- Dùng chuyển động có chủ đích: mở/đóng drawer mục lục, ẩn/hiện thanh đọc mobile.
- **`prefers-reduced-motion: reduce`:** tắt transition/animation (≈0); thanh đọc ẩn/hiện tức thì, không trượt.

---

## 5. Design tokens (hợp đồng §2)

W2 viết vào `tokens.css`; W3–W6 chỉ tiêu thụ.

### 5.1 Theme app

| Token | Vai trò | Ghi chú |
|---|---|---|
| `--bg-app` | Nền toàn app | `:root` tối; `:root[data-theme="light"]` sáng |
| `--bg-surface` | Surface / rail / panel | |
| `--bg-elevated` | Nâng nhẹ (hover, toolbar) | |
| `--bg-input` | Ô nhập | |
| `--fg-1` … `--fg-5` | Chữ chính → phụ | Mọi cặp chữ/nền khai báo ≥4.5:1 |
| `--border`, `--border-hover`, `--border-focus` | Viền | |
| `--accent`, `--accent-fill`, `--accent-fill-hover` | Brand | `data-accent` đúng cả hai theme |
| `--success`, `--success-bg`, `--warn`, `--warn-bg`, `--danger`, `--danger-bg` | Trạng thái | |
| `--focus-ring` | Viền focus nhìn thấy | Dùng với `:focus-visible` |
| `--tap-min` | `44px` | Vùng chạm tối thiểu |
| `--measure` | `68ch` | Độ rộng cột đọc |

### 5.2 Font đọc

| Token | Giá trị định hướng |
|---|---|
| `--font-reading-serif` | `'Noto Serif', Georgia, 'Times New Roman', serif` |
| `--font-reading-sans` | `system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` |

### 5.3 Bảng màu vùng đọc

| Token | Dùng cho |
|---|---|
| `--reader-light-bg`, `--reader-light-fg`, `--reader-light-muted`, `--reader-light-border`, `--reader-light-accent` | Nền sáng |
| `--reader-sepia-bg`, `--reader-sepia-fg`, `--reader-sepia-muted`, `--reader-sepia-border`, `--reader-sepia-accent` | Sepia |
| `--reader-dark-bg`, `--reader-dark-fg`, `--reader-dark-muted`, `--reader-dark-border`, `--reader-dark-accent` | Tối |

### 5.4 Giữ tên hiện có

Thang **bo góc** (`--radius-sm` … `--radius-pill`), **khoảng cách** (`--space-1` … `--space-12`), **chuyển động** (`--dur*`, `--ease`) giữ nguyên tên.

### 5.5 Khoá localStorage (mọi truy cập try/catch)

| Khoá | Giá trị |
|---|---|
| `vp:theme` | `system` \| `light` \| `dark` |
| `vp:reader:prefs:v1` | `{ size: 14–28 (18), lh ∈ {1.5,1.7,1.9,2.1} (1.9), bg ∈ auto\|light\|sepia\|dark }` |
| `vp:reader:progress:v1:<slug>` | `{ num, filename, para, frac, at }` |

---

## 6. Quy tắc component

### 6.1 CSS (`styles.css` — W2)

| Class | Quy tắc |
|---|---|
| `.btn` | Biến thể `primary` / `secondary` / `ghost` / `danger`; kích thước `.sm` |
| `.icon-btn` | Nút chỉ icon; coarse ≥44px |
| `.chip` | Nhãn / lọc nhỏ |
| `.tab-btn` | Tab; kèm `aria-current` từ JSX |
| `.seg` | Segmented control (theme, nền đọc, …) |
| `.input-field` | Ô nhập; không xoá focus — dùng `:focus-visible` |
| `.card` | Nhóm nội dung khi cần tương tác/hiểu nhóm |
| `.status-block` | Khối loading / error / empty |
| `.skeleton` | Placeholder tải |
| `.sr-only` | Chỉ đọc bởi trình đọc màn hình |

Toàn cục:

- `:focus-visible` nhìn thấy được (không phụ thuộc `outline: none` trần).
- `@media (prefers-reduced-motion: reduce)`.
- `@media (pointer: coarse)` nâng `.icon-btn` / `.btn.sm`.
- Vùng văn bản dài: `overflow-wrap: anywhere`.
- **Xoá** mọi rule `.reader*` cũ; màn đọc dùng tiền tố `rd-` trong `reader.css`.

### 6.2 JSX dùng chung (`components.jsx` — W2)

- `StatusBlock({ kind: "loading"|"error"|"empty", title, desc, actions })`.
- Icon mới: `sun`, `moon`, `monitor`, `type`, `menu`, `refresh`, `wifiOff`.

### 6.3 Props `OutputScreen` (W3 viết, W5 truyền)

`key={currentSlug}` khi render.

```
chapters, chaptersStatus: "loading"|"ready"|"error",
onReloadChapters, novel,
routeChapter /* string|null */,
onReadChapter(num), onOpen(ch), onGoChapters(), onOpenRail(),
suspendKeys, fontMode, onFontMode(v)
```

### 6.4 Mobile đọc (W5 + W3)

- `.app[data-reading="true"]` khi `tab==="output"`.
- ≤768px: ẩn `.topbar` / `.tabs`; màn đọc tự có thanh trên (☰, ‹ Chương, tiêu đề, Mục lục, Aa) và dưới (‹ Trước | Mục lục | Sau ›).
- Thanh ẩn khi cuộn xuống, hiện khi cuộn lên/chạm; reduced-motion → không trượt.

---

## 7. Danh sách ưu tiên

### 7.1 Làm trong T-950d2566

| Ưu tiên | Việc | Đầu việc |
|---|---|---|
| P0 | Sửa tương phản `--fg-4`/`--fg-5`; theme sáng; tokens hợp đồng §2; focus; reduced-motion; tap 44px; xoá `.reader*`; `StatusBlock` + icon | W2 |
| P0 | Chế độ đọc đầy đủ (bố cục, Aa, mục lục mobile, trước/sau, nhớ vị trí, StatusBlock tải/lỗi/rỗng, bỏ Lọc/Đã lưu/drop cap, ←/→) | W3 |
| P0 | `/login` cùng phong cách; `seed_ux_demo.py` | W4 |
| P0 | Hash đọc vs overlay (Q1); `chaptersStatus`; theme TopBar; rail `button`; `data-reading`; nhãn tab «Đọc» | W5 |
| P1 | Áp token/component cho chương, đối chiếu, thuật ngữ, Wiki, cài đặt, cmdk; sửa lỗi nặng còn lại; kiểm headless; cập nhật mục §8 | W6 |

### 7.2 Để ticket sau

| Việc | Lý do tách |
|---|---|
| Đồng bộ tiến độ đọc giữa thiết bị | Ticket này đủ `localStorage` theo trình duyệt |
| Tự host font (bỏ `@import` Google Fonts không SRI) | Q5; tránh thêm hạ tầng CDN/build |
| Nút «Tải xuống» / «more» khi chọn chương (hiện gần như vô tác dụng) | Không chặn luồng đọc/sửa |
| Redesign sâu overlay đối chiếu (căn đoạn tự động, layout mới) | Q12; giữ luồng sửa hiện có |
| Vuốt ngang đổi chương trên mobile | Phức tạp gesture; đã có nút + phím |
| Đồng bộ prefs đọc theo tài khoản server | Chưa có API user prefs |
| i18n ngoài tiếng Việt | Repo quy định UI tiếng Việt |
| Favicon / `theme-color` tinh chỉnh theo OS thật | Kiểm trên thiết bị thật (người duyệt) |

---

## 8. Lỗi nặng đã sửa

> Mục để **W6** điền sau khi kiểm tổng. Mỗi dòng: mô tả ngắn · đầu việc đã sửa · ghi chú (hoặc lý do chưa sửa).

| Lỗi nặng | Trạng thái | Đầu việc | Ghi chú |
|---|---|---|---|
| Tương phản `--fg-4` / `--fg-5` (theme tối) | *chưa* | W2 | |
| Mobile không có mục lục (`.reader-sidebar` ẩn) | *chưa* | W3 / W5 | |
| Lỗi tải chèn vào nội dung (copy/.txt) | *chưa* | W3 | |
| Nút «Lọc» vô tác dụng | *chưa* | W3 | |
| «Đã lưu ✓» sai nghĩa trên màn chỉ đọc | *chưa* | W3 | |
| Rail / «Tìm & lệnh» không dùng được bàn phím | *chưa* | W5 | |
| Không có `prefers-reduced-motion` | *chưa* | W2 / W3 | |
| Focus bị ẩn (`outline: none` thiếu thay thế) | *chưa* | W2 | |
| `/login` lệch phong cách app | *chưa* | W4 | |
| Hash `#/.../output/<n>` mở overlay thay vì đọc | *chưa* | W5 | |
| Wiki / rail: phần tử bấm là `div`/`span` | *chưa* | W5 / W6 | |

---

## 9. Ghi chú kiểm tra môi trường

- **Agent W1:** rà soát bằng đọc code (`tokens.css`, `styles.css`, `output.jsx`, `shell.jsx`, `app.jsx`, các màn JSX, `_LOGIN_HTML`). Không chạy trình duyệt thật có thanh tab / thiết bị cảm ứng thật trong đầu việc này.
- **Không thử được (thiết bị/trình duyệt thật):** iOS Safari / Android Chrome (safe-area, notch, thanh ẩn khi cuộn cảm giác tay); mắt người đánh giá sepia/font trên màn hình vật lý; chế độ riêng tư chặn `localStorage`; zoom trình duyệt ảnh hưởng độ dài dòng — để người duyệt tự kiểm theo ticket.
- Repo **không có** `docs/architecture.md` / `docs/plans/` / sprint `docs/delivery/` tại thời điểm viết tài liệu này.
- File test tự động UX chưa có trong phạm vi W1; W2 thêm `check-contrast.mjs`; W4 thêm seed; W6 chạy checklist headless kế hoạch §4.

---

*Tài liệu tạo bởi đầu việc W1 — T-950d2566. Các đầu việc sau cập nhật §7.2 và §8 khi hoàn thành.*
