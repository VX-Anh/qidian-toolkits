"""Native Messaging host cho Qidian Chapter Scraper.

Chrome khởi chạy file này làm subprocess khi extension gọi
chrome.runtime.connectNative('com.qidian.screenshot_host'). Giao tiếp qua
stdin/stdout theo giao thức Native Messaging: mỗi message có 4 byte độ dài
(little-endian uint32) đứng trước payload JSON UTF-8.

Actions hỗ trợ:
  {"action": "ping"} -> {"ok": true, "pong": true}
  {"action": "capture", "x": int, "y": int, "width": int, "height": int}
    -> một hoặc nhiều message {"ok": true, "part": i, "total": n, "chunk": "..."}
       ghép các chunk theo thứ tự = "data:image/jpeg;base64,..."
    (x/y/width/height là tọa độ VẬT LÝ màn hình, đã nhân devicePixelRatio)

Chrome giới hạn message host → extension tối đa 1 MB (vượt là ngắt port). Ảnh
JPEG chất lượng cao của một chunk trang trên màn DPR 2 / 4K có thể vượt mức đó
sau khi base64, nên dataUrl được chia thành nhiều message nhỏ.

Chạy chụp bằng mss (đọc thẳng compositor màn hình, không đi qua bất kỳ
đường render nội bộ nào của Chrome) để né lỗi glyph sai khi Chromium chụp
vùng "ngoài viewport" qua CDP captureBeyondViewport.
"""
import base64
import io
import json
import struct
import sys
import traceback

import mss
from PIL import Image

JPEG_QUALITY = 95
# Giữ mỗi message dưới giới hạn 1 MB của Chrome (chừa chỗ cho JSON bao ngoài).
MAX_CHUNK_CHARS = 700_000


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) == 0:
        return None  # Chrome đóng stdin -> thoát
    if len(raw_len) < 4:
        raise EOFError("stdin đóng giữa chừng khi đọc độ dài message")
    (msg_len,) = struct.unpack("<I", raw_len)
    payload = sys.stdin.buffer.read(msg_len)
    if len(payload) < msg_len:
        raise EOFError("stdin đóng giữa chừng khi đọc payload")
    return json.loads(payload.decode("utf-8"))


def send_message(obj):
    payload = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def handle_capture(msg, sct):
    x = int(msg["x"])
    y = int(msg["y"])
    width = int(msg["width"])
    height = int(msg["height"])
    if width <= 0 or height <= 0:
        return {"ok": False, "error": f"vùng chụp không hợp lệ: {width}x{height}"}

    region = {"left": x, "top": y, "width": width, "height": height}
    raw = sct.grab(region)
    img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY)
    data_url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    chunks = [data_url[i:i + MAX_CHUNK_CHARS] for i in range(0, len(data_url), MAX_CHUNK_CHARS)]
    return [{"ok": True, "part": i, "total": len(chunks), "chunk": c} for i, c in enumerate(chunks)]


def main():
    with mss.MSS() as sct:
        while True:
            try:
                msg = read_message()
            except EOFError:
                break
            if msg is None:
                break

            action = msg.get("action")
            try:
                if action == "ping":
                    send_message({"ok": True, "pong": True})
                elif action == "capture":
                    for part in handle_capture(msg, sct):
                        send_message(part)
                else:
                    send_message({"ok": False, "error": f"action không rõ: {action!r}"})
            except Exception as exc:  # báo lỗi về extension thay vì crash im lặng
                send_message({
                    "ok": False,
                    "error": f"{exc}",
                    "traceback": traceback.format_exc(),
                })


if __name__ == "__main__":
    main()
