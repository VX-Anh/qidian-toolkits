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

Each agent follows a **ReAct loop** in `backend/agent/base.py`: call Claude (`anthropic` SDK, `client.beta.messages.stream`) → if `tool_use` blocks → validate inputs, run tools in parallel → return all `tool_result`s in ONE user message → repeat until no tool calls. `response.content` is appended verbatim (thinking / fallback blocks included). Tools use `eager_input_streaming` so `save_chapter.content` streams to the UI (parsed from `partial_json` with `jiter` trailing-strings); because the server no longer validates those inputs, `ToolRegistry.validate` does. `max_tokens` with a `tool_use` or `refusal` raises (chapter → FAILED).

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

Copy `.env.example` → `.env`, fill in:
- `ANTHROPIC_API_KEY` (or `ANTHROPIC_API_KEY_FILE` → file containing the key; Docker uses this)
- `MODEL_TRANSLATE` (default `claude-sonnet-5-5`), `MODEL_LIGHT` (extractor/reviewer/wiki, `claude-haiku-5-5`), `MODEL_VISION` (OCR, `claude-sonnet-5-5`)
- `LLM_EFFORT` — `low` (default) … `max`; sent as `output_config.effort`
- `INPUT_DIR` / `OUTPUT_DIR` / `CONCURRENCY`

- `TRANSLATE_PROVIDER` — `api` (default) or `cli`: translate chapters with the Claude Code CLI (`claude -p` headless, subscription login) via `backend/agent/cli_translator.py`. No tool use there: the model returns `<tieu_de>/<ban_dich>/<tom_tat>/<thuat_ngu>` and the backend calls the same `save_chapter`/`save_summary`/`flag_unknown_term`. CLI failure (not logged in, quota, timeout) → `CliUnavailable` → retried with the API when `CLI_FALLBACK_API=true`. Extractor/reviewer/wiki/OCR always use the API. Settings: `CLI_BIN`, `CLI_MODEL`, `CLI_EFFORT`, `CLI_TIMEOUT`. On Windows run uvicorn without `--reload` when using the CLI (reload uses a SelectorEventLoop, which cannot spawn subprocesses; translations would fall back to the API).

Do not name settings with a `CLAUDE_` prefix: Claude Code exports variables such as `CLAUDE_EFFORT`, which pydantic-settings would pick up.

**LLM client:** `backend/shared.py:get_client()` returns one `anthropic.AsyncAnthropic` (SDK retries 408/409/429/5xx, `LLM_RETRY_ATTEMPTS`). Request config is built in `BaseAgent._request_kwargs()`: cached system prompt + top-level `cache_control`, effort, tools from `ToolRegistry.anthropic_tools()` (JSON Schema from Python type hints), and server-side refusal fallback (`fallbacks: "default"`) on models that support it (`base.fallback_kwargs`). Every model call first takes the shared `RateLimiter`.
