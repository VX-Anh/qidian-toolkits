import sys
import io
import os
from pathlib import Path

os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

from PIL import Image
from paddleocr import PaddleOCR

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


def build_ocr(lang: str = "ch") -> PaddleOCR:
    return PaddleOCR(
        use_angle_cls=True,
        lang=lang,
        ocr_version="PP-OCRv4",
        use_server=False,   # Mobile model (not server/large)
        use_gpu=False,
        show_log=False,
    )


def ocr_image(image_path: str, lang: str = "ch") -> str:
    """OCR an image, return extracted text as newline-separated string."""
    ocr = build_ocr(lang)
    result = ocr.ocr(image_path, cls=True)

    lines = []
    if result and result[0]:
        for line in result[0]:
            lines.append(line[1][0])
    return "\n".join(lines)


def ocr_image_with_details(image_path: str, lang: str = "ch") -> list[dict]:
    """OCR an image, return list of {text, confidence, bbox} dicts."""
    ocr = build_ocr(lang)
    result = ocr.ocr(image_path, cls=True)

    details = []
    if result and result[0]:
        for line in result[0]:
            bbox, (text, confidence) = line
            details.append({
                "text": text,
                "confidence": round(float(confidence), 4),
                "bbox": bbox,
            })
    return details


def stitch_images(image_paths: list[str], gap: int = 0, bg_color: tuple = (255, 255, 255)) -> Image.Image:
    """
    Stack images vertically into one tall image.
    All images are scaled to the same width (widest image wins).
    """
    imgs = [Image.open(p).convert("RGB") for p in image_paths]
    target_w = max(img.width for img in imgs)

    resized = []
    for img in imgs:
        if img.width != target_w:
            scale = target_w / img.width
            new_h = int(img.height * scale)
            img = img.resize((target_w, new_h), Image.LANCZOS)
        resized.append(img)

    total_h = sum(img.height for img in resized) + gap * (len(resized) - 1)
    canvas = Image.new("RGB", (target_w, total_h), bg_color)

    y = 0
    for img in resized:
        canvas.paste(img, (0, y))
        y += img.height + gap

    return canvas


if __name__ == "__main__":
    image_path = sys.argv[1] if len(sys.argv) > 1 else r"dataset\第677章 真叶（求月票！）_01 (1).jpg"

    if not Path(image_path).exists():
        print(f"Error: file not found: {image_path}")
        sys.exit(1)

    print(f"OCR file: {image_path}\n")
    print("=" * 60)

    text = ocr_image(image_path)
    print(text)

    print("\n" + "=" * 60)
    print("Chi tiết (confidence | text):")
    for item in ocr_image_with_details(image_path):
        print(f"  [{item['confidence']:.3f}] {item['text']}")
