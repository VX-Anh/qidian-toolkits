"""Native Messaging host cho Qidian Chapter Scraper.

Chrome khởi chạy file này làm subprocess khi extension gọi
chrome.runtime.connectNative('com.qidian.screenshot_host'). Giao tiếp qua
stdin/stdout theo giao thức Native Messaging: mỗi message có 4 byte độ dài
(little-endian uint32) đứng trước payload JSON UTF-8.

Actions hỗ trợ:
  {"action": "ping"} -> {"ok": true, "pong": true}
  {"action": "capture", "x": int, "y": int, "width": int, "height": int}
    -> {"ok": true, "dataUrl": "data:image/jpeg;base64,..."}
    (x/y/width/height là tọa độ VẬT LÝ màn hình, đã nhân devicePixelRatio)

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
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return {"ok": True, "dataUrl": f"data:image/jpeg;base64,{b64}"}


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
                    send_message(handle_capture(msg, sct))
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
