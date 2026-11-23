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


_LOGIN_HTML = """<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>VietPhase — Đăng nhập</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;margin:0;background:#f5f5f4}
form{background:#fff;padding:24px;border-radius:12px;box-shadow:0 2px 12px #0001;width:min(320px,90vw)}
input,button{width:100%;box-sizing:border-box;padding:10px;margin-top:10px;font-size:16px}
.err{color:#b91c1c;font-size:14px}</style></head><body>
<form method="post" action="/login"><b>VietPhase</b>{err}
<input type="password" name="token" placeholder="API token" autofocus required>
<button type="submit">Đăng nhập</button></form></body></html>"""


@app.get("/login", response_class=HTMLResponse)
def login_page():
    return _LOGIN_HTML.replace("{err}", "")


@app.post("/login")
def login(request: Request, token: str = Form(...)):
    if not settings.api_token:
        return RedirectResponse("/", status_code=303)
    if not _token_ok(token):
        return HTMLResponse(
            _LOGIN_HTML.replace("{err}", '<p class="err">Sai token</p>'), status_code=401
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

app.mount("/static", NoCacheStaticFiles(directory=str(FRONTEND)), name="static")


@app.get("/health")
def health():
    return {"status": "ok"}


if settings.dev_mode:
    @app.get("/_dev/ping")
    def dev_ping():
        return {"ok": True}


@app.get("/")
def index():
    return FileResponse(str(FRONTEND / "index.html"))
