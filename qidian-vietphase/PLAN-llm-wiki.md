# Plan: Áp dụng LLM-Wiki pattern vào Qidian VietPhase

> Nguồn ý tưởng: `../llm-wiki-flow.md` (dự án `nashsu/llm_wiki`).
> Đích: `qidian-vietphase` — pipeline dịch tiểu thuyết Trung→Việt **đa-agent ReAct + FastAPI + SQLite + frontend React-CDN (buildless)**.
>
> Phạm vi đã chốt với người dùng: **làm theo phase**, ưu tiên 3 nhóm:
> **(1) Nhất quán & chất lượng dịch · (2) Story-wiki & ngữ cảnh · (3) Trải nghiệm review.**
> (Engine/độ bền — cache, queue — để phase cuối, ưu tiên thấp hơn.)

---

## 0. Nhận định cốt lõi: VietPhase ĐÃ là một "LLM-Wiki" dở dang

Nhiều trụ cột của pattern llm_wiki đã tồn tại sẵn — đừng làm lại, hãy **lấp khoảng trống**:

| Trụ cột llm_wiki | Đã có trong VietPhase? | Ở đâu |
|------------------|------------------------|-------|
| Wiki file-based markdown do LLM bảo trì | ✅ `rules/{slug}/novel.md` (bảng thuật ngữ) | `agent/novel_loader.py`, `append_terms_to_novel` |
| Agent đọc nguồn → cập nhật wiki (ingest) | ✅ một phần (chỉ giải quyết "term bị flag") | `agent/extractor.py` (`ExtractorAgent`) |
| ReAct loop (LLM→tool→lặp) | ✅ | `agent/base.py` (`BaseAgent`, MAX_ITER=20) |
| Tool registry | ✅ | `agent/tools.py` (`ToolRegistry`) |
| Streaming tiến trình (SSE) | ✅ | `EventQueue` (`agent/state.py`) + `routers/translate.py` |
| Bộ nhớ bền (SQLite) | ✅ | `agent/state.py` (`SharedState`): bảng `chapters`, `flagged_terms`, `reviews` |
| Idempotency (bỏ qua việc đã làm) | ✅ một phần (skip chapter `status==DONE`) | `orchestrator.py::_translate_one` |
| Human-in-the-loop review | ✅ | `agent/reviewer.py` + bảng `reviews` + vòng re-translate |
| Hàng đợi cần-xử-lý | ✅ một phần (`flagged_terms`) | `state.py` |
| Schema/luật của wiki | ✅ | YAML frontmatter + `## Prompt dịch` trong `novel.md` |
| Glossary "là luật", ép tuân theo | ✅ | `NovelProfile.system_prompt()` + `preprocessor.replace_proper_nouns` |

**Khoảng trống so với llm_wiki (đây là việc cần làm):**
1. Glossary phẳng `zh→vi→notes` — thiếu **mô tả, alias, chương xuất hiện (`first_chapter`), quan hệ**. (llm_wiki: entity pages giàu thông tin)
2. Trích xuất **phản ứng** (chỉ xử lý term translator flag) — chưa **chủ động 2-stage** phân tích chương ra entity/quan hệ/sự kiện. (llm_wiki: ingest analysis→generation)
3. `append_terms_to_novel` chỉ **chống trùng theo `| zh |`** — chưa **merge** (gộp mô tả/alias, giữ vi đã duyệt). (llm_wiki: page-merge)
4. Không có **quan hệ nhân vật** & **timeline sự kiện**.
5. Không có **spoiler-free theo chương** (`up_to_chapter`).
6. Không có **lint nhất quán** (cùng zh khác vi, vi đụng nhau, term hay xuất hiện nhưng chưa vào glossary).
7. Không có **đồ thị quan hệ** ở frontend.
8. (Engine, ưu tiên thấp) chưa có **SHA256 cache** & **resume sau crash** (chapter kẹt `IN_PROGRESS`).

---



> **[Findings từ review - xem mục 7 cuối file]** 14 vấn đề kỹ thuật đã được tích hợp vào các section liên quan ở trên và tổng hợp ở mục 7.
## 1. Quyết định thiết kế then chốt: novel.md vs SQLite

`novel.md` đang là **source of truth của glossary** (CLAUDE.md khẳng định) và là "luật" ép bản dịch. KHÔNG phá điều đó.

