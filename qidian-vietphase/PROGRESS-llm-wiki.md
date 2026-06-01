# Tiến độ thực thi — LLM-Wiki integration

> Bản ghi từng bước (step-by-step) khi triển khai `PLAN-llm-wiki.md`.
> Bắt đầu: 2026-06-01. Mỗi task ghi: đã làm gì · file đụng tới · cách kiểm chứng.

## Phase 1 — Story-wiki foundation

### ✅ Task 1 — Mở rộng `SharedState` (data layer)
**Trạng thái:** Hoàn thành.

- Backup `backend/db/state.db` → `backend/db/state.db.bak-phase1` (69 KB) trước khi đụng.
- `backend/agent/state.py`:
  - Thêm `import hashlib`.
  - `_init_db()`: thêm 3 bảng **additive** (`CREATE TABLE IF NOT EXISTS`, an toàn cho DB có dữ liệu):
    - `entities(novel_slug, zh, vi, type, description, aliases JSON, first_chapter, freq, status, updated_at)` — PK `(novel_slug, zh)`. `zh` là khóa liên kết với novel.md.
    - `relationships(id, novel_slug, from_zh, to_zh, type, description, first_chapter)` — UNIQUE `(novel_slug, from_zh, to_zh, type)`.
    - `events(id, novel_slug, chapter_num, description, characters JSON, dedupe_hash)` — UNIQUE `(novel_slug, dedupe_hash)`.
  - Accessors mới:
    - `upsert_entity(...)` — merge idempotent: giữ `vi` khi `status=approved`, mô tả dài hơn thắng, union `aliases`, `first_chapter=min`, `freq+1`.
    - `add_relationship(...)` — `ON CONFLICT` dedupe theo `(novel_slug,from_zh,to_zh,type)`, `first_chapter=min`.
    - `add_event(...)` — `INSERT OR IGNORE` qua `dedupe_hash = md5(chapter_num|description)`.
    - `get_entities/get_entity/get_relationships/get_events` — đều nhận `up_to=N` (lọc `first_chapter ≤ N`; events lọc `chapter_num ≤ N`) cho spoiler-free.

**Kiểm chứng:** smoke test trên DB tạm (đã chạy & xóa) — pass toàn bộ: tạo đủ 3 bảng; entity merge (freq=2, first_chapter=min, aliases union, mô tả dài hơn được giữ); relationship dedupe (1 dòng, first_chapter min); event dedupe (2 dòng từ 3 lần gọi); `up_to` lọc đúng.

**Bất biến giữ đúng:** không sửa bảng cũ; novel.md vẫn là vua cho `vi` (merge chỉ ghi đè vi khi entity chưa `approved`).

---

### ✅ Task 2 — WikiAgent (ingest 2-stage)
**Trạng thái:** Hoàn thành.

- File mới `backend/agent/wiki_agent.py` — `WikiAgent(BaseAgent)`:
  - Đọc chương Trung **nguồn** (input_dir) — nơi còn giữ Hán tự `zh` (bản dịch đã thay tên riêng sang vi nên không dùng được làm khóa).
  - System prompt 2 bước: **Phân tích** (liệt kê entity/quan hệ/sự kiện) → **Ghi** (gọi tool).
  - Tools (registry qua closure, tham số kiểu chuỗi để hợp với `ToolRegistry`):
    - `upsert_entity(zh, vi, type, description, aliases)` — `aliases` CSV; **glossary là vua**: nếu `zh` có trong glossary → ép dùng `vi` đã-duyệt, bỏ qua vi của model.
    - `add_relationship(from_zh, to_zh, type, description)`.
    - `add_event(description, characters)` — `characters` CSV (Hán tự).
    - `finish(summary)` — báo cáo số đã ghi.
  - `first_chapter`/`chapter_num` được inject từ closure (model không cần biết số chương).
  - Cắt nguồn ở `SOURCE_CHAR_CAP=9000` ký tự (token-safe; chunking dài để Phase 4).
  - Helper `_split_csv` xử lý cả dấu phẩy toàn-giác `，` + bỏ trùng.

**Kiểm chứng:** smoke test (đã chạy & xóa) — registry đủ 4 tool & param required đúng; gọi tool ghi DB ok; **glossary-is-king** (model gửi `vi="SAI"` cho 陈庆 → DB vẫn lưu `Trần Khánh`); term ngoài glossary (天演宗) giữ vi model đề xuất; first_chapter=7; quan hệ/sự kiện ghi đúng; `finish` đếm "2 thực thể, 1 quan hệ, 1 sự kiện".

---

