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

from .routers import chapters, novels, ocr, translate

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

FRONTEND = Path(__file__).parent.parent / "frontend"

app.mount("/static", NoCacheStaticFiles(directory=str(FRONTEND)), name="static")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/_dev/ping")
def dev_ping():
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(str(FRONTEND / "index.html"))
