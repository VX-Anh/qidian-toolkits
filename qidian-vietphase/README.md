# VietPhase

Agent dịch tiểu thuyết Trung → Việt, đa agent chạy song song (FastAPI + OpenAI).

## Yêu cầu

- Python >= 3.11
- [uv](https://docs.astral.sh/uv/)
- OpenAI API key

## Cài đặt

```bash
uv sync
```

## Cấu hình

Copy `.env.example` → `.env` rồi điền:

| Biến             | Ý nghĩa                                          |
| ---------------- | ------------------------------------------------ |
| `OPENAI_API_KEY` | API key OpenAI                                   |
| `OPENAI_MODEL`   | Model dùng để dịch (mặc định `gpt-4o`)           |
| `INPUT_DIR`      | Thư mục chứa file `.txt` chương tiếng Trung      |
| `OUTPUT_DIR`     | Thư mục lưu bản dịch                             |
| `RULES_DIR`      | Thư mục cấu hình truyện (mặc định `rules`)       |
| `CONCURRENCY`    | Số TranslatorAgent chạy song song (mặc định `3`) |

File chương đặt tên theo dạng `第675章 天演.txt` (số chương nằm trong tên file).

## Chạy server

```bash
uv run uvicorn backend.main:app --reload \
  --reload-include "*.html" --reload-include "*.css" --reload-include "*.js" \
  --port 9999
```

Mở giao diện: http://127.0.0.1:9999

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

**3. Build & chạy**

```bash
docker compose up -d --build
docker compose logs -f          # xem log
```

Server phơi trực tiếp ra ngoài tại `http://IP-VPS:9166` (map sang cổng 9999
trong container). Nhớ mở cổng 9166 trên firewall của VPS (xem cảnh báo bảo mật
bên dưới).

**4. Backup**

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
> **OCR offline (PaddleOCR) KHÔNG chạy trong container** — nó phụ thuộc venv +
> model cài riêng trên máy Windows (`qidian-ocr/`). Trong container hãy dùng OCR
> engine Gemini (`OCR_DEFAULT_ENGINE=gemini`) nếu cần.

### Gửi chương từ extension lên server đã host

Trong popup extension, đặt **Server URL** = địa chỉ public của bạn
(vd `https://vietphase.ten-mien-cua-ban.com`) rồi bấm **🚀 Gửi text → server**.
Extension POST file `.txt` tới `POST /api/chapters/upload`.
