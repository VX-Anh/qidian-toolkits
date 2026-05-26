import sys
import io
import os
from pathlib import Path

os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

FONT_PATH = "C:/Windows/Fonts/simsun.ttc"
BBOX_COLOR = (0, 200, 80)
TEXT_BG_COLOR = (0, 200, 80)
TEXT_COLOR = (255, 255, 255)
LOW_CONF_COLOR = (220, 60, 60)   # red for confidence < threshold
CONF_THRESHOLD = 0.90


def _poly_to_rect(poly: list) -> tuple[int, int, int, int]:
    """Convert 4-point polygon to (x_min, y_min, x_max, y_max)."""
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    return int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))


def visualize_ocr(image_path: str, details: list[dict], output_path: str | None = None, font_size: int = 14) -> Image.Image:
    """
    Draw OCR bounding boxes and recognized text on the image.

    Args:
        image_path: path to source image
        details: output of ocr_image_with_details()
        output_path: if given, save result image here
        font_size: font size for label text

    Returns:
        PIL Image with annotations
    """
    img = Image.open(image_path).convert("RGB")
    draw = ImageDraw.Draw(img, "RGBA")

    try:
        font = ImageFont.truetype(FONT_PATH, font_size)
        small_font = ImageFont.truetype(FONT_PATH, max(10, font_size - 2))
    except OSError:
        font = ImageFont.load_default()
        small_font = font

    for item in details:
        bbox = item["bbox"]
        text = item["text"]
        conf = item["confidence"]

        color = BBOX_COLOR if conf >= CONF_THRESHOLD else LOW_CONF_COLOR

        # Draw filled semi-transparent polygon
        flat = [(int(p[0]), int(p[1])) for p in bbox]
        draw.polygon(flat, outline=color, fill=(*color, 40))
        # Draw solid outline
        for i in range(len(flat)):
            draw.line([flat[i], flat[(i + 1) % len(flat)]], fill=color, width=2)

        # Draw text label above bbox
        x0, y0, x1, _ = _poly_to_rect(bbox)
        label = f"{text}  {conf:.2f}"
        bbox_text = font.getbbox(label)
        tw, th = bbox_text[2] - bbox_text[0], bbox_text[3] - bbox_text[1]

        label_y = max(0, y0 - th - 4)
        draw.rectangle([x0, label_y, x0 + tw + 6, label_y + th + 4], fill=(*color, 200))
        draw.text((x0 + 3, label_y + 2), label, font=font, fill=TEXT_COLOR)

    if output_path:
        img.save(output_path)
        print(f"Saved: {output_path}")

    return img


def visualize_clean(image_path: str, details: list[dict], output_path: str | None = None) -> Image.Image:
    """
    Draw only bounding boxes without text labels — cleaner view for dense text.
    """
    img = Image.open(image_path).convert("RGB")
    draw = ImageDraw.Draw(img, "RGBA")

    for item in details:
        bbox = item["bbox"]
        conf = item["confidence"]
        color = BBOX_COLOR if conf >= CONF_THRESHOLD else LOW_CONF_COLOR
        flat = [(int(p[0]), int(p[1])) for p in bbox]
        draw.polygon(flat, outline=color, fill=(*color, 30))
        for i in range(len(flat)):
            draw.line([flat[i], flat[(i + 1) % len(flat)]], fill=color, width=2)

    if output_path:
        img.save(output_path)
        print(f"Saved: {output_path}")

    return img


def run_pipeline(image_paths: list[str], output_stem: str | None = None, stitch_gap: int = 10) -> None:
    """
    Full pipeline: stitch (if multiple images) → OCR → visualize.
    output_stem: base path for output files (without extension).
    """
    from ocr import ocr_image_with_details, stitch_images
    import tempfile

    if len(image_paths) == 1:
        ocr_source = image_paths[0]
        tmp_path = None
    else:
        print(f"Stitching {len(image_paths)} images...")
        combined = stitch_images(image_paths, gap=stitch_gap)
        import uuid
        tmp_path = os.path.join(tempfile.gettempdir(), f"ocr_stitch_{uuid.uuid4().hex}.jpg")
        combined.save(tmp_path, quality=95)
        ocr_source = tmp_path
        print(f"Combined size: {combined.width}×{combined.height}px")

    if output_stem is None:
        output_stem = str(Path(image_paths[0]).parent / "stitched_ocr")

    out_labeled = output_stem + "_labeled.jpg"
    out_clean   = output_stem + "_boxes.jpg"
    out_stitched = output_stem + "_source.jpg"

    if tmp_path:
        import shutil
        shutil.copy(tmp_path, out_stitched)
        print(f"Saved stitched source: {out_stitched}")

    print(f"Running OCR...")
    details = ocr_image_with_details(ocr_source)
    print(f"Detected {len(details)} text regions")

    visualize_ocr(ocr_source, details, out_labeled)
    visualize_clean(ocr_source, details, out_clean)

    low_conf = [d for d in details if d["confidence"] < CONF_THRESHOLD]
    if low_conf:
        print(f"\nLow confidence ({len(low_conf)}):")
        for d in low_conf:
            print(f"  [{d['confidence']:.3f}] {d['text']}")

    if tmp_path:
        os.unlink(tmp_path)


if __name__ == "__main__":
    # Usage:
    #   Single image:  uv run python visualize.py image.jpg
    #   Stitch multi:  uv run python visualize.py img1.jpg img2.jpg img3.jpg
    args = sys.argv[1:]

    if not args:
        args = [r"dataset\第677章 真叶（求月票！）_01 (1).jpg"]

    for a in args:
        if not Path(a).exists():
            print(f"Error: file not found: {a}")
            sys.exit(1)

    if len(args) == 1:
        src = Path(args[0])
        stem = str(src.parent / (src.stem + "_ocr"))
    else:
        stem = str(Path(args[0]).parent / "stitched_ocr")

    run_pipeline(args, output_stem=stem)
