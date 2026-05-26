import base64
import re
from pathlib import Path

from openai import AsyncOpenAI

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
    client: AsyncOpenAI,
    settings,
):
    try:
        await event_queue.put({"type": "ocr_progress", "step": "ocr", "msg": "Đang OCR với OpenAI..."})

        images_b64 = [base64.b64encode(p.read_bytes()).decode() for p in image_paths]
        content = [
            {"type": "text", "text": OCR_PROMPT},
            *[
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b}", "detail": "high"}}
                for b in images_b64
            ],
        ]

        text_chunks: list[str] = []
        stream = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": content}],
            max_tokens=16000,
            stream=True,
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta.content if chunk.choices else None
            if delta:
                text_chunks.append(delta)
                await event_queue.put({"type": "ocr_token", "text": delta})

        full_text = "".join(text_chunks).strip()

        filename = _parse_filename(chapter_title_hint, full_text)

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
