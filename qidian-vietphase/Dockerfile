# ── VietPhase backend (FastAPI + uvicorn, phục vụ luôn frontend tĩnh) ──────────
# Stage 1: biên dịch trước JSX + React production (frontend/build.mjs) để trình
# duyệt không phải chạy Babel. Backend tự dùng frontend/dist/ khi DEV_MODE tắt.
FROM node:22.11.0-alpine AS frontend
WORKDIR /fe
COPY frontend ./
RUN node build.mjs

# Stage 2: image chạy
FROM python:3.11-slim

# uv: trình quản lý môi trường/khoá phụ thuộc (cài đúng theo uv.lock).
# Pin version cụ thể để build tái lập (tránh tag :latest đổi giữa các lần build).
COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /uvx /bin/

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Cài phụ thuộc trước (layer cache) — chỉ rebuild khi lock/pyproject đổi.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

# Mã nguồn ứng dụng
COPY backend ./backend
COPY frontend ./frontend
COPY --from=frontend /fe/dist ./frontend/dist
COPY rules ./rules

# Cài chính project (đăng ký package "backend")
RUN uv sync --frozen --no-dev

# Chạy non-root: tạo user 'app' và trao quyền /app cho nó.
# Entrypoint (root) chown /data bind mount rồi exec runuser → app (xem docker-entrypoint.sh).
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app \
    && apt-get update \
    && apt-get install -y --no-install-recommends util-linux \
    && rm -rf /var/lib/apt/lists/*

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 9999

ENTRYPOINT ["/docker-entrypoint.sh"]
# Một worker duy nhất: SQLite + RLock là per-process, không scale ngang trong
# container này (đúng với mô hình single-user đã chọn).
CMD ["uv", "run", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "9999"]
