# Kiến trúc

Bản đồ do Tech Lead cập nhật (lần gần nhất: T-950d2566). Agent đọc file này
trước khi làm để biết các phần đã có; sửa kiến trúc thì cập nhật sơ đồ.

```mermaid
flowchart TB
  subgraph Browser["Trình duyệt (read.aico.io.vn)"]
    IDX["index.html<br/>script theme inline -> data-theme"]
    BR["api_bridge.js<br/>401 -> /login"]
    subgraph CSS["CSS"]
      TOK["tokens.css<br/>token sáng/tối, bảng màu đọc"]
      STY["styles.css<br/>component: btn, chip, tab, seg, input, card, status-block, focus, reduced-motion"]
      RCSS["reader.css<br/>rd-* bố cục đọc, mobile toàn màn hình"]
    end
    subgraph JSX["JSX classic scripts (thứ tự nạp)"]
      TW["tweaks-panel.jsx<br/>useTweaks, fontReading"]
      CMP["components.jsx<br/>Icon, StatusBlock, Modal, Toast"]
      SH["shell.jsx<br/>LeftRail, TopBar + nút theme"]
      CH["chapters.jsx"]
      TV["translation_view.jsx<br/>overlay đối chiếu, sửa tại chỗ"]
      GL["glossary.jsx"]
      WK["wiki.jsx"]
      OUT["output.jsx<br/>Reader: mục lục, trước/sau, bảng Aa, nhớ vị trí"]
      SET["settings.jsx<br/>novel.md theo version"]
      CK["cmdk.jsx"]
      APP["app.jsx<br/>state, hash router, theme, chaptersStatus, SSE"]
    end
    LS[("localStorage<br/>vp:theme<br/>vp:reader:prefs:v1<br/>vp:reader:progress:v1:slug")]
  end

  subgraph Backend["Backend FastAPI (qidian-vietphase/backend)"]
    MAIN["main.py<br/>auth token, /login dùng /static/tokens.css, /static, /"]
    RT["routers: novels, chapters, translate, ocr, wiki"]
    AG["agent: Orchestrator, Translator, Extractor"]
    ST[("SharedState SQLite")]
    FS[("INPUT_DIR, OUTPUT_DIR, rules/slug/novel.md")]
  end

  BUILD["build.mjs -> dist/ (app.js, React prod)"]
  SEED["scripts/seed_ux_demo.py<br/>dữ liệu mẫu tạm để kiểm"]
  CC["frontend/tools/check-contrast.mjs"]

  IDX --> CSS
  IDX --> BR --> JSX
  TOK --> STY --> RCSS
  APP --> SH & CH & GL & WK & OUT & SET & CK & TV
  CMP --> SH & CH & OUT & TV & GL & WK & SET
  TW --> APP
  APP -- "#/slug/tab, #/slug/output/n, /doi-chieu" --> IDX
  OUT <--> LS
  APP <--> LS
  APP -- "fetch /api/*" --> MAIN
  OUT -- "GET /api/chapters/file/output" --> MAIN
  APP -- "EventSource stream" --> MAIN
  MAIN --> RT --> AG
  RT --> ST & FS
  AG --> ST & FS
  BUILD -. "đọc index.html + src/*.jsx" .-> JSX
  SEED -. "ghi vào thư mục tạm" .-> ST & FS
  CC -. "đọc" .-> TOK
```
