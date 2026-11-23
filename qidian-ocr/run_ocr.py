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


# Khối overlap phải đủ dài mới được coi là trùng: hai câu thoại ngắn khác nhau
# (vd "“是。”\n“好。”" vs "“嗯。”\n“好。”") vẫn có ratio ~0.89 → trước đây bị xoá nhầm.
MIN_OVERLAP_CHARS = 12
# Overlap chỉ 1 dòng: yêu cầu dòng đủ dài + gần như trùng khít.
MIN_SINGLE_LINE_CHARS = 8
SINGLE_LINE_THRESHOLD = 0.92


def _ratio(a: str, b: str) -> float:
    # autojunk=False: với chuỗi > 200 ký tự, heuristic "junk" mặc định coi các ký tự
    # hay gặp (dấu câu CJK) là rác và làm ratio sai lệch.
    return SequenceMatcher(None, a, b, autojunk=False).ratio()


def _is_truncated_fragment(line: str, tail: list[str]) -> bool:
    """Dòng đầu ảnh bị cắt ngang (chỉ còn nửa trên/dưới glyph) thường là rác rất
    ngắn hoặc giống một phần dòng nào đó ở đuôi ảnh trước. Dòng thật thì không."""
    s = line.strip()
    if len(s) <= 3:
        return True
    return any(_ratio(s, t) >= 0.5 or s in t for t in tail)


def find_head_overlap(prev_lines: list[str], curr_lines: list[str],
                      max_window: int = 15, threshold: float = 0.85,
                      max_skip: int = 3) -> int:
    """
    Trả về số dòng đầu curr_lines cần bỏ (overlap + partial truncated lines).
    max_skip: cho phép bỏ qua tối đa N dòng đầu bị truncated trước khi so sánh —
    nhưng chỉ khi các dòng đó trông như mảnh bị cắt (xem _is_truncated_fragment),
    để không xoá dòng thật đứng trước khối overlap.
    """
    max_check = min(len(prev_lines), len(curr_lines), max_window)
    tail_window = prev_lines[-max_window:]
    for skip in range(max_skip + 1):
        if skip and not all(_is_truncated_fragment(l, tail_window) for l in curr_lines[:skip]):
            break
        for size in range(max_check - skip, 0, -1):
            tail = prev_lines[-size:]
            head = curr_lines[skip:skip + size]
            if len(head) < size:
                continue
            a, b = "\n".join(tail), "\n".join(head)
            if size == 1:
                if (min(len(a), len(b)) >= MIN_SINGLE_LINE_CHARS
                        and _ratio(a, b) >= SINGLE_LINE_THRESHOLD):
                    return skip + 1
                continue
            if min(len(a), len(b)) < MIN_OVERLAP_CHARS:
                continue
            if _ratio(a, b) >= threshold:
                return skip + size
    return 0


def preprocess(img_path: Path, scale: float = 2.0) -> str:
    """Upscale + sharpen image, save to temp file, return temp path."""
    import tempfile
    from PIL import Image, ImageFilter
    if not scale or scale == 1.0:
        return str(img_path)   # không cần xử lý → khỏi ghi PNG tạm cho mỗi ảnh
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


def build_ocr(server: bool, device: str = "cpu"):
    """Dựng PaddleOCR 3.x (PP-OCRv6) với cấu hình dùng chung cho CLI và visualize.py.

    Văn bản tiểu thuyết là chữ ngang một cột → tắt các module phụ (orientation /
    unwarping / textline orientation) cho nhanh và tránh xoay nhầm.
    enable_mkldnn=False: paddlepaddle 3.3 CPU với oneDNN dính bug PIR executor
    (ConvertPirAttribute2RuntimeAttribute not support ...ArrayAttribute<DoubleAttribute>)
    trên model PP-OCRv6 → tắt MKLDNN để chạy nhánh CPU thường.
    """
    from paddleocr import PaddleOCR

    det_name, rec_name = model_names(server)
    print(f"[PP-OCRv6] det={det_name} rec={rec_name} (lần đầu sẽ tự tải model)")
    return PaddleOCR(
        text_detection_model_name=det_name,
        text_recognition_model_name=rec_name,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device=device,
        enable_mkldnn=False,
    )


def extract_details(res) -> list[dict]:
    """Như extract_lines nhưng kèm độ tin cậy + polygon (cho visualize.py):
    [{text, confidence, bbox: [[x,y]×4]}]."""
    def get(key):
        try:
            return res[key]
        except Exception:
            j = getattr(res, "json", None)
            return (j.get("res") or j).get(key) if isinstance(j, dict) else None

    texts = get("rec_texts") or []
    scores = get("rec_scores") or [1.0] * len(texts)
    polys = get("rec_polys") or get("dt_polys") or [None] * len(texts)
    out = []
    for t, s, p in zip(texts, scores, polys):
        if not t or not t.strip():
            continue
        bbox = [[float(x), float(y)] for x, y in p] if p is not None else []
        out.append({"text": t.strip(), "confidence": round(float(s), 4), "bbox": bbox})
    return out


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

    ocr = build_ocr(args.server, device="cpu")

    all_lines: list[str] = []
    tmp_files = []
    total = len(images)
    for idx, img_path in enumerate(images, 1):
        # Dòng "OCR: " được backend (run_paddle_ocr) đếm để hiện tiến trình → giữ prefix.
        print(f"OCR: [{idx}/{total}] {img_path.name}")
        tmp = preprocess(img_path, scale=args.scale)
        if tmp != str(img_path):   # scale=1 trả về ảnh gốc — không được xoá
            tmp_files.append(tmp)
        if args.scale and args.scale != 1.0:
            print(f"  -> tiền xử lý: upscale x{args.scale} + sharpen")

        img_lines: list[str] = []
        for res in ocr.predict(tmp):
            img_lines.extend(extract_lines(res))
        print(f"  -> nhận diện {len(img_lines)} dòng")

        if all_lines and img_lines:
            skip = find_head_overlap(all_lines, img_lines)
            if skip:
                print(f"  -> bỏ {skip} dòng trùng đầu (overlap với ảnh trước)")
            img_lines = img_lines[skip:]

        all_lines.extend(img_lines)
        print(f"  -> +{len(img_lines)} dòng (tổng {len(all_lines)})")

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
