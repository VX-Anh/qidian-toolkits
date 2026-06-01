# LLM Wiki — Flow, Kiến trúc & Cách giải quyết vấn đề

> Phân tích dự án `C:\Users\ASUS\Documents\work\llm_wiki` (repo `nashsu/llm_wiki`, GPLv3).
> Ghi lại để tham khảo khi xây tính năng tương tự cho qidian.
>
> ⚠️ **Lưu ý quan trọng:** llm_wiki **KHÔNG** phải app Flask/JS thuần. Nó là **ứng dụng desktop Tauri v2 (Rust) + React 19 + TypeScript**, hiện thực hóa "LLM Wiki pattern" của Andrej Karpathy. Tài liệu này viết từ mã nguồn thật (`src/`, `src-tauri/`).

---

## 1. Ý tưởng cốt lõi (đọc `llm-wiki.md`)

Khác với RAG truyền thống (mỗi câu hỏi lại đi truy hồi & tổng hợp lại từ đầu), LLM Wiki **xây dựng và duy trì một wiki bền vững** — tập hợp file markdown có liên kết chéo, nằm giữa người dùng và nguồn thô. Mỗi khi thêm nguồn, LLM đọc, trích xuất, và *tích hợp* vào wiki có sẵn: cập nhật trang thực thể, sửa tóm tắt, đánh dấu mâu thuẫn. Tri thức được "biên dịch một lần rồi giữ cho cập nhật", không phải tái tạo mỗi lần hỏi.

> Vai trò: **Con người** lo nguồn + đặt câu hỏi. **LLM** lo toàn bộ việc tóm tắt, liên kết chéo, sắp xếp, bảo trì. *"Obsidian là IDE; LLM là lập trình viên; wiki là codebase."*

Ba thao tác: **Ingest** (nạp nguồn), **Query** (hỏi đáp), **Lint** (kiểm tra sức khỏe wiki).

---

## 2. Tech stack

| Lớp | Công nghệ |
|-----|-----------|
| Desktop shell | **Tauri v2** (backend Rust) — `src-tauri/` |
| Frontend | **React 19 + TypeScript + Vite** — `src/` |
| UI | shadcn/ui + Tailwind CSS v4, Milkdown (editor WYSIWYG) |
| State | **Zustand** (`src/stores/*`) |
| Đồ thị | **sigma.js + graphology + ForceAtlas2** + `graphology-communities-louvain` |
| Vector DB | **LanceDB** (Rust, nhúng, tùy chọn) qua `commands/vectorstore.rs` |
| Trích xuất tài liệu | PDF (pdfium-render), DOCX (docx-rs), PPTX (zip+xml), XLSX (calamine) |
| HTTP ra ngoài | `tauri-plugin-http` (fetch từ Rust, né CORS của LLM API) |
| LLM | Streaming fetch đa provider: OpenAI, Anthropic, Google, Ollama, Azure, Custom, **Claude Code CLI**, **Codex CLI** (subprocess) |
| Web search | Tavily / SerpApi / SearXNG + AnyTXT (local) |
| i18n | react-i18next (EN + 中文) |

`npm run tauri dev` để chạy. CI build cho macOS/Windows/Linux qua GitHub Actions.

---

## 3. Kiến trúc 3 lớp & cấu trúc thư mục project

Một "project" (vault) trên đĩa có cấu trúc cố định (tạo bởi `src-tauri/src/commands/project.rs::create_project`):

```
my-wiki/
├── purpose.md              # "Linh hồn" wiki: mục tiêu, câu hỏi, phạm vi (LLM đọc mỗi lần ingest/query)
├── schema.md               # Luật cấu trúc wiki: loại trang, naming, frontmatter, cross-ref
├── raw/
│   ├── sources/            # Tài liệu nguồn (BẤT BIẾN — LLM chỉ đọc)
│   │   └── .cache/         # Cache văn bản đã trích từ PDF/DOCX...
│   └── assets/             # Ảnh local
├── wiki/                   # TOÀN BỘ do LLM sinh & sở hữu
│   ├── index.md            # Catalog mọi trang (LLM cập nhật mỗi ingest; dùng để điều hướng/query)
│   ├── log.md              # Nhật ký append-only ("## [YYYY-MM-DD] ingest | Title")
│   ├── overview.md         # Tóm tắt toàn cục (tự cập nhật)
│   ├── entities/  concepts/  sources/  queries/  synthesis/  comparisons/
│   └── media/<source-slug>/  # Ảnh trích từ nguồn
├── .obsidian/              # Config Obsidian tự sinh (wiki = Obsidian vault)
└── .llm-wiki/              # State app (KHÔNG public qua API)
    ├── project.json            # UUID bền vững (sống sót khi đổi/di chuyển thư mục; tạo lười bởi TS `ensureProjectId`)
    ├── ingest-queue.json       # Hàng đợi ingest (sống sót restart)
    ├── ingest-cache + image-caption-cache.json
    ├── review.json             # Review items tích lũy
    ├── lint.json               # Kết quả lint gần nhất
    ├── conversations.json      # Danh sách cuộc hội thoại
    └── chats/{id}.json         # File hội thoại riêng từng chat
```

