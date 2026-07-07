"""
OCR toàn bộ ảnh trong một thư mục chapter, gộp text lại và lưu ra file .txt.

Dùng PaddleOCR 3.x với model PP-OCRv6 (PPLCNetV4). Model tự tải về cache của
paddlex ở lần chạy đầu (không cần tự tải .tar như bản v4 cũ).

Usage:
    uv run run_ocr.py <folder>
    uv run run_ocr.py <folder> --server          # tier medium (chính xác nhất)
    uv run run_ocr.py <folder> --output result.txt
"""
import sys
import io
import os
import argparse
from difflib import SequenceMatcher
from pathlib import Path

os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

# line_buffering=True: flush theo từng dòng để backend đọc progress real-time
# (run_paddle_ocr đọc stdout từng dòng đếm số trang) và log không bị nghẽn buffer.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def model_names(server: bool) -> tuple[str, str]:
    """Chọn tier PP-OCRv6. --server = medium (chính xác nhất, hợp CPU server),
    mặc định = small (cân bằng tốc độ/độ chính xác)."""
    tier = "medium" if server else "small"
    return f"PP-OCRv6_{tier}_det", f"PP-OCRv6_{tier}_rec"


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
    if scale and scale != 1.0:
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        img = img.filter(ImageFilter.SHARPEN)
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    img.save(tmp.name, "PNG")
    return tmp.name


def extract_lines(res) -> list[str]:
    """Lấy danh sách dòng text từ một OCRResult (PaddleOCR 3.x).

    OCRResult là dict-like: res['rec_texts'] là list chuỗi theo thứ tự đọc.
    Fallback qua res.json['res'] nếu truy cập trực tiếp lỗi."""
    texts = None
    try:
        texts = res["rec_texts"]
    except Exception:
        j = getattr(res, "json", None)
        if isinstance(j, dict):
            texts = (j.get("res") or j).get("rec_texts")
    if not texts:
        return []
    return [t.strip() for t in texts if t and t.strip()]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("folder", help="Thư mục chứa ảnh chapter")
    parser.add_argument("--output", "-o", help="Đường dẫn file txt output (mặc định: <folder>/output.txt)")
    parser.add_argument("--lang", default="ch", help="Ngôn ngữ OCR (PP-OCRv6 rec là model đa ngữ 50 thứ tiếng; tham số này chỉ để tương thích CLI cũ)")
    parser.add_argument("--scale", type=float, default=1.0, help="Upscale ảnh trước OCR (default: 1.0 = tắt; PP-OCRv6 đủ mạnh, upscale chủ yếu làm chậm trên CPU)")
    parser.add_argument("--server", action="store_true", help="Dùng tier medium PP-OCRv6 (chính xác nhất)")
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

    det_name, rec_name = model_names(args.server)
    print(f"[PP-OCRv6] det={det_name} rec={rec_name} (lần đầu sẽ tự tải model)")

    # Văn bản tiểu thuyết là chữ ngang một cột → tắt các module phụ (orientation /
    # unwarping / textline orientation) cho nhanh và tránh xoay nhầm.
    # enable_mkldnn=False: paddlepaddle 3.3 CPU với oneDNN dính bug PIR executor
    # (ConvertPirAttribute2RuntimeAttribute not support ...ArrayAttribute<DoubleAttribute>)
    # trên model PP-OCRv6 → tắt MKLDNN để chạy nhánh CPU thường.
    ocr = PaddleOCR(
        text_detection_model_name=det_name,
        text_recognition_model_name=rec_name,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device="cpu",
        enable_mkldnn=False,
    )

    all_lines: list[str] = []
    tmp_files = []
    for img_path in images:
        print(f"OCR: {img_path.name}")
        tmp = preprocess(img_path, scale=args.scale)
        tmp_files.append(tmp)

        img_lines: list[str] = []
        for res in ocr.predict(tmp):
            img_lines.extend(extract_lines(res))

        if all_lines and img_lines:
            skip = find_head_overlap(all_lines, img_lines)
            if skip:
                print(f"  -> bỏ {skip} dòng overlap")
            img_lines = img_lines[skip:]

        all_lines.extend(img_lines)

    for f in tmp_files:
        try:
            os.unlink(f)
        except OSError:
            pass

    text = "\n".join(all_lines)
    output_path.write_text(text, encoding="utf-8")
    print(f"\nDone! Saved {len(all_lines)} dòng -> {output_path}")


if __name__ == "__main__":
    main()
