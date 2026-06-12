import asyncio
import uuid

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..agent.orchestrator import Orchestrator
from ..agent.state import ChapterStatus, EventQueue
from ..config import settings
from ..shared import get_client, get_state

router = APIRouter(prefix="/api/translate", tags=["translate"])

_jobs: dict[str, EventQueue] = {}
_tasks: dict[str, asyncio.Task] = {}


class TranslateRequest(BaseModel):
    novel_slug: str
    chapter_filenames: list[str] | None = None
    force: bool = False
    run_wiki: bool = True


@router.post("/start")
async def start_translation(req: TranslateRequest):
    job_id = str(uuid.uuid4())
    eq = EventQueue()
    _jobs[job_id] = eq

    orch = Orchestrator(
        novel_slug=req.novel_slug,
        input_dir=settings.input_dir,
        output_dir=settings.output_dir,
        rules_dir=settings.rules_dir,
        state=get_state(),
        event_queue=eq,
        client=get_client(),
        chapter_filenames=req.chapter_filenames,
        force=req.force,
        run_wiki=req.run_wiki,
    )

    task = asyncio.create_task(orch.run())
    _tasks[job_id] = task
    return {"job_id": job_id}


class WikiIngestRequest(BaseModel):
    novel_slug: str
    chapter_filenames: list[str]


@router.post("/wiki")
async def wiki_ingest(req: WikiIngestRequest):
    """Đưa các chương đã chọn vào Story-Wiki (tách rời khỏi bước dịch).

    Stream qua chung `/api/translate/stream/{job_id}` — phát các event của
    WikiAgent rồi kết thúc bằng `wiki_done`.
    """
    from ..agent.novel_loader import load_novel
    from ..agent.wiki_agent import WikiAgent

    state = get_state()
    try:
        profile = load_novel(settings.rules_dir, req.novel_slug)
    except FileNotFoundError:
        raise HTTPException(404, f"Không tìm thấy rules/{req.novel_slug}/novel.md")

    # Chỉ ingest chương có file nguồn .txt (còn Hán tự để trích thực thể).
    targets = [fn for fn in req.chapter_filenames if (settings.input_dir / fn).exists()]
    if not targets:
        raise HTTPException(400, "Không có chương nào có file nguồn để đưa vào Wiki")

    job_id = str(uuid.uuid4())
    eq = EventQueue()
    _jobs[job_id] = eq

    async def run_wiki():
        try:
            await eq.put({"agent": "orchestrator", "type": "wiki_ingest", "count": len(targets)})
            for fn in targets:
                chapter_info = state.get_chapter(fn)
                num = chapter_info["chapter_num"] if chapter_info else 0
                try:
                    agent = WikiAgent(
                        filename=fn,
                        novel_slug=req.novel_slug,
                        chapter_num=num,
                        source_content=(settings.input_dir / fn).read_text(encoding="utf-8"),
                        profile=profile,
                        state=state,
                        client=get_client(),
                    )
                    async for event in agent.run():
                        await eq.put(event.to_dict())
                except Exception as exc:
                    await eq.put({"agent": "wiki", "type": "error", "file": fn, "error": str(exc)})
            await eq.put({"agent": "orchestrator", "type": "wiki_done", "novel": req.novel_slug})
        finally:
            await eq.close()

    task = asyncio.create_task(run_wiki())
    _tasks[job_id] = task
    return {"job_id": job_id, "count": len(targets)}


@router.get("/stream/{job_id}")
async def stream_events(job_id: str):
    eq = _jobs.get(job_id)
    if eq is None:
        raise HTTPException(404, "Job không tồn tại")

    return StreamingResponse(
        eq.stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.delete("/jobs/{job_id}")
async def cancel_job(job_id: str):
    eq = _jobs.pop(job_id, None)
    task = _tasks.pop(job_id, None)

    if eq:
        await eq.cancel()

    if task and not task.done():
        task.cancel()

    return {"ok": True}


class RetranslateRequest(BaseModel):
    novel_slug: str
    chapter_filenames: list[str] | None = None


@router.post("/retranslate")
async def retranslate_needs_fix(req: RetranslateRequest):
    state = get_state()
    if req.chapter_filenames:
        needs_fix = req.chapter_filenames
    else:
        reviews = state.get_reviews(req.novel_slug)
        needs_fix = [r["filename"] for r in reviews if r["status"] == "needs_fix"]
    if not needs_fix:
        raise HTTPException(400, "Không có chương nào cần sửa")

    for filename in needs_fix:
        await state.set_status(filename, ChapterStatus.PENDING)

    job_id = str(uuid.uuid4())
    eq = EventQueue()
    _jobs[job_id] = eq

    orch = Orchestrator(
        novel_slug=req.novel_slug,
        input_dir=settings.input_dir,
        output_dir=settings.output_dir,
        rules_dir=settings.rules_dir,
        state=state,
        event_queue=eq,
        client=get_client(),
        chapter_filenames=needs_fix,
    )
    task = asyncio.create_task(orch.run())
    _tasks[job_id] = task
    return {"job_id": job_id, "count": len(needs_fix)}


class ExtractRequest(BaseModel):
    novel_slug: str


@router.post("/extract")
async def extract_terms(req: ExtractRequest):
    from ..agent.extractor import ExtractorAgent

    job_id = str(uuid.uuid4())
    eq = EventQueue()
    _jobs[job_id] = eq

    async def run_extractor():
        agent = ExtractorAgent(
            slug=req.novel_slug,
            state=get_state(),
            client=get_client(),
            rules_dir=settings.rules_dir,
        )
        async for event in agent.run():
            await eq.put(event.to_dict())
        await eq.close()

    task = asyncio.create_task(run_extractor())
    _tasks[job_id] = task
    return {"job_id": job_id}
