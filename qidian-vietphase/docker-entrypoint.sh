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

    # Khoá service-account trên host để quyền 600 của chủ file (khác UID app) → chép
    # một bản riêng cho app đọc, không phải nới quyền file gốc trên host.
    if [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] && [ -f "$GOOGLE_APPLICATION_CREDENTIALS" ]; then
        mkdir -p /run/vietphase
        install -o app -g app -m 600 "$GOOGLE_APPLICATION_CREDENTIALS" /run/vietphase/gcp-sa.json
        export GOOGLE_APPLICATION_CREDENTIALS=/run/vietphase/gcp-sa.json
    fi

    exec runuser -u app -- "$@"
fi

exec "$@"
