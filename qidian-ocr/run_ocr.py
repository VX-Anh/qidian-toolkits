"""
OCR toàn bộ ảnh trong một thư mục chapter, gộp text lại và lưu ra file .txt.

Usage:
    uv run run_ocr.py <folder>
    uv run run_ocr.py <folder> --server          # dùng server model (chính xác hơn)
    uv run run_ocr.py <folder> --output result.txt
"""
import sys
import io
import os
import argparse
import tarfile
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path

os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}

MODELS_DIR = Path(__file__).parent / ".models"

SERVER_MODELS = {
    "det": (
        "ch_PP-OCRv4_det_server_infer",
        "https://paddleocr.bj.bcebos.com/PP-OCRv4/chinese/ch_PP-OCRv4_det_server_infer.tar",
    ),
    "rec": (
        "ch_PP-OCRv4_rec_server_infer",
        "https://paddleocr.bj.bcebos.com/PP-OCRv4/chinese/ch_PP-OCRv4_rec_server_infer.tar",
    ),
}


def _download_with_progress(url: str, dest: Path):
    print(f"  Download: {url}")
    tmp = dest.with_suffix(".tar.tmp")

    def reporthook(count, block_size, total):
        done = count * block_size
        if total > 0:
            pct = min(done * 100 // total, 100)
            mb_done = done / 1024 / 1024
            mb_total = total / 1024 / 1024
            print(f"\r  {pct}% ({mb_done:.1f}/{mb_total:.1f} MB)", end="", flush=True)

    urllib.request.urlretrieve(url, tmp, reporthook)
    print()
    with tarfile.open(tmp) as tf:
        tf.extractall(MODELS_DIR)
    tmp.unlink()


def ensure_server_models() -> tuple[str, str]:
    MODELS_DIR.mkdir(exist_ok=True)
    paths = {}
    for key, (folder_name, url) in SERVER_MODELS.items():
        model_path = MODELS_DIR / folder_name
        if not model_path.exists():
            print(f"[server model] Downloading {key} model (~{100 if key=='rec' else 50}MB)...")
            _download_with_progress(url, MODELS_DIR / f"{folder_name}.tar")
        paths[key] = str(model_path)
    return paths["det"], paths["rec"]


def find_head_overlap(prev_lines: list[str], curr_lines: list[str],
                      max_window: int = 15, threshold: float = 0.85,
                      max_skip: int = 3) -> int:
    """
    Trả về số dòng đầu curr_lines cần bỏ (overlap + partial truncated lines).
    max_skip: cho phép bỏ qua tối đa N dòng đầu bị truncated trước khi so sánh.
    """
    max_check = min(len(prev_lines), len(curr_lines), max_window)
    for skip in range(max_skip + 1):
        for size in range(max_check - skip, 1, -1):
            tail = prev_lines[-size:]
            head = curr_lines[skip:skip + size]
            if len(head) < size:
                continue
            ratio = SequenceMatcher(None, "\n".join(tail), "\n".join(head)).ratio()
            if ratio >= threshold:
                return skip + size
    return 0


def preprocess(img_path: Path, scale: float = 2.0) -> str:
    """Upscale + sharpen image, save to temp file, return temp path."""
    import tempfile
    from PIL import Image, ImageFilter
    img = Image.open(img_path).convert("RGB")
    w, h = img.size
    img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    img = img.filter(ImageFilter.SHARPEN)
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    img.save(tmp.name, "PNG")
    return tmp.name


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("folder", help="Thư mục chứa ảnh chapter")
    parser.add_argument("--output", "-o", help="Đường dẫn file txt output (mặc định: <folder>/output.txt)")
    parser.add_argument("--lang", default="ch", help="Ngôn ngữ OCR (default: ch)")
    parser.add_argument("--scale", type=float, default=2.0, help="Upscale ảnh trước OCR (default: 2.0)")
    parser.add_argument("--server", action="store_true", help="Dùng server model (chính xác hơn, ~150MB download lần đầu)")
    args = parser.parse_args()

    folder = Path(args.folder)
    if not folder.is_dir():
        print(f"Lỗi: không tìm thấy thư mục '{folder}'")
        sys.exit(1)

    images = sorted(p for p in folder.iterdir() if p.suffix.lower() in IMAGE_EXTS)
    if not images:
        print(f"Không có ảnh nào trong '{folder}'")
        sys.exit(1)

    output_path = Path(args.output) if args.output else folder / "output.txt"

    from paddleocr import PaddleOCR

    ocr_kwargs = dict(
        use_angle_cls=True,
        lang=args.lang,
        ocr_version="PP-OCRv4",
        use_gpu=False,
        show_log=False,
    )

    if args.server:
        det_dir, rec_dir = ensure_server_models()
        print(f"[server model] det={det_dir}")
        print(f"[server model] rec={rec_dir}")
        ocr_kwargs["det_model_dir"] = det_dir
        ocr_kwargs["rec_model_dir"] = rec_dir

    ocr = PaddleOCR(**ocr_kwargs)

    all_lines = []
    tmp_files = []
    for img_path in images:
        print(f"OCR: {img_path.name}")
        tmp = preprocess(img_path, scale=args.scale)
        tmp_files.append(tmp)
        result = ocr.ocr(tmp, cls=True)
        img_lines = [line[1][0] for line in result[0]] if result and result[0] else []

        if all_lines and img_lines:
            skip = find_head_overlap(all_lines, img_lines)
            if skip:
                print(f"  -> bỏ {skip} dòng overlap")
            img_lines = img_lines[skip:]

        all_lines.extend(img_lines)

    for f in tmp_files:
        os.unlink(f)

    text = "\n".join(all_lines)
    output_path.write_text(text, encoding="utf-8")
    print(f"\nDone! Saved {len(all_lines)} dòng -> {output_path}")


if __name__ == "__main__":
    main()
