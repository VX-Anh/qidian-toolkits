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

Each agent follows a **ReAct loop** in `backend/agent/base.py`: call OpenAI → if tool_calls → execute tools in parallel → append results → repeat until no tool calls.

**Key files:**
- `backend/agent/base.py` — BaseAgent ReAct loop, AgentEvent dataclass
- `backend/agent/tools.py` — ToolRegistry, each agent builds its own registry via closure (captures chapter state without globals)
- `backend/agent/state.py` — SharedState (SQLite, asyncio.Lock), EventQueue (SSE bridge with sentinel pattern)
- `backend/agent/novel_loader.py` — Parses `rules/{slug}/novel.md` (YAML frontmatter + markdown tables) → NovelProfile
- `backend/agent/orchestrator.py` — Not a ReAct agent; pure asyncio coordination harness
- `backend/agent/translator.py` — TranslatorAgent: chunks content, injects NovelProfile.system_prompt()
- `backend/agent/extractor.py` — ExtractorAgent: resolves flagged terms → appends to novel.md

**Data flow:**
- Input: `$INPUT_DIR/*.txt` — filename encodes chapter number: `第675章 天演.txt`
- Output: `$OUTPUT_DIR/{novel_slug}/Chuong_{num:04d}_{vi_title}.txt`
- Per-novel config: `rules/{slug}/novel.md` — single source of truth for glossary + custom prompt

**SSE pattern:**
`POST /api/translate/start` → returns `job_id` → client opens `GET /api/translate/stream/{job_id}` (EventSource). EventQueue closes with `None` sentinel when Orchestrator finishes.

## Novel Config (novel.md)

Each novel has its own `rules/{slug}/novel.md` with:
- YAML frontmatter: `zh_name`, `vi_name`, `genre`, `style`
- `## Prompt dịch` section: injected as system prompt for TranslatorAgent
- Markdown tables: `## Nhân vật`, `## Địa danh`, `## Cảnh giới tu luyện`, `## Kỹ năng / Pháp thuật`
- ExtractorAgent appends new terms to these tables after each batch

## Environment

Copy `.env.example` → `.env`, fill in:
- `OPENAI_API_KEY`
- `INPUT_DIR` — path to folder containing Chinese .txt chapters
- `OUTPUT_DIR` — path for translated output
- `CONCURRENCY` — parallel TranslatorAgents (default 3)