**Đề xuất: mô hình lai (hybrid).**
- `novel.md` **giữ nguyên vai trò**: glossary chuẩn `zh→vi` mà người sửa tay được + ép vào prompt dịch. Là tầng **thực thi**.
- Thêm **story-wiki trong SQLite** (`SharedState`): các thông tin markdown table làm kém — `description`, `aliases`, `first_chapter`, **relationships**, **events**. Là tầng **làm giàu & ngữ cảnh** (cho graph/timeline/spoiler/lint).
- Khoá liên kết giữa hai tầng = **chuỗi Hán (`zh`)**. Entity trong wiki tham chiếu term trong novel.md; `vi` đã-duyệt vẫn lấy từ novel.md (glossary là vua).

→ Giữ được "novel.md là source of truth + git-friendly + sửa tay", đồng thời có dữ liệu quan hệ/sự kiện truy vấn được mà không phình bảng markdown. (Tương ứng llm_wiki: novel.md ≈ wiki pages, SQLite wiki ≈ chỉ mục/graph dẫn xuất.)

---

## 2. Bản đồ ánh xạ pattern → triển khai (file thật)

| Pattern llm_wiki | Triển khai trong VietPhase |
|------------------|---------------------------|
| Entity pages giàu thông tin | Bảng `entities(zh, vi, type, description, aliases, first_chapter, freq, status)` trong `state.py`; mirror tối thiểu vào `novel.md` |
| Two-stage ingest (analysis→generation) | Nâng `ExtractorAgent` (hoặc thêm `WikiAgent`) chạy **chủ động mỗi chương**: Stage 1 phân tích → Stage 2 gọi tool `upsert_entity/add_relationship/add_event` |
| `merge_entities`/page-merge | Hàm `merge_entity()` trong `novel_loader`/`state`: union `aliases`, giữ `vi` đã-duyệt, mô tả dài hơn, `first_chapter=min` |
| Spoiler-free `up_to_chapter` | Cột `first_chapter`; query `?up_to=N` ở router; UI "đọc tới chương N" |
| 4-signal graph + Cytoscape | View "Đồ thị" (Cytoscape/vis-network qua CDN) đọc `relationships`; resolver `zh`→entity xử lý alias; lọc theo chương |
| Timeline sự kiện | Bảng `events(chapter_num, description, characters)` → view timeline |
| Lint (structural + semantic) | Route `/api/lint/{slug}`: rule-based (cùng zh khác vi; vi đụng nhau; orphan; term tần suất cao chưa vào glossary) + tùy chọn lint LLM |
| Review queue async | Đã có `reviews` + `flagged_terms`; nối kết quả lint vào đây |
| SHA256 incremental cache | Cột `chapters.content_hash`; bỏ qua khi raw không đổi |
| Resume sau crash | Khởi động: `IN_PROGRESS`→`pending`; thêm `retry_count` |

---

## 3. Lộ trình theo phase (bám 3 ưu tiên đã chọn)

### Phase 1 — Story-wiki foundation  *(ưu tiên: Story-wiki & ngữ cảnh)*
Mục tiêu: nâng glossary phẳng → thực thể giàu, có ngữ cảnh & chương xuất hiện.

1. **Mở rộng `SharedState._init_db()`** (additive, an toàn cho `state.db` đã có dữ liệu):
   ```sql
   CREATE TABLE IF NOT EXISTS entities(
     zh TEXT, novel_slug TEXT, vi TEXT, type TEXT,
     description TEXT, aliases TEXT,          -- JSON array
     first_chapter INTEGER, freq INTEGER DEFAULT 1,
     status TEXT DEFAULT 'pending',           -- pending|approved|rejected
     PRIMARY KEY(novel_slug, zh));
   CREATE TABLE IF NOT EXISTS relationships(
     id INTEGER PRIMARY KEY AUTOINCREMENT, novel_slug TEXT,
     from_zh TEXT, to_zh TEXT, type TEXT, first_chapter INTEGER);
   CREATE TABLE IF NOT EXISTS events(
     id INTEGER PRIMARY KEY AUTOINCREMENT, novel_slug TEXT,
     chapter_num INTEGER, description TEXT, characters TEXT);  -- JSON
   ```
2. **Ingest 2-stage** (`agent/extractor.py` → mở rộng, hoặc `agent/wiki_agent.py` mới dùng lại `BaseAgent`):
   - Stage 1: phân tích 1 chương đã dịch/đang dịch → entity (type, mô tả ngắn), quan hệ, sự kiện, mâu thuẫn với glossary.
   - Stage 2: tool `upsert_entity / add_relationship / add_event` ghi vào SQLite + (entity quan trọng) mirror vào `novel.md` qua `append_terms_to_novel`.
   - Gắn `first_chapter = chapter_num` của chương đang xử lý.
   - Hook vào `orchestrator.run()` ngay sau khối dịch (cạnh ExtractorAgent hiện tại).
