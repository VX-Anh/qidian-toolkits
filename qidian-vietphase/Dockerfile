# ── VietPhase backend (FastAPI + uvicorn, phục vụ luôn frontend tĩnh) ──────────
# Frontend không cần build step: React + Babel qua CDN, FastAPI serve /static.
# Nên chỉ cần một image Python chạy uvicorn là đủ.
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
COPY rules ./rules

# Cài chính project (đăng ký package "backend")
RUN uv sync --frozen --no-dev

# Chạy non-root: tạo user 'app' và trao quyền /app cho nó.
# Lưu ý: volume /data mount từ host — host phải cho phép user này ghi
# (xem README; nếu cần, chown thư mục data trên host về UID 10001).
RUN useradd --create-home --uid 10001 app && chown -R app:app /app
USER app

EXPOSE 9999

# Một worker duy nhất: SQLite + RLock là per-process, không scale ngang trong
# container này (đúng với mô hình single-user đã chọn).
CMD ["uv", "run", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "9999"]
