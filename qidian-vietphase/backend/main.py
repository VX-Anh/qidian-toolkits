from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope


class NoCacheStaticFiles(StaticFiles):
    """StaticFiles nhưng tắt browser cache — tránh JS/HTML cũ được serve trong dev."""
    async def get_response(self, path: str, scope: Scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        return response

from .routers import chapters, novels, ocr, translate, wiki

app = FastAPI(title="VietPhase", version="0.1.0", debug=True)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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


@app.get("/_dev/ping")
def dev_ping():
    return {"ok": True}


@app.get("/_dev/encdiag")
def dev_encdiag():
    import sys as _sys, locale as _locale
    from pathlib import Path as _Path
    from .config import settings as _s
    from .shared import get_state as _gs
    from .agent import vietphase_import as _vp

    def _surr(x: str):
        return any(0xD800 <= ord(c) <= 0xDFFF for c in x)

    SLUG = "cau-tai-vo-dao-the-gioi-thanh-thanh"
    st = _gs()
    glob_pre = {p.name: _surr(p.name) for p in _Path(_s.input_dir).glob("*68*")}
    scan_out = _vp.scan(st, _s, SLUG)
    scan_corrupt = [n.encode("ascii", "backslashreplace").decode() for n in scan_out if _surr(n)]
    glob_post = {p.name: _surr(p.name) for p in _Path(_s.input_dir).glob("*68*")}
    db_all = _gs().get_chapters(SLUG)
    db_corrupt = [c["chapter_num"] for c in db_all if _surr(c["filename"])]
    return {
        "fsencoding": _sys.getfilesystemencoding(),
        "locale": _locale.setlocale(_locale.LC_CTYPE),
        "glob_pre_corrupt": [k.encode("ascii","backslashreplace").decode() for k,v in glob_pre.items() if v],
        "glob_post_corrupt": [k.encode("ascii","backslashreplace").decode() for k,v in glob_post.items() if v],
        "scan_corrupt": scan_corrupt,
        "db_corrupt_chapters": db_corrupt,
        "db_total": len(db_all),
    }


@app.get("/")
def index():
    return FileResponse(str(FRONTEND / "index.html"))