3. **Routers** (`routers/novels.py` hoặc mới `routers/wiki.py`): `GET /api/wiki/{slug}/entities`, `/relationships`, `/events` (đều nhận `?up_to=N`), `GET /api/wiki/{slug}/entity/{zh}`.
4. **Frontend**: panel chi tiết thực thể (alias, mô tả, chương xuất hiện, quan hệ) — mở rộng `frontend/src/glossary.jsx`; linkify tên trong mô tả. (Giữ buildless React-CDN; nhớ `loadChapters`/loaders phải mang đủ field DB — xem [[frontend-react-cdn-stack]].)

### Phase 2 — Nhất quán & chất lượng  *(ưu tiên cao nhất)*
1. **`merge_entity()`**: thay vì chỉ chống trùng `| zh |`, gộp thông minh — union `aliases`, giữ `vi` đã-duyệt, lấy `description` dài hơn, `first_chapter=min`, `freq++`. Sửa `append_terms_to_novel` + nhánh upsert entity.
2. **Lint engine** `agent/lint.py` + `GET /api/lint/{slug}` (rule-based, không cần LLM):
   - **Cùng `zh` khác `vi`** (mâu thuẫn giữa novel.md và file output / giữa các lần).
   - **`vi` đụng nhau** (2 `zh` khác nhau → cùng `vi`).
   - **Orphan**: term trong glossary không xuất hiện trong chương nào.
   - **Thiếu**: `zh` tần suất cao trong raw nhưng chưa có trong glossary (gợi ý bổ sung).
   - (tùy chọn) lint LLM ngữ nghĩa: mô tả entity mâu thuẫn.
   - Kết quả đẩy vào bảng `reviews`/`flagged_terms` để xử lý.
3. **Tăng cường `ReviewerAgent`** (`agent/reviewer.py`): kiểm tra **bám glossary** — bản dịch có dùng đúng `vi` đã-duyệt cho từng `zh` không; lệch → `issues` → tận dụng **vòng re-translate đã có** (`orchestrator` truyền `review_issues` về `TranslatorAgent`).
4. **Harden parse JSON** (nếu agent nào nhận free-text JSON): thêm bóc `{...}` cân bằng brace-depth (kiểu `extractJsonObject` của llm_wiki) vào tiện ích chung. *(Hiện đa số đi qua tool-call có cấu trúc nên rủi ro thấp.)*

### Phase 3 — Trải nghiệm review  *(ưu tiên: spoiler-free + graph + timeline)*
1. **Spoiler-free**: tham số `?up_to=N` xuyên suốt API entities/relationships/events (lọc `first_chapter ≤ N`); UI thanh "đang đọc tới chương N". Mặc định `first_chapter` null = luôn hiện.
2. **Đồ thị quan hệ**: view mới (`frontend/src/graph.jsx`) dùng Cytoscape/vis-network qua CDN (buildless); dựng node/edge từ `relationships`; resolver `zh`→id xử lý alias; lọc theo chương; click node → panel entity (Phase 1).
3. **Timeline sự kiện**: view đọc `events` theo `chapter_num`.
4. Thêm tab vào `frontend/src/shell.jsx` (điều hướng) + `cmdk.jsx` (command palette).

### Phase 4 — Engine & độ bền  *(ưu tiên thấp, làm sau)*
1. **SHA256 cache**: cột `chapters.content_hash`; khi raw không đổi & đã DONE → bỏ qua (hiện chỉ skip theo `status`). Cắt token khi chạy lại / re-import.
2. **Resume sau crash**: khi khởi động, reset `IN_PROGRESS`→`pending`; thêm `retry_count` cho mỗi chương; hiển thị tiến trình. (Tận dụng `status` machine sẵn có, không cần Celery.)

> Mỗi phase chạy độc lập có giá trị; có thể dừng sau Phase 2 mà vẫn được "nhất quán + story-wiki".

---

## 4. Bất biến phải tôn trọng

