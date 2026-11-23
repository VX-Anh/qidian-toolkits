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
| H4 | Nhẹ | Nút «Tải xuống» / «more» khi chọn hàng gần như trang trí | Đã bỏ hai nút không có hành vi (W6) | W6 |

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
| `.seg.inline` | Segmented control nằm trên thanh công cụ (`SegControl` của đối chiếu, Cài đặt) — W6 |
| `.chip-btn` | Chip lọc bấm được, trạng thái bằng `aria-pressed` (lọc trạng thái chương) — W6 |
| `.link-btn` | Nút trông như liên kết (mở chương, tên thực thể trong Wiki) — W6 |
| `.menu-pop` / `.menu-item` | Menu thả xuống (chọn engine OCR) — W6 |
| `.wiki-ent-item` / `.wiki-rel` / `.wiki-label` | Danh sách thực thể (nút, `aria-current`), dòng quan hệ, nhãn mục của Story-Wiki — W6 |

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
| Favicon / `theme-color` tinh chỉnh theo OS thật | Kiểm trên thiết bị thật (người duyệt). W6 chỉ gắn favicon SVG nội tuyến từ `app.jsx` để bản prod hết 404; nên thêm `<link rel="icon">` thật vào `index.html` (bản dev vẫn 404 vì Babel chạy sau khi trang nạp) |
| Lỗi mức **trung bình / nhẹ** chưa sửa (bảng §8.3) | Không chặn luồng đọc hay luồng sửa bản dịch (Q12) |

---

## 8. Lỗi nặng đã sửa

> W6 điền sau khi kiểm tổng (headless Chromium trên dữ liệu `seed_ux_demo.py`, cả bản dev và bản prod, 1280/384/360px, sáng và tối — xem §9). Cột **Kiểm** ghi mã TC trong kế hoạch.

### 8.1 Lỗi nặng ghi ở §3

| Lỗi nặng | Trạng thái | Đầu việc | Kiểm / ghi chú |
|---|---|---|---|
| Tương phản `--fg-4` / `--fg-5` (theme tối) | **Đã sửa** | W2 | TC9: `node frontend/tools/check-contrast.mjs` thoát 0 (mọi cặp ≥4.5:1, gồm 3 nền đọc). W6 thay nốt chữ phụ `--fg-5` trong các màn làm việc bằng `--fg-4` |
| Mobile không có mục lục (`.reader-sidebar` ẩn) | **Đã sửa** | W3, W5 | TC6/TC20: drawer mục lục, đóng sau khi chọn, focus vào nút đóng; thanh dưới Trước \| Mục lục \| Sau, nút ≥44×44px; `.topbar`/`.tabs` ẩn khi đọc ở ≤768px |
| Lỗi tải chèn vào nội dung (copy/.txt) | **Đã sửa** | W3 | TC22/TC23: lỗi và mất mạng hiện `StatusBlock` có «Thử lại», Sao chép/.txt bị khoá, clipboard không nhận dòng lỗi; có mạng lại thì tự tải |
| Nút «Lọc» vô tác dụng | **Đã sửa** | W3 | Đã bỏ nút |
| «Đã lưu ✓» sai nghĩa trên màn chỉ đọc | **Đã sửa** | W3 | Đã bỏ nhãn |
| Rail / «Tìm & lệnh» không dùng được bàn phím | **Đã sửa** | W5 | TC27: mục truyện là `<button>`, tab có `aria-current` |
| Không có `prefers-reduced-motion` | **Đã sửa** | W2, W3 | TC28: `transition/animation-duration` = 0s trên drawer mục lục, thanh đọc, rail khi giả lập reduce |
| Focus bị ẩn (`outline: none` thiếu thay thế) | **Đã sửa** | W2, W6 | TC27: Tab qua 14 điểm đầu của màn chương, sáng và tối, điểm nào cũng có viền focus. W6 bỏ `outline: "none"` inline còn sót ở ô Markdown của Cài đặt |
| `/login` lệch phong cách app | **Đã sửa** | W4 | TC29: nạp `tokens.css`, theo `vp:theme`, có `<label>`, sai token trả 401 kèm «Token không đúng…» trong `role="alert"`, đúng token về `/`; không cuộn ngang ở 360px |
| Hash `#/.../output/<n>` mở overlay thay vì đọc | **Đã sửa** | W5 | TC16/TC18: `/output/3` mở màn đọc, `/output/3/doi-chieu` mở overlay (Back đóng), `/chapters/3` vẫn mở overlay |
| Wiki / rail: phần tử bấm là `div`/`span` | **Đã sửa** | W5, W6 | Rail (W5). Wiki (W6): mục thực thể, tên liên kết trong mô tả và trong quan hệ đều là `<button>`; cmdk: mục lệnh là `<button>`; dải ảnh OCR trong đối chiếu là `<button>` |
| Màn chương: `--gray-*`/màu cứng, phụ thuộc fg yếu (§3.2) | **Đã sửa** | W2, W6 | Chip lọc trạng thái → `.chip-btn` + `aria-pressed`; «Cần sửa»/«OK»/lỗi dùng `--warn`/`--success`/`--danger`; menu OCR → `.menu-pop`/`.menu-item`. Không còn hex/rgba hay `--gray/indigo/red/amber/emerald-*` trong inline style của 6 màn |
| Thuật ngữ: fg yếu, thiếu theme sáng (§3.4) | **Đã sửa** | W2, W6 | Token + `.card`; trạng thái rỗng dùng `StatusBlock` có nút «Thêm thuật ngữ»/«Xoá tìm kiếm» |
| Cài đặt: fg yếu, chưa chọn được theme (§3.6) | **Đã sửa** | W2, W5, W6 | Chọn theme ở TopBar (W5). W6: nhãn gắn `htmlFor`, lưới tự xuống cột trên màn hẹp |

