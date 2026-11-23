"""Tên riêng: báo cáo kiểm tên, kiểm lại cả truyện, đổi tên hàng loạt (có hoàn tác).

- GET  /api/names/{slug}/report        chữ đa âm chưa chốt + kết quả kiểm tên từng chương
- POST /api/names/{slug}/check         kiểm + tự sửa tên cho mọi chương đã dịch
- POST /api/names/{slug}/rename/preview  {old_vi, new_vi} → số chỗ sẽ thay theo chương
- POST /api/names/{slug}/rename/apply    → sao lưu, thay trong bản dịch + bảng thuật ngữ
- POST /api/names/{slug}/rename/undo     {backup_id} → khôi phục bản sao lưu
"""
from __future__ import annotations

import json
import re
import shutil
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..agent.name_check import check_chapter_file
from ..agent.novel_loader import NOVEL_MD_LOCK, load_novel, write_novel_md
from ..agent.state import ChapterStatus
from ..config import settings
from ..safety import check_request_params, check_slug
from ..shared import get_state
from .translate import _ensure_idle

router = APIRouter(prefix="/api/names", tags=["names"], dependencies=[Depends(check_request_params)])

_BACKUP_ID = re.compile(r"^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$")
_SNIPPET = 40


class RenameRequest(BaseModel):
    old_vi: str
    new_vi: str


class UndoRequest(BaseModel):
    backup_id: str


def _profile(slug: str):
    try:
        return load_novel(settings.rules_dir, slug)
    except FileNotFoundError:
        raise HTTPException(404, f"Không tìm thấy rules/{slug}/novel.md")


def _done_chapters(slug: str) -> list[dict]:
    out_root = (settings.output_dir / slug).resolve()
    res = []
    for c in get_state().get_chapters(slug):
        p = c.get("translated_path")
        if c["status"] != ChapterStatus.DONE or not p:
            continue
        try:
            rp = Path(p).resolve()
        except OSError:
            continue
        # Chỉ đụng file nằm trong OUTPUT_DIR/<slug>.
        if rp.is_file() and rp.is_relative_to(out_root):
            res.append({**c, "_path": rp})
    return res


def _check_names(old: str, new: str) -> tuple[str, str]:
    old, new = old.strip(), new.strip()
    for v in (old, new):
        if not v or len(v) > 100 or any(ch in v for ch in "|\n\r"):
            raise HTTPException(400, "Tên không hợp lệ (rỗng, quá dài hoặc có ký tự | / xuống dòng)")
    if old == new:
        raise HTTPException(400, "Tên mới trùng tên cũ")
    return old, new


def _pattern(old: str) -> re.Pattern:
    return re.compile(rf"(?<!\w){re.escape(old)}(?!\w)")


def _backup_root(slug: str) -> Path:
    return settings.output_dir / ".name-backups" / slug


@router.get("/{slug}/report")
def report(slug: str):
    check_slug(slug)
    profile = _profile(slug)
    checks = get_state().get_name_checks(slug)
    chapters = []
    for c in get_state().get_chapters(slug):
        nc = checks.get(c["filename"])
        if nc:
            chapters.append({"filename": c["filename"], "chapter_num": c["chapter_num"],
                             "fixes": nc["fixes"], "issues": nc["issues"]})
    return {"conflicts": profile.reading_table().conflicts(), "chapters": chapters}


@router.post("/{slug}/check")
async def check_all(slug: str):
    check_slug(slug)
    _ensure_idle(slug)
    profile = _profile(slug)
    fixed = issues = checked = 0
    for c in _done_chapters(slug):
        res = await check_chapter_file(get_state(), c, settings.input_dir / c["filename"], profile)
        if res is None:
            continue
        checked += 1
        fixed += res.fixed_count
        issues += len(res.issues)
    return {"checked": checked, "fixed": fixed, "issues": issues}


