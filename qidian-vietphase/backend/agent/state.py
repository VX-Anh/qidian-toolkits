import asyncio
import hashlib
import json
import sqlite3
import threading
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
        # threading.RLock — guard DUY NHẤT cho mọi truy cập connection, giữa
        # event-loop thread (writer async) và threadpool thread (route sync FastAPI
        # gọi getter). Writer async không bao giờ await khi đang giữ lock nên trên
        # event loop đơn-luồng chúng tự tuần tự; đảm bảo atomic read-modify-write
        # và loại bỏ truy cập connection đồng thời từ nhiều thread.
        self._tlock = threading.RLock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        # WAL: reader không chặn writer & ngược lại; busy_timeout: chờ thay vì lỗi.
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.execute("PRAGMA synchronous=NORMAL")
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

            -- ── Story-wiki (LLM-Wiki Phase 1): tầng làm giàu/ngữ cảnh ──────────
            -- Khóa liên kết với novel.md = chuỗi Hán `zh`. novel.md vẫn là vua
            -- cho bản dịch `vi`; bảng này thêm description/alias/quan hệ/sự kiện.
            CREATE TABLE IF NOT EXISTS entities (
                novel_slug    TEXT NOT NULL,
                zh            TEXT NOT NULL,
                vi            TEXT,
                type          TEXT DEFAULT 'character',   -- character|place|realm|skill|other
                description   TEXT DEFAULT '',
                aliases       TEXT DEFAULT '[]',          -- JSON array các zh đồng nghĩa
                first_chapter INTEGER,
                freq          INTEGER DEFAULT 1,
                status        TEXT DEFAULT 'pending',      -- pending|approved|rejected
                updated_at    TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (novel_slug, zh)
            );
            CREATE TABLE IF NOT EXISTS relationships (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                novel_slug    TEXT NOT NULL,
                from_zh       TEXT NOT NULL,
                to_zh         TEXT NOT NULL,
                type          TEXT DEFAULT '',
                description   TEXT DEFAULT '',
                first_chapter INTEGER,
                UNIQUE (novel_slug, from_zh, to_zh, type)
            );
            CREATE TABLE IF NOT EXISTS events (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                novel_slug    TEXT NOT NULL,
                chapter_num   INTEGER,
                description   TEXT NOT NULL,
                characters    TEXT DEFAULT '[]',          -- JSON array các zh
                dedupe_hash   TEXT,
                UNIQUE (novel_slug, dedupe_hash)
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
        with self._tlock:
            self._conn.execute(
                """INSERT INTO chapters(filename, novel_slug, chapter_num, zh_title, ocr_job_id)
                   VALUES(?,?,?,?,?)
                   ON CONFLICT(filename) DO UPDATE SET
                       ocr_job_id=COALESCE(excluded.ocr_job_id, ocr_job_id)""",
                [filename, novel_slug, chapter_num, zh_title, ocr_job_id],
            )
            self._conn.commit()

    async def set_status(self, filename: str, status: ChapterStatus, **kwargs):
        with self._tlock:
            sets = ", ".join(f"{k}=?" for k in kwargs)
            extra = (", " + sets) if sets else ""
            self._conn.execute(
                f"UPDATE chapters SET status=?, updated_at=datetime('now'){extra} WHERE filename=?",
                [status.value, *kwargs.values(), filename],
            )
            self._conn.commit()

    def get_chapters(self, novel_slug: Optional[str] = None) -> list[dict]:
        with self._tlock:
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
        with self._tlock:
            row = self._conn.execute(
                "SELECT * FROM chapters WHERE filename=?", [filename]
            ).fetchone()
        return dict(row) if row else None

    async def save_summary(self, filename: str, summary: str):
        with self._tlock:
            self._conn.execute(
                "UPDATE chapters SET summary=? WHERE filename=?", [summary, filename]
            )
            self._conn.commit()

    def get_summary(self, filename: str) -> Optional[str]:
        with self._tlock:
            row = self._conn.execute(
                "SELECT summary FROM chapters WHERE filename=?", [filename]
            ).fetchone()
        return row["summary"] if row else None

    # ── Flagged terms ─────────────────────────────────────────────────────────

    async def flag_term(self, zh_term: str, context: str, chapter: str):
        with self._tlock:
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
        with self._tlock:
            rows = self._conn.execute(
                "SELECT * FROM flagged_terms WHERE resolved=?", [int(resolved)]
            ).fetchall()
        return [dict(r) for r in rows]

    async def resolve_term(self, zh_term: str):
        with self._tlock:
            self._conn.execute(
                "UPDATE flagged_terms SET resolved=1 WHERE zh_term=?", [zh_term]
            )
            self._conn.commit()

    # ── Reviews ───────────────────────────────────────────────────────────────

    def get_chapter_review(self, filename: str) -> Optional[dict]:
        with self._tlock:
            row = self._conn.execute(
                "SELECT * FROM reviews WHERE filename=?", [filename]
            ).fetchone()
        return dict(row) if row else None

    async def save_review(self, filename: str, novel_slug: str, status: str, issues: str):
        with self._tlock:
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
        with self._tlock:
            if novel_slug:
                rows = self._conn.execute(
                    "SELECT * FROM reviews WHERE novel_slug=? ORDER BY filename",
                    [novel_slug],
                ).fetchall()
            else:
                rows = self._conn.execute("SELECT * FROM reviews ORDER BY filename").fetchall()
        return [dict(r) for r in rows]

    # ── Story-wiki: entities ──────────────────────────────────────────────────

    def _entity_dict(self, row) -> dict:
        d = dict(row)
        d["aliases"] = json.loads(d.get("aliases") or "[]")
        return d

    async def upsert_entity(
        self,
        novel_slug: str,
        zh: str,
        vi: Optional[str] = None,
        type: str = "character",
        description: str = "",
        aliases: Optional[list[str]] = None,
        first_chapter: Optional[int] = None,
    ):
        """Thêm/gộp một thực thể. Idempotent: gọi lại gộp thông minh.

        Quy tắc merge (novel.md là vua cho `vi`):
        - vi: giữ nguyên nếu đã `approved`; nếu chưa thì lấy vi mới (khi có).
        - description: giữ bản dài hơn.
        - aliases: hợp (union) giữ thứ tự.
        - first_chapter: lấy min (chương xuất hiện sớm nhất).
        - freq: +1 mỗi lần gặp lại.
        """
        aliases = aliases or []
        with self._tlock:
            row = self._conn.execute(
                "SELECT * FROM entities WHERE novel_slug=? AND zh=?",
                [novel_slug, zh],
            ).fetchone()
            if row is None:
                self._conn.execute(
                    """INSERT INTO entities(novel_slug, zh, vi, type, description,
                                            aliases, first_chapter, freq)
                       VALUES(?,?,?,?,?,?,?,1)""",
                    [novel_slug, zh, vi, type or "character", description or "",
                     json.dumps(aliases, ensure_ascii=False), first_chapter],
                )
            else:
                old = dict(row)
                new_vi = old["vi"] if old["status"] == "approved" else (vi or old["vi"])
                old_desc = old["description"] or ""
                new_desc = description if len(description or "") > len(old_desc) else old_desc
                merged = list(dict.fromkeys((json.loads(old["aliases"] or "[]")) + aliases))
                fc = old["first_chapter"]
                if first_chapter is not None:
                    fc = first_chapter if fc is None else min(fc, first_chapter)
                self._conn.execute(
                    """UPDATE entities SET vi=?, type=?, description=?, aliases=?,
                           first_chapter=?, freq=freq+1, updated_at=datetime('now')
                       WHERE novel_slug=? AND zh=?""",
                    [new_vi, type or old["type"], new_desc,
                     json.dumps(merged, ensure_ascii=False), fc, novel_slug, zh],
                )
            self._conn.commit()

    def get_entities(self, novel_slug: str, up_to: Optional[int] = None) -> list[dict]:
        with self._tlock:
            if up_to is not None:
                rows = self._conn.execute(
                    """SELECT * FROM entities WHERE novel_slug=?
                       AND (first_chapter IS NULL OR first_chapter<=?)
                       ORDER BY type, freq DESC, zh""",
                    [novel_slug, up_to],
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT * FROM entities WHERE novel_slug=? ORDER BY type, freq DESC, zh",
                    [novel_slug],
                ).fetchall()
        return [self._entity_dict(r) for r in rows]

    def get_entity(self, novel_slug: str, zh: str) -> Optional[dict]:
        with self._tlock:
            row = self._conn.execute(
                "SELECT * FROM entities WHERE novel_slug=? AND zh=?", [novel_slug, zh]
            ).fetchone()
        return self._entity_dict(row) if row else None

    # ── Story-wiki: relationships ─────────────────────────────────────────────

    async def add_relationship(
        self,
        novel_slug: str,
        from_zh: str,
        to_zh: str,
        type: str = "",
        description: str = "",
        first_chapter: Optional[int] = None,
    ):
        """Thêm/gộp quan hệ. Idempotent theo (novel_slug, from_zh, to_zh, type)."""
        with self._tlock:
            self._conn.execute(
                """INSERT INTO relationships(novel_slug, from_zh, to_zh, type,
                                             description, first_chapter)
                   VALUES(?,?,?,?,?,?)
                   ON CONFLICT(novel_slug, from_zh, to_zh, type) DO UPDATE SET
                       description=CASE
                           WHEN length(excluded.description) > length(relationships.description)
                           THEN excluded.description ELSE relationships.description END,
                       first_chapter=CASE
                           WHEN relationships.first_chapter IS NULL THEN excluded.first_chapter
                           WHEN excluded.first_chapter IS NULL THEN relationships.first_chapter
                           ELSE min(relationships.first_chapter, excluded.first_chapter) END""",
                [novel_slug, from_zh, to_zh, type or "", description or "", first_chapter],
            )
            self._conn.commit()

    def get_relationships(self, novel_slug: str, up_to: Optional[int] = None) -> list[dict]:
        with self._tlock:
            if up_to is not None:
                rows = self._conn.execute(
                    """SELECT * FROM relationships WHERE novel_slug=?
                       AND (first_chapter IS NULL OR first_chapter<=?)""",
                    [novel_slug, up_to],
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT * FROM relationships WHERE novel_slug=?", [novel_slug]
                ).fetchall()
        return [dict(r) for r in rows]

    # ── Story-wiki: events ────────────────────────────────────────────────────

    async def add_event(
        self,
        novel_slug: str,
        chapter_num: Optional[int],
        description: str,
        characters: Optional[list[str]] = None,
    ):
        """Thêm sự kiện. Idempotent qua dedupe_hash.

        Hash gồm cả `characters` (đã sort) để 2 sự kiện cùng chương, mô tả giống
        nhau nhưng nhân vật khác KHÔNG bị gộp nhầm.
        """
        characters = characters or []
        key = f"{chapter_num}|{description}|{','.join(sorted(characters))}"
        dedupe = hashlib.sha256(key.encode("utf-8")).hexdigest()
        with self._tlock:
            self._conn.execute(
                """INSERT OR IGNORE INTO events(novel_slug, chapter_num, description,
                                                characters, dedupe_hash)
                   VALUES(?,?,?,?,?)""",
                [novel_slug, chapter_num, description,
                 json.dumps(characters, ensure_ascii=False), dedupe],
            )
            self._conn.commit()

    def get_events(self, novel_slug: str, up_to: Optional[int] = None) -> list[dict]:
        with self._tlock:
            if up_to is not None:
                rows = self._conn.execute(
                    """SELECT * FROM events WHERE novel_slug=? AND chapter_num<=?
                       ORDER BY chapter_num, id""",
                    [novel_slug, up_to],
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT * FROM events WHERE novel_slug=? ORDER BY chapter_num, id",
                    [novel_slug],
                ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["characters"] = json.loads(d.get("characters") or "[]")
            out.append(d)
        return out

    async def reset_novel(self, novel_slug: str):
        with self._tlock:
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
