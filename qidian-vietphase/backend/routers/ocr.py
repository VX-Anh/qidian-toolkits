import asyncio
import uuid
from typing import List, Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from ..agent.ocr_processor import run_ocr
from ..agent.state import EventQueue
from ..config import settings
from ..shared import get_client, get_state

router = APIRouter(prefix="/api/ocr", tags=["ocr"])

_ocr_jobs: dict[str, EventQueue] = {}
_ocr_tasks: dict[str, asyncio.Task] = {}
_ocr_meta: dict[str, dict] = {}


@router.post("/upload")
async def upload_ocr(
    novel_slug: str = Form(...),
    chapter_title: str = Form(""),
    images: List[UploadFile] = File(...),
):
    job_id = str(uuid.uuid4())
    eq = EventQueue()
    _ocr_jobs[job_id] = eq
    _ocr_meta[job_id] = {"novel_slug": novel_slug, "chapter_title": chapter_title}

    img_dir = settings.ocr_images_dir / novel_slug / job_id
    img_dir.mkdir(parents=True, exist_ok=True)

    paths = []
    for i, img in enumerate(images):
        p = img_dir / f"shot_{i + 1:02d}.jpg"
        p.write_bytes(await img.read())
        paths.append(p)

    task = asyncio.create_task(
        run_ocr(job_id, novel_slug, chapter_title, paths, get_state(), eq, get_client(), settings)
    )
    _ocr_tasks[job_id] = task
    return {"job_id": job_id}


@router.get("/jobs")
def list_ocr_jobs(novel_slug: Optional[str] = Query(None)):
    result = []
    for jid, task in _ocr_tasks.items():
        if not task.done():
            meta = _ocr_meta.get(jid, {})
            if novel_slug and meta.get("novel_slug") != novel_slug:
                continue
            result.append({"job_id": jid, **meta})
    return result


@router.get("/stream/{job_id}")
async def stream_ocr(job_id: str):
    eq = _ocr_jobs.get(job_id)
    if eq is None:
        raise HTTPException(404, "Job không tồn tại")
    return StreamingResponse(
        eq.stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/{novel_slug}/{job_id}/images")
def list_job_images(novel_slug: str, job_id: str):
    img_dir = settings.ocr_images_dir / novel_slug / job_id
    if not img_dir.exists():
        return {"images": []}
    files = sorted(img_dir.glob("shot_*.jpg"), key=lambda p: p.name)
    return {"images": [f.name for f in files]}


@router.get("/{novel_slug}/{job_id}/images/{filename}")
def get_job_image(novel_slug: str, job_id: str, filename: str):
    img_path = settings.ocr_images_dir / novel_slug / job_id / filename
    if not img_path.exists():
        raise HTTPException(404, "Ảnh không tồn tại")
    return FileResponse(str(img_path), media_type="image/jpeg")
