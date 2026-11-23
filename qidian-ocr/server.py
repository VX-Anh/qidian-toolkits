"""HTTP wrapper cho PaddleOCR — chạy như sidecar service cho qidian-vietphase.

Dựng PaddleOCR MỘT LẦN lúc startup (lifespan) rồi phục vụ qua POST /ocr, thay cho
việc backend spawn subprocess mỗi chương (vốn dựng lại model mỗi lần). Tái dùng các
hàm thuần trong run_ocr.py (import, không copy) để logic OCR/dedup không bị lệch.

Ảnh nằm trên volume /data dùng CHUNG với container vietphase → request chỉ truyền
đường dẫn thư mục ảnh, không truyền bytes ảnh qua HTTP.

Env:
  PADDLE_TIER   = medium (mặc định) | small     → chọn tier PP-OCRv6
  PADDLE_DEVICE = gpu (mặc định)    | cpu        → device suy luận
  OCR_DATA_ROOT = /data (mặc định)               → img_dir/output_path phải nằm trong đây
"""
import os
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

# Phải set TRƯỚC khi import paddle (run_ocr.py cũng set, giữ ở đây cho chắc chắn khi
# server.py được nạp độc lập).
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

import anyio
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# run_ocr.py có guard __main__ nên import an toàn (chỉ set env + wrap stdout).
from run_ocr import IMAGE_EXTS, model_names, preprocess, extract_lines, find_head_overlap

# tier medium = chính xác nhất; small nhẹ hơn. Backend luôn muốn bản tốt nhất.
_TIER_SERVER = os.environ.get("PADDLE_TIER", "medium").lower() != "small"
_DEVICE = os.environ.get("PADDLE_DEVICE", "gpu").lower()  # "gpu" | "cpu"
# Chỉ đọc ảnh / ghi output trong thư mục dữ liệu dùng chung, không cho đường dẫn tuỳ ý.
_DATA_ROOT = Path(os.environ.get("OCR_DATA_ROOT", "/data")).resolve()


def _inside_data(raw: str, field: str) -> Path:
    p = Path(raw).resolve()
    if p != _DATA_ROOT and not p.is_relative_to(_DATA_ROOT):
        raise HTTPException(400, f"{field} phải nằm trong {_DATA_ROOT}")
    return p

_ocr = None
# Một instance PaddleOCR KHÔNG reentrant (chia sẻ buffer nội bộ) → serialize predict.
_lock = asyncio.Lock()


def _build_ocr():
    from paddleocr import PaddleOCR

    det_name, rec_name = model_names(_TIER_SERVER)
    kwargs = dict(
        text_detection_model_name=det_name,
        text_recognition_model_name=rec_name,
        # Văn tiểu thuyết là chữ ngang một cột → tắt các module phụ cho nhanh/chuẩn.
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device=_DEVICE,
    )
    # enable_mkldnn=False chỉ để né bug oneDNN của paddle CPU trên PP-OCRv6; nhánh GPU
    # không cần (và không nên đặt) tham số này.
    if _DEVICE == "cpu":
        kwargs["enable_mkldnn"] = False
    return PaddleOCR(**kwargs)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _ocr
    # Lần đầu sẽ tự tải model PP-OCRv6 về cache paddlex (~/.paddlex) → cần mạng + có
    # thể mất vài chục giây. Volume paddlex-models giữ lại cho các lần sau.
    _ocr = await anyio.to_thread.run_sync(_build_ocr)
    yield


app = FastAPI(title="qidian-ocr", lifespan=lifespan)


class OcrReq(BaseModel):
    img_dir: str                       # thư mục ảnh (đường dẫn trên volume /data chung)
    output_path: str | None = None     # nếu có, ghi text ra đây (backend đọc lại)
    scale: float = 1.0                 # upscale trước OCR; 1.0 = tắt (PP-OCRv6 đủ mạnh)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "tier": "medium" if _TIER_SERVER else "small",
        "device": _DEVICE,
        "ready": _ocr is not None,
    }


def _run_dir(img_dir: Path, scale: float) -> list[str]:
    """OCR toàn bộ ảnh trong thư mục, gộp dòng + khử overlap. Chạy trong worker thread.

    Log per-ảnh ra stdout (xem qua `docker logs qidian-ocr`): số dòng nhận diện, số
    dòng overlap bị bỏ, và tổng dòng tích lũy.
    """
    images = sorted(p for p in img_dir.iterdir() if p.suffix.lower() in IMAGE_EXTS)
    total = len(images)
    print(f"[ocr] {img_dir}: {total} ảnh (scale={scale})", flush=True)
    all_lines: list[str] = []
    tmps: list[str] = []
    try:
        for idx, p in enumerate(images, 1):
            print(f"[ocr] [{idx}/{total}] {p.name}", flush=True)
            tmp = preprocess(p, scale=scale)
            tmps.append(tmp)
            img_lines: list[str] = []
            for res in _ocr.predict(tmp):
                img_lines.extend(extract_lines(res))
            print(f"[ocr]   -> nhận diện {len(img_lines)} dòng", flush=True)
            # ảnh chụp có vùng chồng lấn → bỏ các dòng đầu trùng với đuôi ảnh trước.
            if all_lines and img_lines:
                skip = find_head_overlap(all_lines, img_lines)
                if skip:
                    print(f"[ocr]   -> bỏ {skip} dòng trùng đầu (overlap)", flush=True)
                img_lines = img_lines[skip:]
            all_lines.extend(img_lines)
            print(f"[ocr]   -> +{len(img_lines)} dòng (tổng {len(all_lines)})", flush=True)
    finally:
        for t in tmps:
            try:
                os.unlink(t)
            except OSError:
                pass
    print(f"[ocr] hoàn tất: {len(all_lines)} dòng", flush=True)
    return all_lines


@app.post("/ocr")
async def ocr(req: OcrReq):
    d = _inside_data(req.img_dir, "img_dir")
    out = _inside_data(req.output_path, "output_path") if req.output_path else None
    if not d.is_dir():
        raise HTTPException(400, f"img_dir không tồn tại: {req.img_dir}")

    # predict là blocking/CPU-GPU-bound → chạy trong thread; lock để không chồng request.
    async with _lock:
        lines = await anyio.to_thread.run_sync(_run_dir, d, req.scale)

    text = "\n".join(lines)
    if out:
        out.write_text(text, encoding="utf-8")
    pages = len([p for p in d.iterdir() if p.suffix.lower() in IMAGE_EXTS])
    return {"text": text, "char_count": len(text), "lines": len(lines), "pages": pages}