@router.post("/{slug}/rename/preview")
def rename_preview(slug: str, req: RenameRequest):
    check_slug(slug)
    old, new = _check_names(req.old_vi, req.new_vi)
    pat = _pattern(old)
    chapters, total = [], 0
    for c in _done_chapters(slug):
        text = c["_path"].read_text(encoding="utf-8")
        hits = list(pat.finditer(text))
        if not hits:
            continue
        m = hits[0]
        sample = text[max(0, m.start() - _SNIPPET):m.end() + _SNIPPET].replace("\n", " ")
        chapters.append({"filename": c["filename"], "chapter_num": c["chapter_num"],
                         "count": len(hits), "sample": sample})
        total += len(hits)
    rows = sum(1 for t in _profile(slug).all_terms() if t.vi == old)
    return {"old_vi": old, "new_vi": new, "total": total, "chapters": chapters, "glossary_rows": rows}


@router.post("/{slug}/rename/apply")
def rename_apply(slug: str, req: RenameRequest):
    check_slug(slug)
    _ensure_idle(slug)   # job dịch đang ghi bản dịch / novel.md → không thay chen ngang
    old, new = _check_names(req.old_vi, req.new_vi)
    pat = _pattern(old)
    backup_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    bdir = _backup_root(slug) / backup_id
    manifest: dict = {"old_vi": old, "new_vi": new, "files": [], "novel_md": False}
    replaced = 0
    changed: list[tuple[Path, str]] = []
    for c in _done_chapters(slug):
        text = c["_path"].read_text(encoding="utf-8")
        new_text, k = pat.subn(new, text)
        if k:
            changed.append((c["_path"], new_text))
            replaced += k
    md = settings.rules_dir / slug / "novel.md"
    with NOVEL_MD_LOCK:
        md_text = md.read_text(encoding="utf-8") if md.is_file() else ""
        row = re.compile(rf"^(\|[^|\n]*\|\s*){re.escape(old)}(\s*\|)", re.M)
        new_md, rows = row.subn(rf"\g<1>{new}\g<2>", md_text)
        if not changed and not rows:
            return {"backup_id": None, "files": 0, "replaced": 0, "glossary_rows": 0}
        bdir.mkdir(parents=True, exist_ok=True)
        for i, (path, _) in enumerate(changed):
            name = f"{i:04d}.txt"
            shutil.copy2(path, bdir / name)
            manifest["files"].append({"path": str(path), "backup": name})
        if rows:
            shutil.copy2(md, bdir / "novel.md")
            manifest["novel_md"] = True
        (bdir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        for path, text in changed:
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_bytes(text.encode("utf-8"))
            tmp.replace(path)
        if rows:
            write_novel_md(md, new_md)
    return {"backup_id": backup_id, "files": len(changed), "replaced": replaced, "glossary_rows": rows}


@router.post("/{slug}/rename/undo")
def rename_undo(slug: str, req: UndoRequest):
    check_slug(slug)
    _ensure_idle(slug)
    if not _BACKUP_ID.match(req.backup_id):
        raise HTTPException(400, "backup_id không hợp lệ")
    bdir = _backup_root(slug) / req.backup_id
    mf = bdir / "manifest.json"
    if not mf.is_file():
        raise HTTPException(404, "Không tìm thấy bản sao lưu")
    manifest = json.loads(mf.read_text(encoding="utf-8"))
    out_root = (settings.output_dir / slug).resolve()
    restored = 0
    for f in manifest.get("files", []):
        dst = Path(f["path"]).resolve()
        src = bdir / Path(f["backup"]).name
        if dst.is_relative_to(out_root) and src.is_file():
            shutil.copy2(src, dst)
            restored += 1
    if manifest.get("novel_md") and (bdir / "novel.md").is_file():
        with NOVEL_MD_LOCK:
            write_novel_md(settings.rules_dir / slug / "novel.md",
                           (bdir / "novel.md").read_text(encoding="utf-8"))
    shutil.rmtree(bdir, ignore_errors=True)
    return {"restored": restored, "novel_md": bool(manifest.get("novel_md"))}
