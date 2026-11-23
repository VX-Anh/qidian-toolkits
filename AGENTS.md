# AGENTS.md — qidian-toolkits

Bộ công cụ cá nhân: lấy text chương truyện Qidian (truyện chủ repo đã mua) và dịch Trung → Việt.
Tổng quan thư mục: `README.md`. App chính là `qidian-vietphase/` (chi tiết: `qidian-vietphase/CLAUDE.md`).

## Cấu trúc

- `qidian-vietphase/backend/` — FastAPI + agent dịch trên Claude API (`backend/agent/`), SQLite.
- `qidian-vietphase/frontend/` — React 18 **không có bước build khi dev**: `index.html` nạp
  `src/*.jsx` qua Babel standalone, thứ tự thẻ `<script>` = thứ tự phụ thuộc. Mỗi file JSX là
  một classic script dùng chung global scope → hook đặt alias riêng theo file
  (`useStateT`, `useEffectA`…), không `import`/`export`.
  Bản production: `node qidian-vietphase/frontend/build.mjs` → `frontend/dist/` (đừng commit `dist/`).
- `qidian-extension/` — extension Chrome MV3; `qidian-ocr/` — PaddleOCR sidecar.
- Deploy: `qidian-vietphase/deploy/` (https://read.aico.io.vn qua Cloudflare Tunnel).

## Luật chung

- Giao diện và chú thích bằng **tiếng Việt**. Chữ Hán chỉ xuất hiện ở nội dung truyện/thuật ngữ.
- Đổi giao diện: giữ nguyên API backend và hành vi hiện có (luồng dịch, OCR, sửa bản gốc/bản
  dịch, thuật ngữ, Story-Wiki, Settings). Không đổi route `/api/*`.
- Không thêm framework/bước build cho chế độ dev; thư viện mới chỉ khi thật cần, nạp từ CDN có
  phiên bản cố định + SRI như các script hiện có, và thêm vào `build.mjs` nếu bản prod cần.
- Màn hẹp: không cuộn ngang ở 360px; tôn trọng `prefers-reduced-motion`.
- Không commit dữ liệu truyện (`data/`, ảnh chụp, bản dịch) hay `state.db`.

## Tự kiểm trước khi xong

- Cú pháp JSX: `npx --yes esbuild@0.24.0 --loader:.jsx=jsx qidian-vietphase/frontend/src/<file>.jsx > /dev/null`
  cho mọi file đã sửa, và `node qidian-vietphase/frontend/build.mjs` phải chạy xong.
- Backend (nếu có sửa): `cd qidian-vietphase && uv run python -m compileall -q backend`.
- Chạy thử: `cd qidian-vietphase && uv run uvicorn backend.main:app --port 9999`
  (`DEV_MODE=true` để dùng bản dev; không cần API key để mở giao diện).