### ✅ Task 3 — Hook WikiAgent vào Orchestrator
**Trạng thái:** Hoàn thành.

- `backend/agent/orchestrator.py`:
  - Import `WikiAgent`.
  - Sau `ExtractorAgent`: **nạp lại `profile`** (`load_novel`) để WikiAgent + Reviewer thấy term mới extractor vừa thêm vào novel.md.
  - Nâng `current_filenames`/`done_chapters` lên **dùng chung** cho cả wiki ingest lẫn review (trước đây chỉ reviewer tính).
  - Chèn vòng **wiki ingest**: với mỗi chương DONE trong batch có file nguồn `.txt` (chương OCR không có nguồn → bỏ qua), chạy `WikiAgent` đọc nguồn Trung, stream event; lỗi 1 chương không làm hỏng batch (try/except → emit `wiki/error`).
  - Emit event mới: `orchestrator/wiki_ingest` (bắt đầu, kèm count) và `orchestrator/wiki_done`.

**Kiểm chứng:** `import backend.agent.orchestrator` + `wiki_agent` chạy sạch (không lỗi cú pháp/vòng import). Reviewer block phía dưới vẫn dùng đúng `done_chapters` đã lift lên.

---

### ✅ Task 4 — routers/wiki.py + đăng ký main.py
**Trạng thái:** Hoàn thành.

- File mới `backend/routers/wiki.py` — prefix `/api/wiki`:
  - `GET /{slug}/entities` · `GET /{slug}/relationships` · `GET /{slug}/events` — đều nhận `?up_to=N`.
  - `GET /{slug}/entity/{zh}` — trả entity + danh sách `relationships` liên quan (cả 2 chiều), 404 nếu không có.
- `backend/main.py` — import `wiki` + `app.include_router(wiki.router)`.

**Kiểm chứng (FastAPI TestClient):** 4 route đăng ký đúng; **state.db thật đã migrate** (3 bảng mới xuất hiện trong DB thật — additive, dữ liệu cũ nguyên vẹn); endpoint slug rỗng trả `[]`; `?up_to=5` chấp nhận; `entity/{zh}` không có → 404.

---

### ✅ Task 5 — Frontend tab Story-Wiki (wiki.jsx) + wiring
**Trạng thái:** Hoàn thành.

- File mới `frontend/src/wiki.jsx` — `WikiScreen` (buildless React-CDN):
  - Cột lọc theo loại (Tất cả / Nhân vật / Địa danh / Cảnh giới / Kỹ năng / Khác) + ô tìm kiếm (Hán/Việt/mô tả/alias).
  - Danh sách thực thể: tên Việt + Hán + chương xuất hiện + tần suất.
  - Panel chi tiết: tên, loại, status, `first_chapter`, freq, **alias** (chip), **mô tả linkify** (click tên thực thể khác → nhảy tới), **quan hệ** (tải từ `/entity/{zh}`, click sang thực thể liên quan, hiện chiều in/out).
  - Empty-state khi chưa có dữ liệu.
