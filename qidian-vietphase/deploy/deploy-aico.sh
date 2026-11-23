#!/usr/bin/env bash
# Dựng lại và chạy VietPhase trong WSL (public tại https://read.aico.io.vn qua tunnel aico-pc).
# Chạy từ Windows:
#   wsl -d Ubuntu -u aico -- bash /mnt/d/TVPL/Marshy/qidian-toolkits/qidian-vietphase/deploy/deploy-aico.sh
#
# Lần đầu script tạo sẵn thư mục dữ liệu + .env mẫu rồi dừng để bạn điền
# (API_TOKEN, GOOGLE_CLOUD_PROJECT) và chép khoá service-account vào secrets/gcp-sa.json.
set -euo pipefail
cd "$(dirname "$0")"
HOME_DIR=${VIETPHASE_HOME:-/home/aico/vietphase}
export VIETPHASE_HOME=$HOME_DIR
log=/tmp/vietphase-build.log
: >"$log"

mkdir -p "$HOME_DIR"/{data/input,data/output,data/ocr_images,data/vietphase,data/db,rules,secrets}
chmod 700 "$HOME_DIR/secrets"

# rules/ lần đầu: lấy novel.md hiện có trong repo (sau đó bản trên ổ WSL là bản chính).
if [ -z "$(ls -A "$HOME_DIR/rules")" ]; then
    cp -r ../rules/. "$HOME_DIR/rules/"
    echo "Đã chép rules/ mẫu vào $HOME_DIR/rules"
fi

if [ ! -f "$HOME_DIR/.env" ]; then
    token=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | cut -c1-40)
    cat >"$HOME_DIR/.env" <<EOF
# VietPhase trên read.aico.io.vn — file này KHÔNG nằm trong git.
API_TOKEN=$token
GOOGLE_CLOUD_PROJECT=
GOOGLE_CLOUD_LOCATION=global
GEMINI_MODEL=gemini-3.5-flash
GEMINI_VISION_MODEL=gemini-3.5-flash
THINKING_LEVEL=LOW
CONCURRENCY=3
EOF
    chmod 600 "$HOME_DIR/.env"
    echo "Đã tạo $HOME_DIR/.env (API_TOKEN sinh ngẫu nhiên — xem bằng: cat $HOME_DIR/.env)."
fi

missing=0
grep -q '^GOOGLE_CLOUD_PROJECT=.\+' "$HOME_DIR/.env" || { echo "Thiếu GOOGLE_CLOUD_PROJECT trong $HOME_DIR/.env"; missing=1; }
[ -s "$HOME_DIR/secrets/gcp-sa.json" ] || { echo "Thiếu khoá service-account: $HOME_DIR/secrets/gcp-sa.json"; missing=1; }
[ "$missing" = 0 ] || { echo "Điền đủ rồi chạy lại script."; exit 2; }

# compose đọc API_TOKEN để kiểm tra bắt buộc (biến ${API_TOKEN:?}) → nạp từ .env.
set -a; . "$HOME_DIR/.env"; set +a

if ! docker compose -f compose.aico.yaml up -d --build >>"$log" 2>&1; then
    tail -40 "$log"; exit 1
fi
docker builder prune -f --reserved-space 3gb >/dev/null 2>&1 || docker builder prune -f --keep-storage 3gb >/dev/null || true
docker image prune -f >/dev/null

# Kiểm tra từ trong mạng của cloudflared (đúng đường tunnel sẽ gọi).
sleep 3
if docker run --rm --network ai-company_workers curlimages/curl:8.11.1 -fsS http://vietphase:9999/health; then
    echo; echo "VietPhase chạy. Public: https://read.aico.io.vn (cần route tunnel read.aico.io.vn -> http://vietphase:9999)"
else
    echo "Container chưa trả /health — xem: docker logs vietphase"; exit 1
fi
