# VietPhase

Agent dịch tiểu thuyết Trung → Việt, đa agent chạy song song (FastAPI + Gemini trên Vertex AI).
Kèm OCR (PaddleOCR offline hoặc Gemini vision), Story-Wiki và bảng thuật ngữ.

## Yêu cầu

- Python >= 3.11
- [uv](https://docs.astral.sh/uv/)
- Project GCP đã bật Vertex AI (đăng nhập bằng `gcloud auth application-default login`
  hoặc service-account JSON qua `GOOGLE_APPLICATION_CREDENTIALS`)

## Cài đặt

```bash
uv sync
```

## Cấu hình

Copy `.env.example` → `.env` rồi điền (danh sách đầy đủ xem trong `.env.example`):

| Biến                    | Ý nghĩa                                              |
| ----------------------- | ---------------------------------------------------- |
| `GOOGLE_CLOUD_PROJECT`  | GCP project id (Vertex AI)                           |
| `GOOGLE_CLOUD_LOCATION` | Mặc định `global`                                    |
| `GEMINI_MODEL`          | Model dịch (mặc định `gemini-3.5-flash`)             |
| `THINKING_LEVEL`        | `LOW` (mặc định) / `MEDIUM` / `HIGH` / `MINIMAL`     |
| `INPUT_DIR`             | Thư mục chứa file `.txt` chương tiếng Trung          |
| `OUTPUT_DIR`            | Thư mục lưu bản dịch                                 |
| `RULES_DIR`             | Thư mục cấu hình truyện (mặc định `rules`)           |
| `CONCURRENCY`           | Số TranslatorAgent chạy song song (mặc định `3`)     |
| `OCR_DEFAULT_ENGINE`    | `paddle` (offline, miễn phí) hoặc `gemini`           |

File chương đặt tên theo dạng `第675章 天演.txt` (số chương nằm trong tên file).

## Chạy server

```bash
uv run uvicorn backend.main:app --reload --reload-include "*.html" --reload-include "*.css" --reload-include "*.js" --port 9999
```

Mở giao diện: http://127.0.0.1:9999

Khi sửa frontend, đặt `DEV_MODE=true` trong `.env`: trang dùng Babel trong trình duyệt
(sửa `.jsx` là thấy ngay) và tự reload khi server restart. Khi `DEV_MODE` tắt mà đã có
bản build thì server phục vụ bản build sẵn:

```bash
node frontend/build.mjs   # cần Node ≥18; Docker image tự chạy bước này
```

> **Lưu ý (Windows):** dùng `127.0.0.1` thay vì `localhost`. Trên Windows `localhost` thường resolve sang IPv6 (`::1`) trong khi server bind IPv4 nên có thể bị từ chối kết nối.

## Cấu hình mỗi truyện

Mỗi truyện có file `rules/{slug}/novel.md` (xem mẫu `rules/_template.md`):

- Frontmatter YAML: `zh_name`, `vi_name`, `genre`, `style`
- `## Prompt dịch` — system prompt riêng cho truyện
- Các bảng glossary: `## Nhân vật`, `## Địa danh`, `## Cảnh giới tu luyện`, `## Kỹ năng / Pháp thuật`

ExtractorAgent tự bổ sung thuật ngữ mới vào các bảng này sau mỗi batch dịch.

## Kiến trúc

```
Orchestrator → TranslatorAgent × N (song song, giới hạn bằng semaphore)
                     ↓ sau khi xong hết
             ExtractorAgent → cập nhật novel.md
```

Đầu ra: `OUTPUT_DIR/{novel_slug}/Chuong_{num:04d}_{vi_title}.txt`

Chi tiết kiến trúc và các file chính xem [CLAUDE.md](CLAUDE.md).

## Deploy lên read.aico.io.vn (PC, qua Cloudflare Tunnel)

Chạy trong Docker của WSL trên PC, cạnh stack ai-company; ra Internet qua tunnel
`aico-pc` (không mở port nào). Cấu hình: `deploy/compose.aico.yaml`.

1. Chạy lần đầu để tạo thư mục + `.env` (API_TOKEN sinh ngẫu nhiên):
   ```bash
   wsl -d Ubuntu -u aico -- bash /mnt/d/TVPL/Marshy/qidian-toolkits/qidian-vietphase/deploy/deploy-aico.sh
   ```
2. Điền `GOOGLE_CLOUD_PROJECT` trong `/home/aico/vietphase/.env`, chép khoá
   service-account (role *Vertex AI User*) vào `/home/aico/vietphase/secrets/gcp-sa.json`.
   Muốn mang dữ liệu cũ sang thì chép vào `/home/aico/vietphase/data/` (input, output,
   db/state.db...) — đường dẫn bản dịch của máy cũ được tự trỏ lại khi khởi động.
3. Chạy lại script → build + chạy container `vietphase` (mạng `ai-company_workers`).
4. Cloudflare Zero Trust → Tunnels → `aico-pc` → Public hostname:
   `read.aico.io.vn` → `HTTP` `vietphase:9999`.
5. Mở https://read.aico.io.vn → trang `/login` → nhập `API_TOKEN`. Extension đã đặt
   sẵn Server URL `https://read.aico.io.vn`; chỉ cần điền API token.

OCR trên PC mặc định dùng Gemini vision (PC không có GPU). PaddleOCR CPU là tuỳ chọn:
`docker compose -f deploy/compose.aico.yaml --profile ocr up -d`, rồi đặt
`OCR_SERVICE_URL=http://vietphase-ocr:8000` và `OCR_DEFAULT_ENGINE=paddle` trong `.env`.

## Deploy bằng Docker (VPS Linux)

Một container chạy uvicorn phục vụ cả API lẫn frontend tĩnh. Dữ liệu nằm ở
volume `./data` nên tồn tại qua mỗi lần rebuild. SQLite chạy single-worker —
hợp với mô hình một người dùng (xem ghi chú DB cuối mục).

**1. Chuẩn bị `.env`**

```bash
cp .env.example .env
# Sửa: GOOGLE_CLOUD_PROJECT. Các đường dẫn INPUT_DIR/OUTPUT_DIR/... KHÔNG cần
# sửa — docker-compose.yml đã override sang /data/... khi chạy container.
```

**2. Service-account key cho Vertex AI**

Trong container không dùng `gcloud auth ... login` được. Tải service-account JSON
(role tối thiểu: *Vertex AI User*) từ GCP Console rồi đặt vào:

```bash
mkdir -p secrets
cp /đường/dẫn/key.json secrets/gcp-sa.json   # compose mount read-only sẵn
```

**3. OCR offline (PaddleOCR) — sidecar GPU**

`docker-compose.yml` chạy thêm service `ocr` (PaddleOCR PP-OCRv6) để OCR **miễn
phí offline**, mặc định `OCR_DEFAULT_ENGINE=paddle`. Lưu ý khi deploy:

- **Cần cả repo `qidian-toolkits`** trên server, không chỉ `qidian-vietphase/` —
  service `ocr` build từ sibling `../qidian-ocr` (build context).
- **GPU (khuyến nghị):** host phải cài **nvidia-container-toolkit**. Kiểm tra:
  ```bash
  nvidia-smi                                   # đọc "CUDA Version" + tên GPU
  docker run --rm --gpus all nvidia/cuda:11.8.0-base-ubuntu22.04 nvidia-smi
  ```
  Image OCR mặc định build cho **CUDA 11.8** (`cu118`) — khớp driver **550.x**
  (CUDA tối đa ~12.4). Muốn `cu126` cần driver **≥560**, rồi sửa CẢ tag base
  image + URL index trong `qidian-ocr/Dockerfile`.
- Compose v2 yêu cầu `gpus` là list (đã có sẵn trong `docker-compose.yml`).
  Nếu cần dạng `deploy.resources`, xem docs Compose / NVIDIA.
- **Không có GPU?** Bỏ block `gpus:` trong compose và đặt `PADDLE_DEVICE=cpu`
  cho service `ocr`, đổi base image `qidian-ocr/Dockerfile` sang `python:3.11-slim`
  + wheel `paddlepaddle` (CPU). Chậm hơn nhưng vẫn chạy.
- Lần đầu, service `ocr` **tải model PP-OCRv6** về volume `paddlex-models` (cần
  mạng ra ngoài một lần); các lần sau dùng lại cache.

**4. Build & chạy**

```bash
docker compose up -d --build
docker compose logs -f ocr        # theo dõi lần đầu tải model PP-OCRv6
docker compose exec ocr curl -s localhost:8000/health   # {"device":"gpu","ready":true}
```

Server phơi trực tiếp ra ngoài tại `http://IP-VPS:9166` (map sang cổng 9999
trong container). Nhớ mở cổng 9166 trên firewall của VPS (xem cảnh báo bảo mật
bên dưới).

**5. Backup**

Dữ liệu thật nằm ở `./data` (gồm `db/state.db`, `input`, `output`, `vietphase`).
Backup nhất quán SQLite kể cả khi đang chạy:

```bash
docker compose exec vietphase \
  sqlite3 /data/db/state.db ".backup '/data/db/backup-$(date +%F).db'"
# rồi copy cả thư mục ./data ra nơi an toàn
```

> **DB:** dự án dùng **SQLite** (`/data/state.db`). Với một người dùng + một
> container đây là lựa chọn đúng — đừng đổi sang Postgres trừ khi cần nhiều
> worker hoặc nhiều người ghi đồng thời. Chỉ chạy **một** worker uvicorn:
> connection + lock là per-process.
>
> **OCR offline (PaddleOCR)** giờ chạy trong container qua sidecar service `ocr`
> (xem bước 3). Mặc định `OCR_DEFAULT_ENGINE=paddle` (miễn phí); đổi sang
> `gemini` nếu muốn OCR bằng Gemini vision. Dev trên Windows thì để
> `OCR_SERVICE_URL` trống → paddle chạy qua subprocess venv `qidian-ocr/`.

### Gửi chương từ extension lên server đã host

Trong popup extension, đặt **Server URL** = địa chỉ public của bạn
(vd `https://vietphase.aico.io.vn` — extension đã có sẵn quyền cho `aico.io.vn` và mọi subdomain; domain khác sẽ được hỏi cấp quyền khi bấm gửi) rồi bấm **🚀 Gửi text → server**.
Extension POST file `.txt` tới `POST /api/chapters/upload`.