- **Three layers**: Raw sources (bất biến *về mặt khái niệm* — app có thể copy/xóa file ở đó và ghi `.cache`; "bất biến" có nghĩa LLM chỉ đọc, không sinh wiki vào raw/) → Wiki (LLM sinh) → Schema (`schema.md` + `purpose.md`, luật & ý định).
- **Wikilink** `[[page-slug]]` để liên kết chéo; **YAML frontmatter** trên mọi trang (`type, title, sources[], tags, related, created, updated`).

---

## 4. Cấu trúc mã nguồn (file nào làm gì)

### 4.1. Backend Rust — `src-tauri/src/`

| File | Nhiệm vụ |
|------|----------|
| `lib.rs` | Bootstrap Tauri: đăng ký mọi `#[tauri::command]` (invoke_handler), set proxy env, khởi động API server + clip server, xử lý close-window. **Đây là bản đồ mọi command** FE gọi được. |
| `commands/fs.rs` | Đọc/ghi/list/copy/delete file, `write_file_atomic`, `preprocess_file` (trích văn bản từ PDF/Office, cache), `read_file_as_base64`, `find_related_wiki_pages`, md5/size/mtime. |
| `commands/project.rs` | `create_project` (dựng cây thư mục + schema/purpose/wiki skeleton + `.obsidian`), `open_project` (validate có `schema.md` + `wiki/`). |
| `commands/search.rs` | **Engine truy hồi**: tokenize (CJK bigram), scoring keyword (filename-exact/phrase/token) trên **wiki/** (không quét raw/sources/), trộn vector (LanceDB) bằng **RRF (Reciprocal Rank Fusion, k=60)** → `search_project` trả `mode: keyword/vector/hybrid`. Dùng chung cho cả chat WebView lẫn API. |
| `commands/vectorstore.rs` | CRUD LanceDB: `vector_upsert_chunks`, `vector_search_chunks`, `vector_delete_page`... |
| `commands/extract_images.rs` | Trích ảnh nhúng từ PDF/PPTX/DOCX → `wiki/media/<slug>/`. |
| `commands/file_sync.rs` | Auto-watch `raw/sources/` (thêm/sửa/xóa ngoài app), hàng đợi file-change, `rescan_project_files`. |
| `commands/claude_cli.rs`, `codex_cli.rs` | Spawn/kill subprocess `claude` / `codex` làm provider LLM (stdin/stdout thay vì HTTP). |
| `api_server.rs` | **HTTP API local** `127.0.0.1:19828` (tiny_http): health, projects, files, search hybrid, graph, rescan. Token-protected, rate-limit, sandbox path. |
| `clip_server.rs` | HTTP server (port 19827) nhận clip từ Chrome extension. |
| `proxy.rs`, `panic_guard.rs` | Proxy env động; bọc command chống panic. |

### 4.2. Frontend React — `src/`

**Stores (Zustand)** — `src/stores/`: `wiki-store` (project, llmConfig, embeddingConfig, multimodalConfig, fileTree, dataVersion...), `chat-store`, `research-store`, `review-store`, `activity-store` (panel tiến trình), `update-store`, `file-sync-store`.

**Logic lõi** — `src/lib/` (gần 100 module, nhiều test `.test.ts` / `.real-llm.test.ts`):

| Nhóm | File chính |
|------|-----------|
| **Ingest** | `ingest.ts` (pipeline 2 bước, ~2500 dòng), `ingest-queue.ts` (hàng đợi nối tiếp), `ingest-cache.ts` (SHA256 incremental), `ingest-sanitize.ts`, `page-merge.ts` (gộp trang cũ+mới qua LLM), `project-mutex.ts` (khóa per-project) |
| **Query/Search** | `search.ts` (client gọi Rust), `context-budget.ts` (phân bổ token) |

> **Lưu ý:** RRF (Reciprocal Rank Fusion) được thực hiện trong Rust `commands/search.rs` (k=60), không phải module TS riêng.
| **Graph** | `graph-relevance.ts` (4-signal model), `wiki-graph.ts`, `graph-insights.ts` (surprising connections + knowledge gaps), `graph-search.ts`, `graph-filters.ts`, `graph-visibility.ts` |
| **Lint** | `lint.ts` (structural + semantic) |
| **Deep Research** | `deep-research.ts`, `web-search.ts`, `anytxt-search.ts`, `optimize-research-topic.ts` |
| **Review** | `review-utils.ts`, `sweep-reviews.ts` (tự dọn review cũ khi queue cạn) |
| **Multimodal** | `extract-source-images.ts`, `image-caption-pipeline.ts`, `vision-caption.ts`, `markdown-image-resolver.ts` |
| **Embedding** | `embedding.ts` (gọi `/v1/embeddings`, chunk + upsert LanceDB) |
| **Source lifecycle** | `source-lifecycle.ts` (import/delete cascade), `wiki-page-delete.ts`, `wiki-cleanup.ts`, `source-watch-config.ts` |
| **LLM** | `llm-client.ts` (streamChat), `llm-providers.ts` (build body/headers theo provider), `claude-cli-transport.ts`, `codex-cli-transport.ts`, `reasoning-detector.ts`, `tauri-fetch.ts` |
| **Tiện ích nội dung** | `frontmatter.ts`, `wikilink-transform.ts`, `enrich-wikilinks.ts`, `detect-language.ts`, `output-language.ts`, `templates.ts` (schema/purpose mẫu), `text-chunker.ts`, `path-utils.ts` |
| **API/Local** | `api-token.ts`, `api-server-constants.ts`, `clip-watcher.ts`, `scheduled-import.ts` |

**Components** — `src/components/`: `layout/app-layout.tsx` (3 cột + icon sidebar), `chat/`, `editor/` (Milkdown), `graph/graph-view.tsx`, `lint/`, `review/`, `search/`, `sources/`, `project/` (welcome + template picker), `settings/sections/*` (mỗi mảng cấu hình một file).

**Entry**: `src/main.tsx` → `src/App.tsx`: load project gần nhất → nếu chưa có thì `WelcomeScreen`, có rồi thì `AppLayout`; restore/pause ingest-queue theo project.

---

## 5. Các flow chính (kèm file liên quan)

### Flow A — Tạo project
```
WelcomeScreen → template-picker (templates.ts: research/reading/personal/business/general)
  [React dialog] chọn template + output-language (bắt buộc) + extraDirs
→ invoke create_project (project.rs): tạo raw/sources, raw/assets, wiki/ + skeleton mặc định
→ React ghi đè purpose.md + schema.md từ template đã chọn + tạo extraDirs
→ App.tsx handleProjectOpened → resetProjectState → restoreQueue()
```
- `commands/project.rs::create_project` **chỉ** dựng cây thư mục + skeleton tĩnh (`schema.md`/`purpose.md` mặc định, `wiki/{index,log,overview}.md`) + config `.obsidian/`. Trả về `{name, path}`. Rust không biết về template hay output-language.
- **React dialog** (template-picker) sau đó ghi đè `schema.md`/`purpose.md` theo template đã chọn, tạo extraDirs, và yêu cầu người dùng chọn output-language.
- **UUID `project.json`** (bền vững khi đổi/di chuyển thư mục) được tạo lười (lazy) bởi hàm TypeScript `ensureProjectId` trong `lib/project-identity.ts` — KHÔNG nằm trong Rust create_project.

**File:** `welcome-screen.tsx`, `template-picker.tsx`, `lib/templates.ts`, `commands/project.rs`, `lib/project-identity.ts`.

### Flow B — INGEST (trái tim hệ thống) — `lib/ingest.ts::autoIngest`

Import nguồn → vào hàng đợi → chạy nối tiếp. `autoIngest` được bọc bởi `withProjectLock` (mutex per-project) vì stage phân tích đọc `index.md` còn stage sinh ghi đè nó.

```
importSourceFiles/Folder (source-lifecycle.ts)
  → copy vào raw/sources/, preprocess_file (trích text+cache)
  → enqueueBatch (ingest-queue.ts) → ghi ingest-queue.json

processNext (ingest-queue.ts):  // nối tiếp, MAX_RETRIES=3, persist mỗi bước
  → autoIngest(pp, sourcePath, llmConfig, abortSignal, folderContext):

   0.  checkIngestCache (SHA256 nội dung) → HIT thì bỏ qua LLM, chỉ chạy lại trích ảnh (idempotent)
   0.5 extractAndSaveSourceImages → wiki/media/<slug>/
   0.6 captionMarkdownImages (vision LLM, cache theo SHA256 ảnh)  [nếu multimodal bật]
   (nếu nguồn > sourceBudget) analyzeLongSourceInChunks: chunk có overlap + digest + checkpoint
   1.  STAGE 1 — Analysis: streamChat(buildAnalysisPrompt) → entities/concepts/arguments/
       connections/contradictions/recommendations  (temp 0.1, reasoning off)
   2.  STAGE 2 — Generation: streamChat(buildGenerationPrompt) → các khối ---FILE: wiki/...---...---END FILE---
   2.5 (tùy) STAGE review riêng: ---REVIEW: type | title--- ... (OPTIONS/PAGES/SEARCH)
   3.  writeFileBlocks: parseFileBlocks → sanitize → guard path (isSafeIngestPath) → guard ngôn ngữ
        - log.md: APPEND ; index/overview: GHI ĐÈ ; trang nội dung: MERGE (page-merge.ts)
        - đảm bảo có source-summary (fallback nếu LLM quên)
   3.5 injectImagesIntoSourceSummary (an toàn, luôn có ảnh trong wiki/sources/<slug>.md)
   4.  parseReviewBlocks → reviewStore.addItems
   5.  saveIngestCache (chỉ khi KHÔNG có hard-failure)
   6.  embedPage cho mỗi trang mới (nếu embedding bật) → LanceDB
  → bumpDataVersion (graph/UI refresh)

queue cạn → onQueueDrained → sweepResolvedReviews (tự dọn review cũ)
```
**File:** `lib/ingest.ts`, `lib/ingest-queue.ts`, `lib/ingest-cache.ts`, `lib/page-merge.ts`, `lib/source-lifecycle.ts`, `commands/fs.rs` (preprocess_file), `commands/extract_images.rs`, `lib/image-caption-pipeline.ts`, `lib/sweep-reviews.ts`.

### Flow C — QUERY / Chat — `components/chat/chat-panel.tsx`
```
user hỏi → searchWiki (lib/search.ts → invoke search_project ở search.rs)
  Phase 1   tokenize (CJK bigram) + keyword scoring + title bonus, quét wiki/ (chỉ wiki/, không quét raw/sources/)
  Phase 1.5 (tùy) embed query → vector_search_chunks (LanceDB) → trộn (RRF) vào kết quả keyword
  Phase 2   [chat-panel.tsx] mở rộng theo đồ thị (4-signal relevance) từ seed top kết quả
  Phase 3   computeContextBudget: index 5% / pages 50% / response reserve 15% / còn lại history+system
  Phase 4   ráp prompt: purpose.md + index.md + các trang đánh số → streamChat
→ trả lời, trích dẫn [N]; "Save to Wiki" → wiki/queries/ rồi auto-ingest (compounding)
```
**File:** `chat-panel.tsx`, `lib/search.ts`, `commands/search.rs`, `lib/context-budget.ts`, `lib/embedding.ts`.

**Lưu ý bổ sung:**
- Chat phát hiện lời chào/small-talk và **bỏ qua toàn bộ bước truy hồi** (không gọi search, không đọc wiki).
- Chat hỗ trợ tùy chọn **Web Search** (Tavily/SerpApi/SearXNG) và **AnyTXT** (full-text local) bổ sung vào context.
- Kiến trúc tìm kiếm: Rust `search.rs` thực hiện keyword + vector retrieval; `chat-panel.tsx` thực hiện graph expansion trên kết quả đó (Phase 2 ở trên).
- `POST /projects/{id}/chat` qua HTTP API local hiện trả **501 Not Implemented** (chưa tích hợp streaming qua tiny_http).

### Flow D — Knowledge Graph
```
graph-view.tsx → buildRetrievalGraph (graph-relevance.ts): đọc wiki/, frontmatter (type, sources[]),
  wikilinks → node/edge ; cache theo dataVersion
calculateRelevance = directLink×3 + sourceOverlap×4 + AdamicAdar×1.5 + typeAffinity×1
Louvain (graphology-communities-louvain) → cụm tri thức + cohesion
graph-insights.ts: findSurprisingConnections (cross-community/type/peripheral-hub),
  detectKnowledgeGaps (isolated ≤1, sparse cohesion<0.15, bridge ≥3 cụm)
→ click insight → highlight; nút Deep Research cho gap/bridge
```
**File:** `lib/graph-relevance.ts`, `lib/wiki-graph.ts`, `lib/graph-insights.ts`, `components/graph/*`.

### Flow E — Lint — `lib/lint.ts`
- **Structural** (không cần LLM): orphan (không inbound link), no-outlinks, broken-link — khớp slug case-insensitive.
- **Semantic** (LLM): tóm tắt từng trang (frontmatter + 500 ký tự) → LLM xuất khối `---LINT: type|severity|title---` (contradiction/stale/missing-page/suggestion).

### Flow F — Deep Research — `lib/deep-research.ts`
```
queueResearch (≤ maxConcurrent) → collectResearchSources (web + AnyTXT, dedup, cap 20)
→ streamChat tổng hợp thành trang wiki (cross-ref [[wikilink]] vào index có sẵn, cite [N])
→ lưu wiki/queries/research-<slug>-<date>.md (strip <think>) → auto-ingest
```
Topic do `optimize-research-topic.ts` tinh chỉnh (đọc overview.md + purpose.md) khi kích từ Graph Insights.

### Flow G — Xóa nguồn (cascade) — `lib/source-lifecycle.ts::deleteSourceFiles`
```
xóa file nguồn + cache + ingest-cache
→ quét mọi trang wiki, đọc frontmatter sources[]:
    - trang chỉ thuộc nguồn này  → xóa (cascadeDeleteWikiPagesWithRefs)
    - trang dùng chung nhiều nguồn → chỉ gỡ nguồn này khỏi sources[] (giữ trang)
→ dọn index.md, gỡ [[wikilink]] chết, gỡ khỏi related: ; gỡ embedding khỏi LanceDB
  *(Lưu ý: trang chia sẻ nhiều nguồn chỉ gỡ nguồn khỏi frontmatter — nội dung đã cập nhật **không tự động được embed lại** vào LanceDB)*
→ append log.md
```

### Flow H — Local HTTP API + AI Agent Skill — `api_server.rs`
`127.0.0.1:19828/api/v1`: `/health`, `/projects`, `/projects/{id}/files`, `/projects/{id}/files/{path}/content`, `POST /projects/{id}/search` (hybrid: tokenHits+vectorHits), `/projects/{id}/graph`, `POST /projects/{id}/sources/rescan`. Bảo mật: token (env `LLM_WIKI_API_TOKEN` hoặc store), so sánh constant-time, rate-limit 120 req/s, `safe_join` chống path-traversal, chỉ expose `purpose.md/schema.md/wiki/raw/sources`. Agent skill cài qua `npx skills add`.

### Flow I — Web Clipper (Chrome extension `extension/`)
Readability.js + Turndown.js → markdown → POST tới clip_server (19827) → clip-watcher (poll 3s) → auto-ingest.

---

## 6. Các vấn đề khó & cách giải quyết (bài học chắt lọc)

| Vấn đề | Giải pháp trong mã |
|--------|--------------------|
| LLM "khám phá lại" tri thức mỗi query (RAG) | Wiki bền vững, **biên dịch 1 lần** — ingest tích hợp vào trang có sẵn, query chỉ đọc wiki đã tổng hợp. |
| Chất lượng ingest 1-bước kém | **Two-stage analysis→generation**: Stage 1 phân tích (`buildAnalysisPrompt`), Stage 2 sinh trang (`buildGenerationPrompt`) — tách phân tích khỏi formatting (prompt tắt chain-of-thought; đây là 2-stage pipeline, không phải CoT nội bộ của model). |
| Tốn token re-ingest file không đổi | **SHA256 incremental cache** (`ingest-cache.ts`); HIT thì bỏ LLM nhưng vẫn chạy lại trích ảnh idempotent. |
| Parse output LLM cực dễ vỡ | `parseFileBlocks` (ingest.ts) fix 6 lớp lỗi: CRLF, stream cụt (cảnh báo thay vì im lặng), biến thể marker hoa/thường/space, `---END FILE---` nằm trong code-fence (theo dõi fence depth CommonMark), path rỗng. |
| Prompt-injection ghi đè file hệ thống | `isSafeIngestPath`: chỉ cho ghi dưới `wiki/`, cấm `..`, đường tuyệt đối, ký tự/tên thiết bị Windows. Tầng Rust `safe_join` canonicalize chống traversal cho API. |
| Trang đụng độ giữa nhiều nguồn | `page-merge.ts`: union mảng frontmatter (sources/tags/related) + nếu body khác thì LLM merge + khóa field (type/title/created), fallback an toàn + backup. |
| LLM strip ảnh alt-rỗng khi tóm tắt | Caption ảnh bằng vision model (`image-caption-pipeline.ts`), nhồi caption vào alt → mang đủ "tải ngữ nghĩa" để LLM giữ ảnh; cache theo **SHA256 bytes ảnh** (logo chung caption 1 lần). + safety-net luôn append ảnh vào source-summary. |
| Nguồn quá dài vượt context | `analyzeLongSourceInChunks`: chunk có **overlap** + heading path + global digest + **checkpoint** (resume được). |
| Crash giữa chừng / app đóng | Queue persist `ingest-queue.json`; task "processing" → revert "pending" khi restore; cancel dọn file đã ghi + chunk LanceDB. |
| Đổi project giữa lúc ingest | **Stale-context guard**: so `currentProjectId` sau mỗi await; `pauseQueue`/`restoreQueue` handshake; mutex per-project. |
| Endpoint LLM "nghĩ" mà không trả lời | `reasoning-detector.ts` đếm reasoning vs content; nếu chỉ có reasoning → báo lỗi rõ thay vì trả "" im lặng. Phân biệt timeout backstop (30') vs network fail. |
| CORS chặn LLM API từ webview | Fetch từ **Rust** (`tauri-plugin-http`) — request rời app từ Rust, không từ webview. |
| Review cũ tồn đọng | `sweep-reviews.ts` khi queue cạn: Stage 1 luật (tên file/title/affectedPages), Stage 2 LLM phán đoán theo batch — bảo thủ, giữ contradiction/suggestion cho người. |
| Wikilink tên ≠ id (hoa thường, dấu cách) | `resolveTarget`/`resolve_link`: thử id → lowercase → thay space bằng `-` ; chỉ tạo edge khi cả 2 đầu tồn tại. |
| Search tiếng Trung | Tokenize **CJK bigram** (cả Rust `search.rs` lẫn TS `search.ts`) + stopwords song ngữ. |
| Multi-provider streaming khác wire | `llm-providers.ts` buildBody/parseStream theo provider (OpenAI top-level vs Gemini `generationConfig`); 404 Azure → gợi ý deployment name. |
| Phân bổ context window | `context-budget.ts`: index 5% / pages 50% / reserve 15%, per-page cap co giãn (bỏ cap cứng 30K cũ). |
| Giữ Unicode/CJK trong JSON & path | normalizePath thống nhất 22+ file; slice theo char (không byte) cho tên file CJK. |

---

## 7. Đối chiếu & gợi ý áp dụng cho qidian

- **Pattern tái dùng được**: ingest 2-stage analysis→generation, parse khối `---FILE---` chịu lỗi, merge trang theo nguồn, hàng đợi nối tiếp persist + retry + stale-guard, cascade-delete theo `sources[]`, đồ thị 4-signal + Louvain, lọc spoiler theo chương (qidian có thể map "first_chapter" như cách llm_wiki gắn `sources[]`).
- **Khác biệt kiến trúc**: llm_wiki = Tauri/Rust + React + **file markdown trên đĩa** (wiki là Obsidian vault, git-friendly) + LanceDB tùy chọn. qidian hiện dùng **SQLite (`state.db`)** + React CDN (xem [[frontend-react-cdn-stack]]). Nếu port ý tưởng: giữ "wiki = markdown + frontmatter + wikilink" hoặc map các thực thể vào bảng DB, nhưng nên học cách **tách lớp raw (bất biến) / wiki (LLM sinh) / schema (luật)**.
- **Điểm mạnh đáng mượn cho pipeline dịch truyện qidian**: SHA256 cache để khỏi dịch lại chương không đổi; sanitize + guard output LLM; activity panel tiến trình; multi-provider LLM (kể cả Claude Code/Codex CLI subprocess).
- **Để chạy/khám phá thêm**: `npm run tauri dev`; bản đồ command nằm ở `src-tauri/src/lib.rs` (invoke_handler); pipeline trung tâm ở `src/lib/ingest.ts`.
