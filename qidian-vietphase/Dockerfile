# ── VietPhase backend (FastAPI + uvicorn, phục vụ luôn frontend tĩnh) ──────────
# Stage 1: biên dịch trước JSX + React production (frontend/build.mjs) để trình
# duyệt không phải chạy Babel. Backend tự dùng frontend/dist/ khi DEV_MODE tắt.
FROM node:22.11.0-alpine AS frontend
WORKDIR /fe
COPY frontend ./
RUN node build.mjs

# Stage 2: Claude Code CLI (TRANSLATE_PROVIDER=cli). Cùng nền Debian bookworm với image
# chạy (glibc) nên chép được node + gói npm sang. Pin version để build tái lập.
FROM node:22.11.0-bookworm-slim AS claude-cli
ARG CLAUDE_CODE_VERSION=2.1.330
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && npm cache clean --force \
    && printf '#!/bin/sh\nexec "%s" "$@"\n' "$(readlink -f /usr/local/bin/claude)" > /opt/claude \
    && chmod 755 /opt/claude

# Stage 3: image chạy
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
# runuser (util-linux) đã có sẵn trong python:*-slim → không cần apt-get.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app

# Claude Code CLI: node + gói npm + lệnh `claude`. Đăng nhập lưu ở /home/app (volume).
COPY --from=claude-cli /usr/local/bin/node /usr/local/bin/node
COPY --from=claude-cli /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=claude-cli /opt/claude /usr/local/bin/claude

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 9999

ENTRYPOINT ["/docker-entrypoint.sh"]
# Một worker duy nhất: SQLite + RLock là per-process, không scale ngang trong
# container này (đúng với mô hình single-user đã chọn).
CMD ["uv", "run", "--no-sync", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "9999"]
