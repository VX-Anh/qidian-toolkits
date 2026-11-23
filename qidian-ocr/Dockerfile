# ── Sidecar OCR (PaddleOCR PP-OCRv6, GPU) ─────────────────────────────────────
# Image GPU cho server có NVIDIA (RTX 4090 = Ada, CC 8.9). Host cần cài
# nvidia-container-toolkit và cấp GPU cho container (xem docker-compose.yml).
#
# CHỐT CUDA TAG: base image + wheel index phải khớp driver host (nvidia-smi /
# nvidia-container-cli kiểm tra CUDA tối thiểu của image).
# Host hiện tại: driver 550.x → tối đa CUDA 12.4 → không chạy được cu126
# (đòi driver ≥560). Paddle 3.3 chỉ có wheel cu118 / cu126 / cu129 → dùng cu118.
# Đổi CẢ tag base image LẪN URL index nếu nâng driver lên ≥560 rồi chuyển cu126.
FROM nvidia/cuda:11.8.0-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True \
    PADDLE_TIER=medium \
    PADDLE_DEVICE=gpu \
    HOME=/root

# python3 của Ubuntu 22.04 là 3.10 (python3-pip đi kèm bản này) — trước đây cài
# thêm python3.11 nhưng không dùng tới. curl cho HEALTHCHECK.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip curl \
        libgomp1 libglib2.0-0 libgl1 libsm6 libxext6 libxrender1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# paddlepaddle-gpu KHÔNG có trên PyPI thường — cài từ index CUDA riêng của Paddle
# (khớp cu118). Sau đó cài paddleocr + web deps từ PyPI. Không dùng uv.lock của
# qidian-ocr vì lock đó pin paddlepaddle bản CPU.
RUN python3 -m pip install --no-cache-dir --upgrade pip \
 && python3 -m pip install --no-cache-dir \
        paddlepaddle-gpu==3.3.1 -i https://www.paddlepaddle.org.cn/packages/stable/cu118/ \
 && python3 -m pip install --no-cache-dir \
        "paddleocr==3.7.0" "fastapi==0.136.1" "uvicorn[standard]==0.47.0" "anyio==4.13.0"

# Chỉ cần 2 file mã nguồn; run_ocr.py cung cấp các hàm thuần cho server.py import.
COPY run_ocr.py server.py ./

# Cache model PP-OCRv6 (HOME=/root). Mount volume ở đây để không tải lại mỗi rebuild.
VOLUME ["/root/.paddlex"]

EXPOSE 8000
# Sẵn sàng = model đã nạp xong (lần đầu tải PP-OCRv6 có thể mất vài phút).
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --retries=3 \
    CMD curl -fs http://localhost:8000/health | grep -q '"ready":true' || exit 1
CMD ["python3", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