### 8.2 Lỗi nặng W6 phát hiện khi kiểm tổng (đã sửa trong W6)

| Màn | Heuristic | Lỗi | Cách sửa |
|---|---|---|---|
| Đọc | H9 | Mở link sâu `#/<slug>/output/<n>` (hoặc tab Đọc) làm **trắng màn**: render đầu tiên sau khi danh sách chương `ready` chạy trước effect chọn chương nên `cur` còn `null`, nhánh cuối đọc `cur.chapter_num` → React gỡ cả cây (lỗi console `Cannot read properties of null`) | Thêm nhánh «Đang mở chương…» khi chưa có `cur` (`output.jsx`) |
| Đối chiếu | H5, H9 | Tải bản dịch/bản gốc lỗi (mất mạng, file mất) thì vẫn hiện «Chương chưa được dịch»/«Không có nội dung gốc» và **cho bấm Sửa trên bản rỗng** → Lưu sẽ ghi đè file thật bằng nội dung trống | Trạng thái tải riêng cho từng pane: `StatusBlock` loading/error có «Thử lại»; «Sửa» bị khoá tới khi tải xong; «Sao chép» khoá khi không có nội dung. Chương ảnh chưa OCR (404) vẫn coi là rỗng như cũ |
| Thuật ngữ | H3, H8 | Ở ≤768px khối «Trích xuất từ AI» nằm trong hàng tab ngang, rộng 34px, chữ xuống dòng từng chữ → hàng tab cao ~630px, **bảng thuật ngữ cao 0** (không dùng được trên điện thoại) | Trên màn hẹp thu khối thành một nút gọn, ẩn mô tả |
| Cài đặt | H8 | Ở ≤768px các thẻ bị flex co lại, **cắt mất ô nhập** (chỉ thấy «Tên Trung», không thấy Thể loại/Prompt) | `.settings-card { flex-shrink: 0 }` |
| Cài đặt | H5 | Lúc `novel.md` chưa tải xong hoặc tải lỗi vẫn hiện form trên chuỗi rỗng và nút Lưu bấm được | `mdStatus` từ `app.jsx`: `StatusBlock` loading/error (+ «Thử lại»), khoá nút Lưu. Logic `version`/409 giữ nguyên (TC31) |
| Story-Wiki | H9 | Lỗi tải danh sách thực thể hiển thị như «Chưa có dữ liệu Story-Wiki»; lỗi nạp lại nền còn xoá sạch danh sách đang có | `wikiStatus` (loading/ready/error) trong `app.jsx`; lỗi giữ danh sách cũ, chỉ hiện `StatusBlock` lỗi có «Thử lại» khi chưa có gì |
| Chương | H1 | Đổi truyện/đang tải hoặc lỗi tải danh sách vẫn hiện «Không có chương nào khớp bộ lọc» | `StatusBlock` theo `chaptersStatus`: đang tải / lỗi + «Thử lại» / truyện chưa có chương (+ «Upload .txt») / không khớp bộ lọc (+ «Xoá bộ lọc») |
| Khung (TopBar) | H4, H8 | Desktop 1280px: ô chọn giao diện chiếm chỗ, ô «Tìm» bị bóp vỡ chữ thành 3–4 dòng, tên truyện trên breadcrumb bị ép mất | `.theme-select` gọn; ≤1440px ô Tìm chỉ còn icon + ⌘K và ẩn chip thể loại |