- **Glossary là vua** — `system_prompt()` luôn ép glossary đã-duyệt; `replace_proper_nouns` chạy trước dịch. Wiki mới chỉ làm giàu, không thay thế.
- **`novel.md` là source of truth** của glossary — story-wiki SQLite là tầng dẫn xuất/làm giàu, sync chứ không lấn quyền.
- **Frontend buildless** (React 18 CDN + Babel standalone) — view mới viết bằng `.jsx`, graph lib qua CDN. Loader phải mang **đủ field DB** (memory `[[frontend-react-cdn-stack]]`).
- **Kiến trúc agent giữ nguyên**: `BaseAgent` ReAct + `ToolRegistry` + `EventQueue`/SSE. Tính năng mới = agent/tool mới, không đập pipeline.
- **Migration cộng dồn**: `state.db` đã commit & có dữ liệu thật → chỉ `CREATE TABLE IF NOT EXISTS` + `ALTER ... ` bọc try/except (như `ocr_job_id` hiện có). Backup DB trước khi chạy.
- Giữ **SSE pattern** (`POST start → job_id → GET stream/{job_id}`, sentinel `None`), **status flow** chapter (pending→in_progress→done/failed), **idempotency** skip DONE.

---

## 5. Rủi ro & giảm thiểu

| Rủi ro | Giảm thiểu |
|--------|-----------|
| Migration làm hỏng `state.db` thật | ALTER/CREATE cộng dồn + backup trước; test trên bản copy |
| Ingest 2-stage tăng token/chi phí | Chạy ở mức chương; (Phase 4) cache theo `content_hash` để không lặp |
| Hai nguồn glossary lệch nhau (novel.md vs SQLite) | `merge_entity` đồng bộ 1 chiều: novel.md là vua cho `vi`; wiki chỉ thêm description/alias/quan hệ |
| Graph lib nặng | CDN + lazy-load chỉ ở view đồ thị |
| Spoiler filter sai | `first_chapter = min` chương thấy lần đầu; null → hiện hết |
| Frontend buildless dễ vỡ khi thêm field | Cập nhật loader mang đủ field; kiểm thử như memory đã nhắc |

---

## 6. Đề xuất bắt đầu

Người dùng chọn **làm theo phase** + ưu tiên *nhất quán, story-wiki, review*. Khuyến nghị thứ tự thực thi:
**Phase 1 (story-wiki data + ingest 2-stage)** → **Phase 2 (merge + lint + reviewer)** → **Phase 3 (spoiler + graph + timeline)** → **Phase 4 (cache + resume)**.

> Bước kế: chốt Phase 1 → mình bóc task-level chi tiết (đổi gì ở `state.py`, `extractor.py`/`wiki_agent.py`, `orchestrator.py`, router & `.jsx` nào) và bắt tay code.


---

## 7. Lưu ý kỹ thuật từ review (tổng hợp 14 findings)

Danh sách đầy đủ các vấn đề kỹ thuật được phát hiện từ review:

1. **Review queue**: \`flagged_terms\` + \`reviews\` là bản ghi, không phải queue thực. Queue async là công việc mới nếu cần.
2. **Entity key**: dùng \`(novel_slug, zh, type)\` hoặc \`entity_id\` ổn định với aliases — không dùng bare \`zh\`.
3. **Migration**: versioned migration + backup \`state.db\` trước + test trên bản copy trước khi áp thật.
4. **Reconciliation**: xác định rõ novel.md↔SQLite sync theo hướng nào (rebuild on save vs SQLite strictly derived).
5. **File locking**: tập trung tất cả ghi novel.md qua một service + file lock + last-write-wins detection.
6. **Tool idempotency**: wiki tools phải idempotent + order-independent, hoặc serialize tool execution.
7. **UNIQUE constraints**: relationships \`(novel_slug, from_zh, to_zh, type, first_chapter)\`; events có dedupe_hash.
8. **Tool arg parsing**: bọc \`json.loads()\` trong tool calls → recoverable tool error thay vì crash.
9. **SSE event types**: định nghĩa tường minh + extend \`app.jsx\` listener cho wiki/lint events.
10. **Router registration**: đăng ký tường minh \`wiki.router\` + \`lint.router\` trong \`backend/main.py\`.
11. **Chapter-reading tools**: \`WikiAgent\` cần \`read_source\`, \`read_translation\`, \`list_done_chapters\` + wiki upserts.
12. **Lint corpus scanning**: quyết định scan filesystem trực tiếp vs thêm \`source_path/translated_path/content_hash\` vào \`chapters\`.
13. **Frontend integration checklist**: mỗi view mới cần đủ 4 bước: \`index.html\` script order, \`shell.jsx\` tab, \`app.jsx\` render branch, \`cmdk.jsx\` action.
14. **Extract terms placeholder**: Phase 1 phải nối \`onExtract\` + command-palette + SSE listener — hiện là placeholder chưa nối backend.
