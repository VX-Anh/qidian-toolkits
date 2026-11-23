# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install
uv sync

# Run server (from project root) — tự reload khi save .py, .html, .css, .js
uv run uvicorn backend.main:app --reload --reload-include "*.html" --reload-include "*.css" --reload-include "*.js" --port 9999

# Single file test
uv run python -c "from backend.agent.novel_loader import load_novel; from pathlib import Path; print(load_novel(Path('rules'), 'your-slug'))"
```

## Architecture

**Multi-agent translation pipeline:**

```
Orchestrator → TranslatorAgent × N (parallel, semaphore-limited)
                     ↓ after all done
             ExtractorAgent → updates novel.md
```

Each agent follows a **ReAct loop** in `backend/agent/base.py`: call Gemini (native `google-genai` SDK, streaming) → if function calls → execute tools in parallel → append results → repeat until no tool calls. The model's turn (including the `thought_signature` on each `function_call` part) is appended verbatim to `self.history` — required so Gemini 3 doesn't reject multi-turn tool calls with `400 missing thought_signature`.

**Key files:**
- `backend/agent/base.py` — BaseAgent ReAct loop, AgentEvent dataclass
- `backend/agent/tools.py` — ToolRegistry, each agent builds its own registry via closure (captures chapter state without globals)
- `backend/agent/state.py` — SharedState (SQLite, one `threading.RLock` guarding the shared connection), EventQueue (SSE broadcast: every subscriber gets replayed history + live events; token events are live-only)
- `backend/jobs.py` — JobRegistry: background tasks per job, closes queues of dead tasks, drops finished jobs after 10 min, one translate/extract job per novel
- `backend/safety.py` — slug/filename validation + `safe_child()`; every client value joined into a path must go through it
- `backend/agent/novel_loader.py` — Parses `rules/{slug}/novel.md` (YAML frontmatter + markdown tables) → NovelProfile
- `backend/agent/orchestrator.py` — Not a ReAct agent; pure asyncio coordination harness
- `backend/agent/translator.py` — TranslatorAgent: sends the whole chapter in one message (glossary names pre-substituted), injects NovelProfile.system_prompt()
- `backend/agent/extractor.py` — ExtractorAgent: resolves flagged terms → appends to novel.md

**Data flow:**
- Input: `$INPUT_DIR/*.txt` — filename encodes chapter number: `第675章 天演.txt`
- Output: `$OUTPUT_DIR/{novel_slug}/Chuong_{num:04d}_{vi_title}.txt`
- Per-novel config: `rules/{slug}/novel.md` — single source of truth for glossary + custom prompt

**SSE pattern:**
`POST /api/translate/start` → returns `job_id` → client opens `GET /api/translate/stream/{job_id}` (EventSource). The stream ends when the job finishes; reopening it replays the history. Treat `onerror` as "ended" only when `readyState === CLOSED` (otherwise the browser is reconnecting).

## Auth

`API_TOKEN` (empty = no auth, local only) protects `/api/*`: cookie from `/login`, `X-API-Token` / `Authorization: Bearer` header, or `?token=` for EventSource. `DEV_MODE=true` enables FastAPI debug + `/_dev/ping` browser auto-reload.

## Novel Config (novel.md)

Each novel has its own `rules/{slug}/novel.md` with:
- YAML frontmatter: `zh_name`, `vi_name`, `genre`, `style`
- `## Prompt dịch` section: injected as system prompt for TranslatorAgent
- Markdown tables: `## Nhân vật`, `## Địa danh`, `## Cảnh giới tu luyện`, `## Kỹ năng / Pháp thuật`
- ExtractorAgent appends new terms to these tables after each batch

## Environment

**Auth (Vertex AI):** Application Default Credentials — run once:
```bash
gcloud auth application-default login
gcloud config set project <PROJECT_ID>
```
(or point `GOOGLE_APPLICATION_CREDENTIALS` at a service-account JSON).

Copy `.env.example` → `.env`, fill in:
- `GOOGLE_CLOUD_PROJECT` — GCP project id (Vertex)
- `GOOGLE_CLOUD_LOCATION` — default `global`
- `GEMINI_MODEL` / `GEMINI_VISION_MODEL` — default `gemini-3.5-flash`
- `THINKING_LEVEL` — `LOW` (default) | `MEDIUM` | `HIGH` | `MINIMAL`. Gemini 3 can't disable thinking; `LOW` keeps translation fast/cheap.
- `INPUT_DIR` / `OUTPUT_DIR` / `CONCURRENCY`

**LLM client:** `backend/shared.py:get_client()` returns a single
`google.genai.Client(vertexai=True, project=, location=)`. Agents call
`client.aio.models.generate_content_stream(...)`. The streaming + function-call +
vision loop lives in `base.py`; per-call config (system_instruction, `thinking_level`,
tools, `stream_function_call_arguments`) is built in `BaseAgent._gen_config()`.
`ToolRegistry.genai_tools()` produces `types.Tool` / `FunctionDeclaration` from
Python type hints.