Ngoài ra (mức nhẹ, đã sửa luôn): ô tìm chương ở 360px chỉ rộng ~40px → chiếm cả hàng; cmdk hiện «Không có kết quả» bằng `StatusBlock`, có `role="dialog"`, `aria-activedescendant`, Enter chạy đúng mục đang focus; nhãn cmdk «Đi đến Bản dịch» → «Đi đến Đọc»; bỏ dòng giả «+12 thuật ngữ từ batch trước» ở Thuật ngữ; thêm `aria-label` cho nút chỉ có icon (trước/sau, zoom ảnh, sửa/xoá thuật ngữ) và ô nhập không có nhãn; bản prod hết 404 `/favicon.ico` trong console (favicon SVG nội tuyến).

### 8.2b Lỗi review phát hiện sau W6 (đã sửa ở đầu việc FIX)

| Màn | Heuristic | Lỗi | Cách sửa |
|---|---|---|---|
| Đọc | H9 | JSON hợp lệ nhưng sai kiểu trong `localStorage` (vd `{"valueOf":null,"toString":null}`) làm `Number()` ném `TypeError` → màn đọc vỡ (TC11) | `rdNum` chỉ nhận `typeof number`; tuỳ chọn hỏng → mặc định, số chương hỏng → bỏ tiến độ, trường vị trí hỏng → 0 |
| Đọc | H1, H5 | Đổi chương / thử lại: render đầu ghép tiêu đề chương mới với nội dung/lỗi cũ, nút Sao chép/.txt xuất nội dung cũ; file bản dịch rỗng (`200`, `content: ""`) hiện «Đang tải» mãi (TC22/TC23) | Kết quả tải gắn khoá `filename + lần thử`, trạng thái suy ra ngay trong render (`rdViewState`); thêm trạng thái «Chương N chưa có nội dung» có «Tải lại» |
| Đọc | H6 | Khôi phục giữa đoạn dài nhiều màn hình quay về đầu đoạn; rời màn / đổi truyện / tải lại trong 400ms sau lần cuộn cuối thì mất lần lưu (TC12/TC13) | Lưu thêm `pin` (tỉ lệ đã cuộn trong đoạn); chốt lần lưu đang chờ khi chuyển chương (trước khi ghi chương mới), khi rời màn (dọn dẹp `useLayoutEffect`, DOM còn), `pagehide` và tab bị ẩn |
| Đọc (mobile) | H3, truy cập | Thanh trên/dưới đã ẩn khi cuộn vẫn nhận focus bằng Tab → viền focus nằm ngoài màn (TC27) | `.rd-bar:focus-within` hiện thanh ngay; `onFocus` bỏ trạng thái ẩn |
| Thuật ngữ | H1, H9 | Đang tải / lỗi tải hiện như «Chưa có thuật ngữ trong nhóm này», không có «Thử lại» | `glossaryStatus` trong `app.jsx` (reset khi đổi truyện, lỗi nạp lại nền giữ dữ liệu đúng truyện); màn dùng `StatusBlock` loading/error + «Thử lại» |

Test hàm thuần của màn đọc: `node --test qidian-vietphase/frontend/tools/reader-storage.test.mjs` (localStorage hỏng nhiều kiểu, khôi phục vị trí, trạng thái tải khi đổi chương từ chương đã tải / chương lỗi / thử lại / file rỗng). Phần React (chốt lưu khi rời màn, focus thanh ẩn, màn Thuật ngữ) chưa kiểm headless ở đầu việc FIX: máy làm việc không có `uv` và Playwright.

### 8.2c Lỗi review lượt 2 (đã sửa ở đầu việc FIX)

