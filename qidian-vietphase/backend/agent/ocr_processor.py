import asyncio
import re
from pathlib import Path

from google import genai
from google.genai import types

from .orchestrator import parse_chapter_filename
from .state import EventQueue, SharedState

OCR_PROMPT = (
    "These are sequential screenshots of a Chinese web novel chapter. "
    "Extract ALL Chinese text in reading order. "
    "Preserve paragraph breaks with a blank line between paragraphs. "
    "Output ONLY the novel text — no commentary, no translation, no UI labels."
)


def _parse_filename(tab_title: str, ocr_text: str) -> str:
    """Derive a proper chapter filename from the browser tab title or OCR first line.

    tab.title on qidian.com is typically:
      "第675章 天演 - 苟在武道世界成圣_起点中文网"
    We extract only the "第N章 title" prefix.
    """
    m = re.match(r'^(第\d+章[^-—_\n]*)', tab_title.strip())
    if m:
        title = m.group(1).strip()
    else:
        first_line = ocr_text.split('\n')[0].strip() if ocr_text else tab_title
        title = first_line if re.match(r'^第\d+章', first_line) else tab_title
    return re.sub(r'[\\/:*?"<>|]', '', title).strip() + '.txt'


async def run_ocr(
    job_id: str,
    novel_slug: str,
    chapter_title_hint: str,
    image_paths: list[Path],
    state: SharedState,
    event_queue: EventQueue,
    client: genai.Client,
    settings,
    out_filename: str | None = None,
):
    try:
        await event_queue.put({"type": "ocr_progress", "step": "ocr",
                               "msg": f"Đang OCR với Gemini ({settings.llm_vision_model})..."})

        parts = [types.Part(text=OCR_PROMPT)] + [
            types.Part.from_bytes(data=p.read_bytes(), mime_type="image/jpeg")
            for p in image_paths
        ]

        text_chunks: list[str] = []
        stream = await client.aio.models.generate_content_stream(
            model=settings.llm_vision_model,
            contents=[types.Content(role="user", parts=parts)],
            config=types.GenerateContentConfig(max_output_tokens=16000),
        )
        async for chunk in stream:
            delta = chunk.text
            if delta:
                text_chunks.append(delta)
                await event_queue.put({"type": "ocr_token", "text": delta})

        full_text = "".join(text_chunks).strip()

        filename = out_filename or _parse_filename(chapter_title_hint, full_text)

        settings.input_dir.mkdir(parents=True, exist_ok=True)
        dest = settings.input_dir / filename
        dest.write_text(full_text, encoding="utf-8")

        num, zh_title = parse_chapter_filename(filename)
        await state.upsert_chapter(filename, novel_slug, num, zh_title, ocr_job_id=job_id)

        await event_queue.put({
            "type": "ocr_done",
            "filename": filename,
            "char_count": len(full_text),
            "preview": full_text[:400],
        })

    except Exception as exc:
        await event_queue.put({"type": "ocr_error", "msg": str(exc)})
    finally:
        await event_queue.close()


async def run_paddle_ocr(
    job_id: str,
    novel_slug: str,
    chapter_title_hint: str,
    image_paths: list[Path],
    state: SharedState,
    event_queue: EventQueue,
    client: genai.Client,  # không dùng — giữ cùng chữ ký với run_ocr
    settings,
    out_filename: str | None = None,
):
    """OCR offline bằng PaddleOCR (chạy qidian-ocr/run_ocr.py trong venv riêng).

    Không stream từng ký tự như LLM; phát ocr_progress theo từng dòng stdout
    của subprocess (mỗi ảnh, số dòng overlap bị bỏ), rồi ocr_done khi xong.
    """
    try:
        if not image_paths:
            await event_queue.put({"type": "ocr_error", "msg": "Không có ảnh"})
            return

        img_dir = image_paths[0].parent
        output_path = img_dir / "output.txt"

        py = str(settings.paddle_python)
        script = str(settings.paddle_ocr_script)
        if not Path(py).exists():
            await event_queue.put({"type": "ocr_error", "msg": f"Không tìm thấy Python PaddleOCR: {py}"})
            return
        if not Path(script).exists():
            await event_queue.put({"type": "ocr_error", "msg": f"Không tìm thấy run_ocr.py: {script}"})
            return

        cmd = [py, script, str(img_dir), "--output", str(output_path)]
        if settings.paddle_use_server:
            cmd.append("--server")

        total = len(image_paths)
        await event_queue.put({
            "type": "ocr_progress", "step": "paddle", "page": 0, "total": total,
            "msg": f"Khởi tạo PaddleOCR ({'server' if settings.paddle_use_server else 'mobile'} model)…",
        })

        # NOTE: dùng subprocess.Popen trong thread thay vì asyncio.create_subprocess_exec —
        # trên Windows event loop của uvicorn (Selector) không hỗ trợ subprocess async
        # (NotImplementedError). Đẩy event về loop chính qua run_coroutine_threadsafe.
        import subprocess
        loop = asyncio.get_running_loop()

        def _run_and_stream() -> int:
            proc = subprocess.Popen(
                cmd, cwd=str(settings.paddle_ocr_cwd),
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace", bufsize=1,
            )
            page = 0
            for line in proc.stdout:
                line = line.rstrip()
                if not line:
                    continue
                if line.startswith("OCR: "):
                    page += 1
                evt = {"type": "ocr_progress", "step": "paddle", "page": page, "total": total, "msg": line}
                asyncio.run_coroutine_threadsafe(event_queue.put(evt), loop)
            proc.stdout.close()
            return proc.wait()

        returncode = await asyncio.to_thread(_run_and_stream)
        if returncode != 0:
            await event_queue.put({"type": "ocr_error", "msg": f"PaddleOCR thất bại (exit {returncode})"})
            return

        if not output_path.exists():
            await event_queue.put({"type": "ocr_error", "msg": "PaddleOCR không tạo output.txt"})
            return

        full_text = output_path.read_text(encoding="utf-8").strip()
        filename = out_filename or _parse_filename(chapter_title_hint, full_text)

        settings.input_dir.mkdir(parents=True, exist_ok=True)
        (settings.input_dir / filename).write_text(full_text, encoding="utf-8")

        num, zh_title = parse_chapter_filename(filename)
        await state.upsert_chapter(filename, novel_slug, num, zh_title, ocr_job_id=job_id)

        await event_queue.put({
            "type": "ocr_done",
            "filename": filename,
            "char_count": len(full_text),
            "preview": full_text[:400],
        })

    except Exception as exc:
        await event_queue.put({"type": "ocr_error", "msg": f"{type(exc).__name__}: {exc}"})
    finally:
        await event_queue.close()
