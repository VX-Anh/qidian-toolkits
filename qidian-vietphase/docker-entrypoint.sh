#!/bin/sh
set -e

if [ "$(id -u)" = "0" ]; then
    # Bind mount từ host thường thuộc UID khác user `app` (10001) trong image.
    # Sửa quyền trước khi drop privilege để SQLite ghi được state.db và extractor /
    # trang Settings ghi được novel.md (khi RULES_DIR là thư mục mount ngoài /app).
    chown -R app:app /data 2>/dev/null || true
    case "${RULES_DIR:-}" in
        /app/*|"") ;;
        /*) [ -d "$RULES_DIR" ] && chown -R app:app "$RULES_DIR" 2>/dev/null || true ;;
    esac

    # File API key trên host để quyền 600 của chủ file (khác UID app) → chép một bản
    # riêng cho app đọc, không phải nới quyền file gốc trên host.
    if [ -n "${ANTHROPIC_API_KEY_FILE:-}" ] && [ -f "$ANTHROPIC_API_KEY_FILE" ]; then
        mkdir -p /run/vietphase
        install -o app -g app -m 600 "$ANTHROPIC_API_KEY_FILE" /run/vietphase/anthropic_api_key
        export ANTHROPIC_API_KEY_FILE=/run/vietphase/anthropic_api_key
    fi

    exec runuser -u app -- "$@"
fi

exec "$@"