| Màn | Heuristic | Lỗi | Cách sửa |
|---|---|---|---|
| Đọc | H1, H5 | A → B → A khi B chậm: khoá tải chỉ có `filename + lần thử`, nên lượt quay lại A khớp ngay nội dung/lỗi cũ của A, Sao chép/.txt xuất bản cũ trong lúc request mới chạy | Mỗi lượt chọn chương (`go()`) và mỗi lần thử lại tăng `loadSeq`; khoá tải là `filename + loadSeq` |
| Đối chiếu | H5 | Mở 3 → 5 → 3 hay bấm «Thử lại» nhiều lần: response của lượt cũ cùng tên file vẫn được nhận; lúc vừa đổi chương, nội dung + `ready` của chương trước còn hiện và cho Sửa tới khi effect reset; mọi `404` bản gốc thành `ready` (chương văn bản mất file cho sửa và lưu bản rỗng) | Số thứ tự lượt tải riêng cho bản dịch/ảnh (`loadGenRef`) và bản gốc/phân đoạn (`srcGenRef`); dữ liệu gắn `dataKey = filename + reloadNonce`, render khác khoá thì coi là đang tải (không cho Sửa); `404` chỉ thành rỗng với chương ảnh (chưa OCR); lưu bản gốc xong mà đã sang chương khác thì không ghi đè state |
| Đọc (router) | H3, H9 | Từ `#/…/output/999` bỏ số chương vẫn báo chương 999; đổi link lúc danh sách chương đang tải/lỗi bị bỏ qua; đoạn hash mã hoá sai làm `decodeURIComponent` ném lỗi, vỡ app | Route chưa xử lý được giữ lại tới khi danh sách «ready»; route không có số chương → bỏ báo lỗi, mở theo tiến độ đã lưu; `parseHash` giải mã an toàn, đoạn hỏng thành `null` |
| Đọc | Truy cập (AA) | StatusBlock, nút ghost/secondary trong vùng đọc dùng `--fg-*` của app trên nền đọc: app tối + nền sáng cho tiêu đề `#f3f4f6` trên `#fcfaf6` (~1.06:1) | `reader.css` cho các phần tử nền trong suốt trong `.rd-scroll` dùng `--rd-fg/--rd-muted/--rd-border`; `check-contrast.mjs` đọc màu chữ khai báo trong `reader.css` và kiểm mọi tổ hợp theme app × nền đọc |
| Đọc | H3, H7 | Chọn «Không chân» trong Aa mất sau khi tải lại (setter Tweaks chỉ báo cho host chỉnh thiết kế) | `app.jsx` lưu `fontReading` ở `vp:reader:font:v1` (try/catch, chỉ nhận `serif`/`sans`); Tweaks và Aa dùng cùng setter |
| Script seed | An toàn dữ liệu | Liên kết tượng trưng dưới `--root` (thư mục trung gian hoặc file đích) làm script ghi chương gốc, `novel.md`, bản dịch hoặc mở DB ngoài root, kể cả ở `--mark-done/--unmark` | Kiểm mọi đường dẫn sẽ ghi/mở trước khi ghi bất cứ gì (`preflight`) và trước từng lần ghi (`ensure_inside`): realpath phải nằm trong root, không thành phần nào là liên kết (kể cả liên kết hỏng, file phụ `-wal/-shm/-journal` của SQLite) |

Test: `node --test qidian-vietphase/frontend/tools/*.test.mjs` (thêm A → B → A và `app-route.test.mjs` cho hash mã hoá sai), `node qidian-vietphase/frontend/tools/check-contrast.mjs`, `cd qidian-vietphase && python3 -m unittest scripts/test_seed_ux_demo.py` (liên kết ở thư mục trung gian, file đích, DB, marker, chế độ `--mark-done/--unmark`). Phần React của đối chiếu và router chưa kiểm headless: máy làm việc không có Playwright/Chromium.

### 8.3 Mức trung bình / nhẹ chưa sửa → ticket sau

| Màn | Mức | Vấn đề | Lý do chưa sửa |
|---|---|---|---|
| Cài đặt | Trung bình | Ô «Concurrency», «Chunk size» không lưu đi đâu (chỉnh không có tác dụng) | Cần quyết định đưa vào `novel.md` hay bỏ; không đổi định dạng dữ liệu trong ticket này |
| Cài đặt | Trung bình | ≤768px khối «Thống kê truyện» chiếm ~200px cuối màn, form cuộn trong khung thấp | Cần đổi bố cục cuộn của cả trang; không chặn sửa |
| Chương | Trung bình | ≤768px ẩn cột checkbox → không chọn nhiều chương để dịch trên điện thoại | Cần thiết kế lại thanh chọn trên mobile |
| cmdk, Modal, overlay đối chiếu | Trung bình | Chưa giữ focus trong hộp thoại (Tab đi ra phần nền) | Cần helper focus-trap dùng chung; đụng guard phím của overlay |
| Chương, đối chiếu | Nhẹ | Menu chọn engine OCR chưa đóng bằng Esc/không di chuyển bằng mũi tên; Esc khi menu mở thì đóng luôn overlay (hành vi cũ) | Giữ nguyên guard Esc hiện có (TC30) |
| Nhiều màn | Nhẹ | Còn chữ tiếng Anh: «Glossary», «Upload .txt», «hits», «Concurrency», «Chunk size», bảng Tweaks («Visual», «Density», «Reading font») | Đổi nhãn hàng loạt nên làm riêng, kèm rà thuật ngữ |
| Chương | Nhẹ | Bảng «Hoạt động agent» dựng giả từ trạng thái chương (Extractor «queued» cố định) | Cần dữ liệu thật từ SSE |
| Thuật ngữ | Nhẹ | Hàng bảng dùng `key` theo chỉ số; bảng dài không sắp/phân trang | Không ảnh hưởng dữ liệu |
| Đọc | Nhẹ | Bản dev vẫn 404 `/favicon.ico` (Babel chạy sau khi trang nạp) | `index.html` ngoài phạm vi W6 — xem §7.2 |