- Wiring đủ 4 bước (finding #13):
  1. `index.html` — thêm `<script src="/static/src/wiki.jsx">` (sau components, trước app).
  2. `shell.jsx` — thêm tab `{ id:"wiki", label:"Story-Wiki", icon:"book" }` vào `TAB_DEFS`.
  3. `app.jsx` — state `wikiEntities` + loader `loadWiki` (gọi khi đổi slug, sau `wiki_done`, sau `done`); reset khi đổi truyện; render branch `tab==="wiki"`; `tabCounts.wiki`; SSE branch `wiki_ingest`/`wiki_done`; phím tắt `g w`; cmdk action `go-wiki`.
  4. `cmdk.jsx` — thêm action điều hướng `go-wiki` (G W).

**Kiểm chứng:** **Babel compile thật** (standalone 7.29.0 + preset react, đúng bản trình duyệt dùng) — toàn bộ 11 file `.jsx` biên dịch sạch, kể cả `wiki.jsx`/`app.jsx`/`shell.jsx`/`cmdk.jsx`.

---

### ✅ Task 6 — Verify Phase 1 (end-to-end)
**Trạng thái:** Hoàn thành.

Kiểm chứng qua FastAPI `TestClient` (boot app thật) + Babel compile:
- `state.db` thật migrate sạch (3 bảng mới, dữ liệu cũ nguyên).
- Static serving: `index.html` chứa thẻ `wiki.jsx`; `/static/src/wiki.jsx` phục vụ 200.
- Seed thử cho slug thật → `GET /entities` trả đúng (vi=Trần Khánh); `GET /entity/{zh}` mang `relationships` 2 chiều; `?up_to=N` lọc spoiler đúng (ẩn entity/event chương sau). Đã **xóa dữ liệu seed** để không bẩn DB thật.
- 11/11 JSX compile clean.

---

## Tổng kết Phase 1

**Hoàn tất toàn bộ 6 task.** Story-wiki foundation đã chạy end-to-end: data layer (SQLite) → WikiAgent 2-stage → hook orchestrator → API → tab frontend.

**File đụng tới:**
- BE: `backend/agent/state.py` (sửa), `backend/agent/wiki_agent.py` (mới), `backend/agent/orchestrator.py` (sửa), `backend/routers/wiki.py` (mới), `backend/main.py` (sửa).
- FE: `frontend/src/wiki.jsx` (mới), `frontend/index.html`, `frontend/src/shell.jsx`, `frontend/src/app.jsx`, `frontend/src/cmdk.jsx` (sửa).
- Backup: `backend/db/state.db.bak-phase1`.

**Bất biến giữ đúng:** glossary/novel.md là vua cho `vi`; migration cộng dồn; agent pattern (BaseAgent+ToolRegistry) tái dùng; SSE pattern giữ nguyên; buildless React-CDN.

---

## Review Codex + 5 fix (2026-06-01)

Chạy Codex (gpt-5-codex) review toàn bộ Phase 1. Codex xác nhận phần lõi **đúng**
(SQL conflict/UNIQUE khớp, merge logic, NULL-min, alive-guard fetch); không có lỗi
Critical/blocking. Đã áp **5 fix** được chọn:

- **Fix #5** `routers/wiki.py` — `GET /entity/{zh}?up_to=N` giờ **ẩn luôn entity** nếu `first_chapter > N` (404), không chỉ lọc quan hệ → bịt rò spoiler khi fetch trực tiếp.
- **Fix #2** `state.py` — **thread-safety**: bật `PRAGMA journal_mode=WAL` + `busy_timeout=5000` + `synchronous=NORMAL`; thay `asyncio.Lock` bằng **`threading.RLock` làm guard DUY NHẤT** bọc *mọi* truy cập connection (cả getter sync chạy ở threadpool lẫn writer async). Writer async không await khi giữ lock → tự tuần tự trên event loop. Loại bỏ race "đọc xen ghi" / "database is locked" giữa route sync FastAPI và agent async.
- **Fix #7** `app.jsx` — **SSE stale-closure**: thêm `currentSlugRef` + truyền `jobSlug` vào `listenToJob`; các reload (`wiki_done`/`done`/`cancelled`/`review_summary`) chỉ chạy khi `currentSlugRef.current === jobSlug` → đổi truyện giữa lúc dịch không ghi đè dữ liệu truyện đang xem.
- **Fix #11** `wiki.jsx` — `linkifyDesc` **bỏ qua tên/alias ≤1 ký tự** → tránh false-link chữ Hán đơn nằm trong tên/từ khác.
- **Fix #8** `state.py` — `add_event` dedupe_hash giờ gồm **cả `characters` đã sort** (và nâng md5→sha256) → 2 sự kiện cùng chương, mô tả giống nhưng nhân vật khác không bị gộp nhầm.

**Kiểm chứng:** test riêng — Fix#8 (WAL on, diff-chars giữ 2 dòng); Fix#2 (4 reader thread + writer async đồng thời, 0 lỗi, count đúng); Fix#5 (entity 404 khi up_to<first_chapter, 200 ngược lại); **11/11 JSX recompile clean** bằng Babel trình duyệt. `.gitignore` đã sẵn loại `*.db-wal/*.db-shm`.

**Để Phase 2** (Codex flag, đã thống nhất hoãn): #1 resolve `vi` ở read-time khi có approval-flow + merge_entity; #3 harden `json.loads` tool-args cho mọi agent; #4 `finish` sentinel dừng ReAct loop. #6 (NULL=hiện) giữ làm policy có chủ ý.

---

**Còn nợ (đúng phạm vi, để phase sau):**
- WikiAgent **chưa mirror** entity ngược vào novel.md (Phase 2 — `merge_entity`).
- Chương OCR (không có `.txt` nguồn) **chưa được wiki-ingest** (cần map `source_path`).
- Spoiler slider UI + đồ thị quan hệ + timeline = **Phase 3**.
- Lint nhất quán + reviewer bám glossary = **Phase 2**.
- **Chưa chạy live trên trình duyệt thật** (mới compile + TestClient) — nên smoke 1 lần bằng cách dịch vài chương rồi mở tab Story-Wiki.
