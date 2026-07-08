#!/bin/sh
set -e

# Bind mount ./data từ host thường thuộc UID khác user `app` (10001) trong image.
# Sửa quyền trước khi drop privilege để SQLite ghi được state.db.
if [ "$(id -u)" = "0" ]; then
    chown -R app:app /data 2>/dev/null || true
    exec runuser -u app -- "$@"
fi

exec "$@"