---

## 9. Ghi chú kiểm tra môi trường

- **Agent W1:** rà soát bằng đọc code (`tokens.css`, `styles.css`, `output.jsx`, `shell.jsx`, `app.jsx`, các màn JSX, `_LOGIN_HTML`). Không chạy trình duyệt thật có thanh tab / thiết bị cảm ứng thật trong đầu việc này.
- **Không thử được (thiết bị/trình duyệt thật):** iOS Safari / Android Chrome (safe-area, notch, thanh ẩn khi cuộn cảm giác tay); mắt người đánh giá sepia/font trên màn hình vật lý; chế độ riêng tư chặn `localStorage`; zoom trình duyệt ảnh hưởng độ dài dòng — để người duyệt tự kiểm theo ticket.
- Repo **không có** `docs/architecture.md` / `docs/plans/` / sprint `docs/delivery/` tại thời điểm viết tài liệu này.
- File test tự động UX chưa có trong phạm vi W1; W2 thêm `check-contrast.mjs`; W4 thêm seed; W6 chạy checklist headless kế hoạch §4.

### 9.1 Kiểm tổng W6

- **Tĩnh:** esbuild 0.24.0 cho mọi JSX đã sửa; `node frontend/build.mjs` xong; `python -m compileall -q backend scripts`; `node frontend/tools/check-contrast.mjs` thoát 0.
- **Chạy:** `scripts/seed_ux_demo.py --root /tmp/vp-ux`, uvicorn trỏ vào dữ liệu mẫu, một bản `DEV_MODE=true` và một bản prod (sau `build.mjs`); thêm một bản `API_TOKEN` cho `/login`. Trình duyệt: Chromium headless (Playwright), 1280×800, 384×800, 360×740, `vp:theme` sáng và tối.
- **Kết quả (dev và prod đều đạt):**
  - Không cuộn ngang ở 6 màn app + overlay + `/login`, cả 3 khổ và 2 theme (TC19/TC21).
  - Luồng đọc: TC2 (cột ~60–70 ký tự, Noto Serif), TC3/TC4/TC5/TC6/TC7, ←/→, TC8/TC10/TC11, TC12, TC13 (A↔B liên tục khi `/api/chapters` trễ 2s), TC14 (chương đã nhớ mất → mở chương 2; xuất hiện lại → đọc được), TC15, TC16/TC17/TC18, TC20, TC22/TC23 (offline, file bản dịch mất), TC24, TC25 (thêm chương 4 khi đang đọc: `scrollTop` giữ nguyên, «Chương sau» → 4), chương đang đọc rời khỏi `done` (giữ nội dung + ghi chú), danh sách đang tải hiện loading, TC27, TC28, TC29.
  - Hồi quy: TC30 (đang gõ trong ô sửa: Esc, Ctrl+←/→ không đóng/không đổi chương; nút đóng hỏi confirm), TC31 (sửa `novel.md` trên đĩa rồi Lưu → hộp thoại 409, file không bị ghi đè), TC32 (upload `.txt`, Dịch tất cả, Dịch lại, thêm thuật ngữ từ bôi đen, OCR ảnh: đúng route và payload như cũ).
  - Wiki có dữ liệu (API giả lập) và cmdk dùng bằng bàn phím: đạt ở mọi khổ/theme.
  - TC33: bản prod không có lỗi console.
- **Giới hạn môi trường:** không có API key nên không dịch thật; TC25/«rời khỏi done» kích hoạt nạp lại danh sách bằng một job giả (SSE `done` của orchestrator) thay vì job dịch thật. Máy chụp headless thiếu font chữ Hán (hiện ô vuông) — không ảnh hưởng bố cục đo được. Script kiểm nằm ngoài repo (không thuộc phạm vi file được sửa), chưa có test runner UX trong repo.

---

*Tài liệu tạo bởi đầu việc W1 — T-950d2566. W6 cập nhật §3.2, §7.2, §8 và §9.1 sau kiểm tổng.*
