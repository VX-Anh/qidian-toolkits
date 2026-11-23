"""Tên riêng: báo cáo kiểm tên, kiểm lại cả truyện, đổi tên hàng loạt (có hoàn tác).

- GET  /api/names/{slug}/report        chữ đa âm chưa chốt + kết quả kiểm tên từng chương
- POST /api/names/{slug}/check         kiểm + tự sửa tên cho mọi chương đã dịch
- POST /api/names/{slug}/rename/preview  {old_vi, new_vi} → số chỗ sẽ thay theo chương
- POST /api/names/{slug}/rename/apply    → sao lưu, thay trong bản dịch + bảng thuật ngữ
- POST /api/names/{slug}/rename/undo     {backup_id} → khôi phục bản sao lưu
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import time
import unicodedata
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..agent.name_check import check_chapter_file
from ..agent.hanviet import READINGS_SECTION, is_han, norm_syllable, syllables
from ..agent.novel_loader import NOVEL_MD_LOCK, load_novel, write_novel_md
from ..agent.state import ChapterStatus
from ..config import settings
from ..safety import check_request_params, check_slug
from ..shared import get_state
from .translate import novel_busy, novel_files_lock

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
    old = unicodedata.normalize("NFC", old.strip())
    new = unicodedata.normalize("NFC", new.strip())
    for v in (old, new):
        if not v or len(v) > 100 or any(ch in v for ch in "|\\\n\r"):
            raise HTTPException(400, "Tên không hợp lệ (rỗng, quá dài hoặc có ký tự | \\ / xuống dòng)")
    if old == new:
        raise HTTPException(400, "Tên mới trùng tên cũ")
    return old, new


def _pattern(old: str) -> re.Pattern:
    return re.compile(rf"(?<!\w){re.escape(old)}(?!\w)")


def _nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _longer_names(slug: str, old: str) -> list[str]:
    """Tên chuẩn khác trong bảng có chứa tên cũ (vd "Lâm An Thành" khi đổi "Lâm An")."""
    pat = _pattern(old)
    names = {_nfc(t.vi) for t in _profile(slug).all_terms() if t.vi}
    return sorted({v for v in names if v != old and pat.search(v)}, key=len, reverse=True)


def _replace(text: str, old: str, new: str, protected: list[str]) -> tuple[str, int]:
    """Thay tên cũ trừ các lần nằm trong một tên chuẩn dài hơn (giữ tên đó khớp bảng)."""
    text = _nfc(text)
    spans = [(m.start(), m.end()) for vi in protected for m in _pattern(_nfc(vi)).finditer(text)]
    n = 0

    def sub(m: re.Match) -> str:
        nonlocal n
        if any(a <= m.start() and m.end() <= b for a, b in spans):
            return m.group(0)
        n += 1
        return new

    return _pattern(old).sub(sub, text), n


def _update_readings(md: str, zhs: list[str], old: str, new: str) -> str:
    """Tên phiên âm từng chữ đổi âm → chốt âm MỚI của đúng các chữ đổi âm trong mục
    Âm Hán-Việt (sửa dòng có sẵn, thêm dòng thiếu, tạo mục nếu chưa có). Không thì bước
    dò tên vẫn ép âm cũ học từ các tên khác. Chữ giữ nguyên âm không bị chốt (giữ chữ đa âm)."""
    osy, nsy = syllables(old), syllables(new)
    want: dict[str, str] = {}
    for zh in zhs:
        if len(zh) == len(nsy) == len(osy) and all(is_han(c) for c in zh):
            for c, o, n in zip(zh, osy, nsy):
                if norm_syllable(o) != norm_syllable(n):
                    want[c] = norm_syllable(n)
    if not want:
        return md
    marker = f"## {READINGS_SECTION}"
    if marker not in md:
        md = (md.rstrip("\n") + f"\n\n{marker}\n\n"
              "Âm Hán-Việt đã chốt cho từng chữ (tự ghi khi gặp chữ mới; sửa ở đây để đổi).\n\n"
              "| Chữ | Âm | Ghi chú |\n|---|---|---|\n")
    start = md.index(marker)
    nxt = re.search(r"\n## ", md[start + 3:])
    end = start + 3 + nxt.start() if nxt else len(md)
    block = md[start:end]
    for c, r in want.items():
        row = re.compile(rf"^(\|\s*{re.escape(c)}\s*\|\s*)[^|\n]*?(\s*\|)", re.M)
        if row.search(block):
            block = row.sub(rf"\g<1>{r}\g<2>", block)
        else:
            block = block.rstrip("\n") + f"\n| {c} | {r} | đổi tên |\n"
    return md[:start] + block + md[end:]


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
    profile = _profile(slug)
    fixed = issues = checked = 0
    with novel_busy(slug, "kiểm tên riêng"), novel_files_lock(slug):
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
    protected = _longer_names(slug, old)
    chapters, total = [], 0
    for c in _done_chapters(slug):
        text = unicodedata.normalize("NFC", c["_path"].read_text(encoding="utf-8"))
        _, k = _replace(text, old, new, protected)
        if not k:
            continue
        m = _pattern(old).search(text)
        sample = text[max(0, m.start() - _SNIPPET):m.end() + _SNIPPET].replace("\n", " ") if m else ""
        chapters.append({"filename": c["filename"], "chapter_num": c["chapter_num"],
                         "count": k, "sample": sample})
        total += k
    rows = sum(1 for t in _profile(slug).all_terms() if t.vi == old)
    return {"old_vi": old, "new_vi": new, "total": total, "chapters": chapters,
            "glossary_rows": rows, "protected": protected}


@router.post("/{slug}/rename/apply")
def rename_apply(slug: str, req: RenameRequest):
    """Đổi tên trong bản dịch + bảng thuật ngữ + âm đã chốt, một giao dịch có sao lưu."""
    check_slug(slug)
    old, new = _check_names(req.old_vi, req.new_vi)
    with novel_busy(slug, "đổi tên riêng"), novel_files_lock(slug):
        protected = _longer_names(slug, old)
        backup_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
        bdir = _backup_root(slug) / backup_id
        manifest: dict = {"old_vi": old, "new_vi": new, "files": [], "novel_md": False}
        replaced = 0
        changed: list[tuple[Path, str]] = []
        for c in _done_chapters(slug):
            new_text, k = _replace(c["_path"].read_text(encoding="utf-8"), old, new, protected)
            if k:
                changed.append((c["_path"], new_text))
                replaced += k
        md = settings.rules_dir / slug / "novel.md"
        with NOVEL_MD_LOCK:
            orig_md = md.read_text(encoding="utf-8") if md.is_file() else ""
            md_text = _nfc(orig_md)
            row = re.compile(rf"^\|\s*([^|\n]*?)\s*\|\s*{re.escape(old)}\s*\|", re.M)
            zhs = [m.group(1) for m in row.finditer(md_text)]
            new_md, rows = re.compile(
                rf"^(\|[^|\n]*\|\s*){re.escape(old)}(\s*\|)", re.M).subn(rf"\g<1>{new}\g<2>", md_text)
            new_md = _update_readings(new_md, zhs, old, new)
            if not changed and new_md == md_text:
                return {"backup_id": None, "files": 0, "replaced": 0, "glossary_rows": 0}
            bdir.mkdir(parents=True, exist_ok=True)
            for i, (path, _) in enumerate(changed):
                name = f"{i:04d}.txt"
                shutil.copy2(path, bdir / name)
                manifest["files"].append({"path": str(path), "backup": name})
            if md.is_file():
                shutil.copy2(md, bdir / "novel.md")   # luôn sao lưu: hoàn tác trả cả bảng thuật ngữ
                manifest["novel_md"] = True
            (bdir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
            for path, text in changed:
                tmp = path.with_name(path.name + ".tmp")
                tmp.write_bytes(text.encode("utf-8"))
                tmp.replace(path)
            if new_md != md_text:
                write_novel_md(md, new_md)
            # Hash nội dung SAU khi đổi (đọc lại từ đĩa): hoàn tác chỉ khôi phục khi chưa ai
            # sửa tiếp. Mất điện giữa chừng → manifest thiếu hash → hoàn tác từ chối (an toàn).
            for (path, _), f in zip(changed, manifest["files"]):
                f["after"] = _sha(path.read_bytes())
            manifest["novel_md_after"] = _sha(md.read_bytes()) if md.is_file() else None
            (bdir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    return {"backup_id": backup_id, "files": len(changed), "replaced": replaced,
            "glossary_rows": rows, "protected": protected}


@router.post("/{slug}/rename/undo")
def rename_undo(slug: str, req: UndoRequest):
    """Khôi phục bản sao lưu của một lần đổi tên — tất cả hoặc không gì.

    Từ chối (409) nếu bất kỳ file nào đã đổi sau lần đổi tên. Kiểm hash và khôi phục chạy
    trong cùng khoá (khoá file của truyện + khoá novel.md) nên không có lần lưu nào chen vào.
    Lỗi giữa chừng → trả các file đã ghi về như trước khi hoàn tác; sao lưu chỉ xoá khi xong.
    """
    check_slug(slug)
    if not _BACKUP_ID.match(req.backup_id):
        raise HTTPException(400, "backup_id không hợp lệ")
    with novel_busy(slug, "hoàn tác đổi tên"), novel_files_lock(slug), NOVEL_MD_LOCK:
        bdir = _backup_root(slug) / req.backup_id
        mf = bdir / "manifest.json"
        if not mf.is_file():
            raise HTTPException(404, "Không tìm thấy bản sao lưu")
        manifest = json.loads(mf.read_text(encoding="utf-8"))
        out_root = (settings.output_dir / slug).resolve()
        md_path = settings.rules_dir / slug / "novel.md"

        # 1. Lập kế hoạch + kiểm đủ mọi thứ TRƯỚC khi ghi.
        plan: list[tuple[Path, Path, str | None]] = []   # (đích, nguồn sao lưu, hash sau đổi tên)
        for f in manifest.get("files", []):
            dst = Path(f["path"]).resolve()
            src = bdir / Path(f["backup"]).name
            if not dst.is_relative_to(out_root) or not src.is_file():
                raise HTTPException(409, "Bản sao lưu không đầy đủ hoặc đường dẫn không hợp lệ")
            plan.append((dst, src, f.get("after")))
        if manifest.get("novel_md"):
            if not (bdir / "novel.md").is_file():
                raise HTTPException(409, "Bản sao lưu thiếu novel.md")
            plan.append((md_path, bdir / "novel.md", manifest.get("novel_md_after")))
        changed_after = [dst.name for dst, _, after in plan
                         if not after or not dst.is_file() or _sha(dst.read_bytes()) != after]
        if changed_after:
            raise HTTPException(409, "Không hoàn tác được: đã có thay đổi sau lần đổi tên ở "
                                     + ", ".join(changed_after[:5]))

        # 2. Chuẩn bị đủ file tạm TRƯỚC (bước có thể hết dung lượng); lỗi → dọn tmp, chưa
        #    đổi gì. Sau đó chỉ còn os.replace (đổi tên, không cần thêm dung lượng).
        tmps: list[tuple[Path, Path]] = []
        try:
            for dst, src, _ in plan:
                tmp = dst.with_name(dst.name + ".undo.tmp")
                tmps.append((tmp, dst))
                tmp.write_bytes(src.read_bytes())
        except OSError as exc:
            for tmp, _ in tmps:
                tmp.unlink(missing_ok=True)
            raise HTTPException(500, f"Hoàn tác lỗi, chưa thay đổi file nào: {exc}") from exc
        done = 0
        try:
            for tmp, dst in tmps:
                tmp.replace(dst)
                done += 1
        except OSError as exc:
            for tmp, _ in tmps[done:]:
                tmp.unlink(missing_ok=True)
            # Giữ bản sao lưu; báo đúng số file đã khôi phục.
            raise HTTPException(500, f"Hoàn tác dừng giữa chừng ({done}/{len(tmps)} file), "
                                     f"bản sao lưu vẫn giữ: {exc}") from exc
        shutil.rmtree(bdir, ignore_errors=True)
    files = sum(1 for dst, _, _ in plan if dst != md_path)
    return {"restored": files, "novel_md": bool(manifest.get("novel_md"))}
