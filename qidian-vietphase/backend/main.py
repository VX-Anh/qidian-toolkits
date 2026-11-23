import hmac
import logging
from pathlib import Path

from fastapi import FastAPI, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope

from .config import settings
from .routers import chapters, novels, ocr, translate, wiki

log = logging.getLogger("vietphase")


class NoCacheStaticFiles(StaticFiles):
    """StaticFiles nhưng tắt browser cache — tránh JS/HTML cũ được serve trong dev."""
    async def get_response(self, path: str, scope: Scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        return response


app = FastAPI(title="VietPhase", version="0.1.0", debug=settings.dev_mode)

_cors = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
if _cors:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# ── Auth: một token chung bảo vệ /api/* ──────────────────────────────────────
# Client gửi token qua một trong các cách:
#   - cookie `vp_token` (frontend — đặt qua trang /login)
#   - header `X-API-Token: <token>` hoặc `Authorization: Bearer <token>` (extension)
#   - query `?token=<token>` (EventSource từ extension, không gắn được header)
_COOKIE = "vp_token"


def _token_ok(candidate: str | None) -> bool:
    return bool(candidate) and hmac.compare_digest(candidate, settings.api_token)


def _request_token(request: Request) -> str | None:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (
        request.headers.get("x-api-token")
        or request.query_params.get("token")
        or request.cookies.get(_COOKIE)
    )


@app.middleware("http")
async def require_token(request: Request, call_next):
    if settings.api_token and request.url.path.startswith("/api/"):
        if request.method != "OPTIONS" and not _token_ok(_request_token(request)):
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return await call_next(request)


if not settings.api_token:
    log.warning("API_TOKEN chưa đặt — /api/* KHÔNG có xác thực. Chỉ chạy như vậy ở máy local.")


# Trang đăng nhập cùng phong cách app: nạp /static/tokens.css (không nằm dưới /api/
# nên không cần token), theme theo lựa chọn vp:theme của app hoặc theo hệ thống.
# Giá trị dự phòng trong var(...) giữ trang dùng được nếu tokens.css không tải được.
_LOGIN_HTML = """<!doctype html><html lang="vi" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>VietPhase — Đăng nhập</title>
<script>(function(){var t=null;try{t=localStorage.getItem("vp:theme")}catch(e){}
if(t!=="light"&&t!=="dark"){try{t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}catch(e){t="dark"}}
document.documentElement.setAttribute("data-theme",t)})();</script>
<link rel="stylesheet" href="/static/tokens.css">
<style>
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{display:grid;place-items:center;min-height:100vh;min-height:100dvh;padding:var(--space-4,16px);
  font-family:var(--font-ui,system-ui,sans-serif);font-size:var(--text-md,14px);line-height:var(--lh-base,1.5);
  color:var(--fg-1,#f3f4f6);background:var(--bg-app,#030712);overflow-wrap:anywhere}
:root[data-theme="light"] body{color:var(--fg-1,#111827);background:var(--bg-app,#f9fafb)}
.login{width:100%;max-width:360px;padding:var(--space-6,24px);background:var(--bg-surface,#111827);
  border:1px solid var(--border,#1f2937);border-radius:var(--radius-lg,8px);box-shadow:var(--shadow-modal,0 10px 40px rgba(0,0,0,.5))}
:root[data-theme="light"] .login{background:var(--bg-surface,#fff);border-color:var(--border,#e5e7eb);box-shadow:0 4px 24px rgba(0,0,0,.08)}
.brand{margin:0 0 var(--space-1,4px);font-family:var(--font-display,Georgia,serif);font-size:var(--text-3xl,24px);
  font-weight:600;line-height:var(--lh-tight,1.15);color:var(--fg-1,#f3f4f6)}
:root[data-theme="light"] .brand{color:var(--fg-1,#111827)}
.sub{margin:0 0 var(--space-5,20px);color:var(--fg-3,#9ca3af);font-size:var(--text-base,13px)}
:root[data-theme="light"] .sub{color:var(--fg-3,#4b5563)}
label{display:block;margin-bottom:var(--space-2,8px);font-weight:500;color:var(--fg-2,#e5e7eb)}
:root[data-theme="light"] label{color:var(--fg-2,#1f2937)}
input{display:block;width:100%;min-height:var(--tap-min,44px);padding:var(--space-2,8px) var(--space-3,12px);
  font:inherit;font-size:16px;color:var(--fg-1,#f3f4f6);background:var(--bg-input,#1f2937);
  border:1px solid var(--border-hover,#374151);border-radius:var(--radius-md,6px);
  transition:border-color var(--dur,150ms) var(--ease,ease)}
:root[data-theme="light"] input{color:var(--fg-1,#111827);background:var(--bg-input,#fff);border-color:var(--border-hover,#9ca3af)}
input[aria-invalid="true"]{border-color:var(--danger,#f87171)}
button{display:block;width:100%;min-height:var(--tap-min,44px);margin-top:var(--space-4,16px);
  padding:var(--space-2,8px) var(--space-4,16px);font:inherit;font-weight:600;color:#fff;
  background:var(--accent-fill,#4f46e5);border:1px solid transparent;border-radius:var(--radius-md,6px);cursor:pointer;
  transition:background-color var(--dur,150ms) var(--ease,ease)}
button:hover{background:var(--accent-fill-hover,#4338ca)}
input:focus{outline:none}
input:focus-visible,button:focus-visible{outline:2px solid var(--border-focus,#6366f1);outline-offset:2px}
input:focus-visible{border-color:var(--border-focus,#6366f1)}
.err{margin:0 0 var(--space-4,16px);padding:var(--space-2,8px) var(--space-3,12px);border-radius:var(--radius-md,6px);
  color:var(--danger,#fca5a5);background:var(--danger-bg,#450a0a);border:1px solid var(--danger,#f87171)}
:root[data-theme="light"] .err{color:var(--danger,#991b1b);background:var(--danger-bg,#fef2f2)}
.err:empty{display:none}
.hint{margin:var(--space-3,12px) 0 0;color:var(--fg-3,#9ca3af);font-size:var(--text-sm,12px)}
:root[data-theme="light"] .hint{color:var(--fg-3,#4b5563)}
@media (prefers-reduced-motion: reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
</style></head><body>
<main class="login">
<h1 class="brand">VietPhase</h1>
<p class="sub">Nhập token để vào đọc và dịch truyện.</p>
<div role="alert" id="login-err" class="err">{err}</div>
<form method="post" action="/login">
<label for="token">Token truy cập</label>
<input id="token" type="password" name="token" autocomplete="current-password"
  autocapitalize="off" spellcheck="false" autofocus required{invalid}>
<button type="submit">Đăng nhập</button>
</form>
<p class="hint">Token là giá trị API_TOKEN đặt trên máy chủ.</p>
</main></body></html>"""


def _login_html(err: str = "") -> str:
    invalid = ' aria-invalid="true" aria-describedby="login-err"' if err else ""
    return _LOGIN_HTML.replace("{err}", err).replace("{invalid}", invalid)


@app.get("/login", response_class=HTMLResponse)
def login_page():
    return _login_html()


@app.post("/login")
def login(request: Request, token: str = Form(...)):
    if not settings.api_token:
        return RedirectResponse("/", status_code=303)
    if not _token_ok(token):
        return HTMLResponse(
            _login_html("Token không đúng. Kiểm tra lại rồi thử lại."), status_code=401
        )
    resp = RedirectResponse("/", status_code=303)
    resp.set_cookie(
        _COOKIE, token, httponly=True, samesite="strict",
        secure=request.url.scheme == "https", max_age=60 * 60 * 24 * 90,
    )
    return resp


app.include_router(novels.router)
app.include_router(chapters.router)
app.include_router(translate.router)
app.include_router(ocr.router)
app.include_router(wiki.router)

FRONTEND = Path(__file__).parent.parent / "frontend"

# Dev: tắt cache để sửa JSX là thấy ngay. Prod: cache bình thường (ETag/Last-Modified);
# file build có ?v=<hash> nên đổi bản là trình duyệt tải lại.
_Static = NoCacheStaticFiles if settings.dev_mode else StaticFiles
app.mount("/static", _Static(directory=str(FRONTEND)), name="static")

# Bản build sẵn (node frontend/build.mjs): JSX đã biên dịch + React production.
# Dùng khi có và DEV_MODE tắt; không có thì vẫn chạy bản dev (Babel trong trình duyệt).
_DIST_INDEX = FRONTEND / "dist" / "index.html"


@app.get("/health")
def health():
    return {"status": "ok"}


if settings.dev_mode:
    @app.get("/_dev/ping")
    def dev_ping():
        return {"ok": True}


@app.get("/")
def index():
    if not settings.dev_mode and _DIST_INDEX.is_file():
        return FileResponse(str(_DIST_INDEX), headers={"Cache-Control": "no-cache"})
    return FileResponse(str(FRONTEND / "index.html"), headers={"Cache-Control": "no-cache"})
