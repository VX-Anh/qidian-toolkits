import asyncio
import uuid
from typing import List, Optional

from fastapi import Depends, APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

_RUN_IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}

from ..agent.ocr_processor import run_ocr, run_paddle_ocr
from ..agent.state import EventQueue
from ..agent import vietphase_import
from ..config import settings
from ..safety import check_name, check_request_params, check_slug, safe_child
from ..jobs import JobRegistry
from ..shared import get_client, get_state

router = APIRouter(prefix="/api/ocr", tags=["ocr"], dependencies=[Depends(check_request_params)])

ocr_jobs = JobRegistry()


@router.post("/upload")
async def upload_ocr(
    novel_slug: str = Form(...),
    chapter_title: str = Form(""),
    engine: str = Form(""),
    images: List[UploadFile] = File(...),
):
    check_slug(novel_slug)
    engine = (engine or settings.ocr_default_engine).lower()
    job_id = str(uuid.uuid4())
    eq = EventQueue()

    img_dir = safe_child(settings.ocr_images_dir, novel_slug, job_id)
    img_dir.mkdir(parents=True, exist_ok=True)

    paths = []
    for i, img in enumerate(images):
        p = img_dir / f"shot_{i + 1:02d}.jpg"
        p.write_bytes(await img.read())
        paths.append(p)

    processor = run_paddle_ocr if engine == "paddle" else run_ocr
    # Chỉ engine gemini cần client Vertex — paddle không được chết vì thiếu credential.
    client = get_client() if engine != "paddle" else None
    task = asyncio.create_task(
        processor(job_id, novel_slug, chapter_title, paths, get_state(), eq, client, settings)
    )
    ocr_jobs.add(job_id, eq, task, novel_slug=novel_slug, chapter_title=chapter_title, engine=engine)
    return {"job_id": job_id, "engine": engine}


class OcrRunBody(BaseModel):
    novel_slug: str
    filename: str
    engine: str = ""


@router.post("/run")
async def run_ocr_existing(body: OcrRunBody):
    """Chạy OCR trên ảnh CÓ SẴN của một chương (chương import từ folder, chưa có text)."""
    check_slug(body.novel_slug)
    check_name(body.filename)
    state = get_state()
    chapter = state.get_chapter(body.filename)
    if not chapter:
        raise HTTPException(404, "Chương không tồn tại")
    job = chapter.get("ocr_job_id")
    if not job:
        raise HTTPException(400, "Chương không có nguồn ảnh để OCR")

    img_dir = vietphase_import.resolve_image_dir(settings, body.novel_slug, job)
    if img_dir is None:
        raise HTTPException(404, "Không tìm thấy thư mục ảnh")
    paths = sorted(
        [p for p in img_dir.iterdir() if p.is_file() and p.suffix.lower() in _RUN_IMG_EXTS],
        key=lambda p: p.name,
    )
    if not paths:
        raise HTTPException(400, "Thư mục không có ảnh nào")

    engine = (body.engine or settings.ocr_default_engine).lower()
    if ocr_jobs.running(job=job):
        raise HTTPException(409, "Chương này đang chạy OCR")
    eq = EventQueue()

    processor = run_paddle_ocr if engine == "paddle" else run_ocr
    client = get_client() if engine != "paddle" else None
    task = asyncio.create_task(
        processor(job, body.novel_slug, body.filename, paths, state, eq, client, settings,
                  out_filename=body.filename)
    )
    ocr_jobs.add(job, eq, task, job=job, novel_slug=body.novel_slug,
                 chapter_title=chapter.get("zh_title", ""), engine=engine)
    return {"job_id": job, "engine": engine}


@router.get("/jobs")
def list_ocr_jobs(novel_slug: Optional[str] = Query(None)):
    match = {"novel_slug": novel_slug} if novel_slug else {}
    return [{"job_id": jid, **{k: v for k, v in ocr_jobs.meta[jid].items() if k != "job"}}
            for jid in ocr_jobs.running(**match)]


@router.get("/stream/{job_id}")
async def stream_ocr(job_id: str):
    eq = ocr_jobs.queues.get(job_id)
    if eq is None:
        raise HTTPException(404, "Job không tồn tại")
    return StreamingResponse(
        eq.stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


_IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
_MEDIA = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}


@router.get("/{novel_slug}/{job_id}/images")
def list_job_images(novel_slug: str, job_id: str):
    # Ưu tiên ocr_images_dir, fallback vietphase_dir (chương import sẵn)
    img_dir = vietphase_import.resolve_image_dir(settings, novel_slug, job_id)
    if img_dir is None:
        return {"images": []}
    files = sorted(
        [p for p in img_dir.iterdir() if p.is_file() and p.suffix.lower() in _IMG_EXTS],
        key=lambda p: p.name,
    )
    return {"images": [f.name for f in files]}


@router.get("/{novel_slug}/{job_id}/images/{filename}")
def get_job_image(novel_slug: str, job_id: str, filename: str):
    img_dir = vietphase_import.resolve_image_dir(settings, novel_slug, job_id)
    img_path = safe_child(img_dir, filename) if img_dir else None
    if not img_path or not img_path.exists():
        raise HTTPException(404, "Ảnh không tồn tại")
    return FileResponse(str(img_path), media_type=_MEDIA.get(img_path.suffix.lower(), "image/jpeg"))
