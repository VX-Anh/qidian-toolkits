# Kế hoạch import & áp dụng design từ Claude Design

> Nguồn: project **AI-Translate** trên claude.ai/design
> ID: `90186022-4037-4e89-8e61-42c9224720f7`
> Kết nối qua MCP connector `claude_design` (đã có quyền `user:design:read/write`).
> Ngày lập: 2026-06-23

---

## 0. Bối cảnh

- Frontend cục bộ (`frontend/`) được **seed ra từ chính design này** — cùng tên file, cùng tokens.
- Khác biệt then chốt giữa design và local:
  - **Design** dùng `src/mock_api.js` (patch `fetch`/`EventSource` để chạy không cần server).
  - **Local** dùng `src/api_bridge.js` + `index.html` trỏ `/static/...` + đoạn dev auto-reload, nối **backend thật** (FastAPI).
- Các file component của design vẫn gọi đúng endpoint `/api/...` thật → tương thích wiring với backend local (mock chỉ chặn ở môi trường design).

### File KHÔNG được đụng (giữ wiring backend local)
- `frontend/index.html`  — dùng `/static/`, `api_bridge.js`, dev-reload.
- `frontend/src/app.jsx` — đã wiring API thật: hash-routing, SSE, OCR, upload…
- `frontend/src/api_bridge.js` — thay cho `mock_api.js` (KHÔNG kéo `mock_api.js` về).

---

## 1. Hiện trạng so sánh (đã chạy diff design ↔ local)

Tất cả file đã được stage vào `.design-tmp/` rồi `git diff --no-index` với `frontend/`.

| File | Kết quả | Ghi chú |
|------|---------|---------|
| `src/components.jsx` | **giống hệt** | — |
| `src/shell.jsx` | **giống hệt** | — |
| `src/glossary.jsx` | **giống hệt** | — |
| `src/wiki.jsx` | **giống hệt** | — |
| `src/output.jsx` | **giống hệt** | — |
| `src/cmdk.jsx` | **giống hệt** | — |
| `src/tweaks-panel.jsx` | **giống hệt** | — |
| `tokens.css` | **giống hệt** | — |
| `src/chapters.jsx` | **KHÁC** (design −94 dòng) | ⚠️ Local **mới hơn** — có OCR (OcrUploadButton, banner OCR, chip nguồn ảnh). Design thiếu. |
| `src/translation_view.jsx` | **KHÁC** (250+/319−) | ⚠️ Local nhiều hơn ~69 dòng — nghi có pane ảnh/OCR. Cần xem kỹ. |
| `src/settings.jsx` | **KHÁC** (4+/5−) | Local có sửa chưa commit (+50/−11 so với bản committed). Diff với design nhỏ. |
| `src/styles.css` | **KHÁC** (111+/0−) | Design **thêm 111 dòng** thuần (additive), local không thiếu gì của design. |

### Kết luận quan trọng
Design đang **cũ hơn local** ở mảng OCR (`chapters.jsx`, `translation_view.jsx`).
→ **Áp design nguyên xi sẽ xoá mất tính năng OCR đang chạy.** Không làm vậy.

---

## 2. Các bước thực hiện

### Bước 1 — Kết nối connector ✅ (xong)
- Gọi `DesignSync list_projects` thành công, login tự nâng quyền design.
- KHÔNG cần `/design-login`.

### Bước 2 — Đọc design ✅ (xong)
- `get_project` + `list_files` + `get_file` toàn bộ file → đã stage `.design-tmp/`.

### Bước 3 — Diff design ↔ local ✅ (xong)
- Xác định 4 file khác nhau (bảng trên).

### Bước 4 — Xem diff chi tiết 4 file (XONG 2026-06-26)
- [x] `chapters.jsx` — xác nhận local mới hơn (OCR). Giữ local.
- [x] `translation_view.jsx` — **không phải chỉ cũ hơn.** Design BỎ OCR (ImagePane/runOcr/3-pane) nhưng THÊM 2 tính năng mới local chưa có:
  - In-pane editor (nút "Sửa" cho pane gốc 中 + pane dịch Việt → textarea, Lưu/Hủy, dirty-dot, props `onSaveSource`/`onSaveOutput`).
  - Thêm thuật ngữ từ bôi đen (TermPop + AddTermForm popover → prop `onAddTerm`).
- [x] `settings.jsx` — chỉ đổi dropdown Model tĩnh Gemini→GPT/Claude. Backend local dùng Gemini (Vertex) → **BỎ QUA, giữ Gemini**.
- [x] `styles.css` — 111 dòng additive = CSS cho 2 tính năng mới ở trên (`.pane-editor`, `.editor-dirty-dot`, `.term-pop`, `.term-form`). An toàn để merge thêm.

### Kết luận Bước 4
Để có tính năng mới (sửa tại chỗ + thêm term từ bôi đen) mà KHÔNG mất OCR → phải **MERGE thủ công** vào `translation_view.jsx` local (giữ nhánh `isImage`/OCR, ghép thêm editor + TermPop/AddTermForm), cộng:
- `styles.css`: append 111 dòng.
- `app.jsx`: truyền props mới `onAddTerm`, `onSaveSource`, `onSaveOutput` vào `<TranslationView>`.
- Backend: endpoint lưu sửa bản gốc / bản dịch + thêm term vào novel.md (cần kiểm tra cái nào đã có).

### Bước 5 — Quyết định áp dụng theo từng file
Nguyên tắc: **chỉ lấy phần design là CẢI TIẾN, không để mất code local mới hơn.**

- `styles.css`: nếu 111 dòng là CSS mới thuần (additive, không xoá class local đang dùng)
  → **merge thêm** vào `frontend/src/styles.css`.
- `settings.jsx`: so sánh xem thay đổi design có đáng lấy không, **không đè** phần sửa chưa commit của local nếu phần đó quan trọng. Cần hỏi/ở lại.
- `chapters.jsx`: **GIỮ local** (có OCR). Chỉ port lẻ phần thay đổi UI thuần của design nếu có và không đụng OCR.
- `translation_view.jsx`: đọc kỹ; nhiều khả năng **giữ local** (pane ảnh/OCR). Chỉ port thay đổi an toàn.

### Bước 6 — Xác nhận với người dùng trước khi đè
Vì design cũ hơn local ở vài chỗ → **báo cáo & hỏi** muốn:
  (a) chỉ lấy phần additive an toàn (styles.css + chỉnh nhỏ), giữ nguyên OCR; hay
  (b) đồng bộ ngược: đẩy code local mới hơn LÊN design (`DesignSync write_files`); hay
  (c) khác.

### Bước 7 — Áp dụng + kiểm thử
- Edit file thật theo quyết định.
- Chạy server: `uv run uvicorn backend.main:app --reload ... --port 9999`, mở UI kiểm tra:
  Chương / Thuật ngữ / Story-Wiki / Bản dịch / Cài đặt + OCR vẫn chạy.

### Bước 8 — Dọn dẹp
- Xoá thư mục tạm `.design-tmp/`.
- Tổng kết thay đổi.

---

## 3. Rủi ro & lưu ý
- **Không** kéo `mock_api.js` về local.
- **Không** đè `index.html`, `app.jsx`, `api_bridge.js`.
- Git là lưới an toàn: mọi file (trừ `settings.jsx` đang sửa dở) đều đã commit → có thể revert.
- `settings.jsx` đang có thay đổi chưa commit → cẩn thận, xem `git diff` trước khi đụng.
- Line endings: Windows sẽ chuyển LF→CRLF; cảnh báo git vô hại.
