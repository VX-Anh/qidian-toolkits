import asyncio
import json
import sqlite3
from enum import Enum
from pathlib import Path
from typing import Optional


class ChapterStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    DONE = "done"
    FAILED = "failed"


class SharedState:
    def __init__(self, db_path: str = "backend/db/state.db"):
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = asyncio.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_db()

    def _init_db(self):
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS chapters (
                filename        TEXT PRIMARY KEY,
                novel_slug      TEXT,
                chapter_num     INTEGER,
                zh_title        TEXT,
                vi_title        TEXT,
                status          TEXT DEFAULT 'pending',
                translated_path TEXT,
                summary         TEXT,
                error           TEXT,
                updated_at      TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS flagged_terms (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                zh_term  TEXT NOT NULL,
                context  TEXT,
                chapter  TEXT,
                resolved INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS reviews (
                filename    TEXT PRIMARY KEY,
                novel_slug  TEXT,
                status      TEXT,
                issues      TEXT,
                reviewed_at TEXT DEFAULT (datetime('now'))
            );
        """)
        self._conn.commit()
        try:
            self._conn.execute("ALTER TABLE chapters ADD COLUMN ocr_job_id TEXT")
            self._conn.commit()
        except Exception:
            pass

    # ── Chapters ──────────────────────────────────────────────────────────────

    async def upsert_chapter(self, filename: str, novel_slug: str,
                              chapter_num: int, zh_title: str, ocr_job_id: str = None):
        async with self._lock:
            self._conn.execute(
                """INSERT INTO chapters(filename, novel_slug, chapter_num, zh_title, ocr_job_id)
                   VALUES(?,?,?,?,?)
                   ON CONFLICT(filename) DO UPDATE SET
                       ocr_job_id=COALESCE(excluded.ocr_job_id, ocr_job_id)""",
                [filename, novel_slug, chapter_num, zh_title, ocr_job_id],
            )
            self._conn.commit()

    async def set_status(self, filename: str, status: ChapterStatus, **kwargs):
        async with self._lock:
            sets = ", ".join(f"{k}=?" for k in kwargs)
            extra = (", " + sets) if sets else ""
            self._conn.execute(
                f"UPDATE chapters SET status=?, updated_at=datetime('now'){extra} WHERE filename=?",
                [status.value, *kwargs.values(), filename],
            )
            self._conn.commit()

    def get_chapters(self, novel_slug: Optional[str] = None) -> list[dict]:
        if novel_slug:
            rows = self._conn.execute(
                "SELECT * FROM chapters WHERE novel_slug=? ORDER BY chapter_num",
                [novel_slug],
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM chapters ORDER BY novel_slug, chapter_num"
            ).fetchall()
        return [dict(r) for r in rows]

    def get_chapter(self, filename: str) -> Optional[dict]:
        row = self._conn.execute(
            "SELECT * FROM chapters WHERE filename=?", [filename]
        ).fetchone()
        return dict(row) if row else None

    async def save_summary(self, filename: str, summary: str):
        async with self._lock:
            self._conn.execute(
                "UPDATE chapters SET summary=? WHERE filename=?", [summary, filename]
            )
            self._conn.commit()

    def get_summary(self, filename: str) -> Optional[str]:
        row = self._conn.execute(
            "SELECT summary FROM chapters WHERE filename=?", [filename]
        ).fetchone()
        return row["summary"] if row else None

    # ── Flagged terms ─────────────────────────────────────────────────────────

    async def flag_term(self, zh_term: str, context: str, chapter: str):
        async with self._lock:
            exists = self._conn.execute(
                "SELECT 1 FROM flagged_terms WHERE zh_term=? AND chapter=?",
                [zh_term, chapter],
            ).fetchone()
            if not exists:
                self._conn.execute(
                    "INSERT INTO flagged_terms(zh_term, context, chapter) VALUES(?,?,?)",
                    [zh_term, context, chapter],
                )
                self._conn.commit()

    def get_flagged_terms(self, resolved: bool = False) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM flagged_terms WHERE resolved=?", [int(resolved)]
        ).fetchall()
        return [dict(r) for r in rows]

    async def resolve_term(self, zh_term: str):
        async with self._lock:
            self._conn.execute(
                "UPDATE flagged_terms SET resolved=1 WHERE zh_term=?", [zh_term]
            )
            self._conn.commit()

    # ── Reviews ───────────────────────────────────────────────────────────────

    def get_chapter_review(self, filename: str) -> Optional[dict]:
        row = self._conn.execute(
            "SELECT * FROM reviews WHERE filename=?", [filename]
        ).fetchone()
        return dict(row) if row else None

    async def save_review(self, filename: str, novel_slug: str, status: str, issues: str):
        async with self._lock:
            self._conn.execute(
                """INSERT INTO reviews(filename, novel_slug, status, issues)
                   VALUES(?,?,?,?)
                   ON CONFLICT(filename) DO UPDATE SET
                       status=excluded.status,
                       issues=excluded.issues,
                       reviewed_at=datetime('now')""",
                [filename, novel_slug, status, issues],
            )
            self._conn.commit()

    def get_reviews(self, novel_slug: Optional[str] = None) -> list[dict]:
        if novel_slug:
            rows = self._conn.execute(
                "SELECT * FROM reviews WHERE novel_slug=? ORDER BY filename",
                [novel_slug],
            ).fetchall()
        else:
            rows = self._conn.execute("SELECT * FROM reviews ORDER BY filename").fetchall()
        return [dict(r) for r in rows]

    async def reset_novel(self, novel_slug: str):
        async with self._lock:
            self._conn.execute(
                "UPDATE chapters SET status='pending', vi_title=NULL, "
                "translated_path=NULL, error=NULL WHERE novel_slug=?",
                [novel_slug],
            )
            self._conn.commit()


class EventQueue:
    """Bridge giữa agent events và SSE endpoint."""

    def __init__(self):
        self._q: asyncio.Queue = asyncio.Queue()
        self._done = False

    async def put(self, event: dict):
        await self._q.put(event)

    async def close(self):
        await self._q.put(None)

    async def cancel(self):
        await self._q.put({"agent": "orchestrator", "type": "cancelled"})
        await self._q.put(None)

    async def stream(self):
        while True:
            event = await self._q.get()
            if event is None:
                break
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
