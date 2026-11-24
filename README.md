# qidian-toolkits

Bộ công cụ cá nhân để lấy text chương truyện Qidian (truyện đã mua) và dịch Trung → Việt.

## Thành phần

| Thư mục | Vai trò |
|---|---|
| [`qidian-extension/`](qidian-extension/) | Extension Chrome (MV3): lấy text chương; nếu trang dùng font mã hoá thì chụp màn hình qua native host Python (`mss`), rồi gửi text/ảnh lên VietPhase |
| [`qidian-ocr/`](qidian-ocr/) | PaddleOCR 3.x (PP-OCRv6): CLI `run_ocr.py` và server FastAPI `server.py` (sidecar Docker GPU), có khử dòng trùng do ảnh chồng lấn |
| [`qidian-vietphase/`](qidian-vietphase/) | App chính: backend FastAPI + frontend React, đa agent dịch bằng Claude API, bảng thuật ngữ, Story-Wiki, OCR |
| [`qidian-scraper/`](qidian-scraper/) | Script cào trang chương (thử nghiệm) |
| [`novel-crawler/`](novel-crawler/) | Tải bản raw (17k, Zongheng, 69shu, Biquge, Tieba) thành .txt từng chương cho VietPhase |
| `qidian-extraction.py` | Lấy text bằng Playwright từ trình duyệt đã đăng nhập (thử nghiệm) |
| `llm-wiki-flow.md` | Ghi chú phân tích dự án llm_wiki — nguồn ý tưởng cho Story-Wiki |

## Luồng dữ liệu

```
Qidian (trình duyệt) ──extension──► text .txt ─────────────┐
                        └─► ảnh chụp ─► qidian-ocr ─► text ─┤
                                                            ▼
                                   qidian-vietphase: dịch → bản dịch + glossary + wiki
```

## Dữ liệu

Thư mục `data/` (bản gốc, ảnh chụp, bản dịch) và file SQLite `backend/db/state.db`
**không** được commit — chỉ nằm ở máy hoặc volume Docker. VietPhase mặc định đọc
`../data/input` và ghi `../data/output` (đổi bằng `INPUT_DIR` / `OUTPUT_DIR`).

## Bắt đầu nhanh

```bash
cd qidian-vietphase
cp .env.example .env          # điền ANTHROPIC_API_KEY ...
uv sync
uv run uvicorn backend.main:app --reload --port 9999
# mở http://127.0.0.1:9999
```

Deploy Docker (kèm OCR GPU): xem [`qidian-vietphase/README.md`](qidian-vietphase/README.md).
Cài native host cho extension: xem [`qidian-extension/native-host/README.md`](qidian-extension/native-host/README.md).
