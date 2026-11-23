"""Kiểm + tự sửa tên riêng trong bản dịch theo bảng thuật ngữ (tất định, không gọi model).

- Biến thể của một tên chuẩn (khác dấu/i-y: "Tư Kì", "Tu Ky" ↔ "Tư Kỳ") → tự sửa khi chỉ
  khớp đúng MỘT tên chuẩn có mặt trong chương; khớp nhiều tên → chỉ báo.
- Tên có trong bản gốc nhưng bản dịch không có tên Việt chuẩn nào → báo "thiếu"
  (thường là model đặt tên khác hẳn, vd "Sư Tịch" thay "Tư Kỳ").
- Bản dịch còn chữ Hán → báo.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from .hanviet import fold, has_han, is_name_like, syllables
from .novel_loader import NovelProfile

_WORD = re.compile(r"\w+")
_HAN_RUN = re.compile(r"[㐀-䶿一-鿿豈-﫿]+")


@dataclass
class CheckResult:
    text: str                                         # bản dịch sau khi tự sửa
    fixes: list[dict] = field(default_factory=list)   # {found, expected, count}
    issues: list[dict] = field(default_factory=list)  # {kind, zh?, expected?, found?, detail}

    @property
    def fixed_count(self) -> int:
        return sum(f["count"] for f in self.fixes)


def present_terms(raw: str, profile: NovelProfile) -> list:
    """Tên trong bảng thật sự xuất hiện trong bản gốc (không tính lần nằm trong tên dài hơn)."""
    terms = sorted((t for t in profile.all_terms() if t.zh and t.vi and is_name_like(t.vi)),
                   key=lambda t: len(t.zh), reverse=True)
    masked, out = raw, []
    for t in terms:
        if t.zh in masked:
            out.append(t)
            masked = masked.replace(t.zh, "\x00")
    return out


def _runs(text: str) -> list[list[re.Match]]:
    """Các cụm từ viết hoa liền nhau (cách nhau đúng khoảng trắng)."""
    runs: list[list[re.Match]] = []
    cur: list[re.Match] = []
    for m in _WORD.finditer(text):
        w = m.group(0)
        if w[:1].isupper() and not w.isdigit():
            if cur and text[cur[-1].end():m.start()].strip(" ") == "" and \
                    0 < m.start() - cur[-1].end() <= 2:
                cur.append(m)
            else:
                if cur:
                    runs.append(cur)
                cur = [m]
        else:
            if cur:
                runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    return runs


def check_and_fix(raw: str, translated: str, profile: NovelProfile) -> CheckResult:
    res = CheckResult(text=translated)
    present = present_terms(raw, profile)
    canon = {t.vi for t in present}
    by_fold: dict[str, set[str]] = {}
    for vi in canon:
        by_fold.setdefault(fold(vi), set()).add(vi)
    lengths = sorted({len(syllables(v)) for v in canon}, reverse=True)

    # 1. Biến thể → sửa (thay từ cuối lên để vị trí không lệch).
    edits: list[tuple[int, int, str, str]] = []
    for run in _runs(translated):
        i = 0
        while i < len(run):
            hit = None
            for n in lengths:
                if i + n > len(run):
                    continue
                start, end = run[i].start(), run[i + n - 1].end()
                found = translated[start:end]
                if found in canon:
                    hit = (n, None)
                    break
                cands = by_fold.get(fold(" ".join(m.group(0) for m in run[i:i + n])))
                if cands:
                    hit = (n, (start, end, found, cands))
                    break
            if hit is None:
                i += 1
                continue
            n, info = hit
            if info:
                start, end, found, cands = info
                if len(cands) == 1:
                    edits.append((start, end, found, next(iter(cands))))
                else:
                    res.issues.append({"kind": "ambiguous", "found": found,
                                       "detail": f"«{found}» gần với nhiều tên: {', '.join(sorted(cands))}"})
            i += n
    text = translated
    counts: dict[tuple[str, str], int] = {}
    for start, end, found, expected in sorted(edits, reverse=True):
        text = text[:start] + expected + text[end:]
        counts[(found, expected)] = counts.get((found, expected), 0) + 1
    res.text = text
    res.fixes = [{"found": f, "expected": e, "count": c} for (f, e), c in sorted(counts.items())]

    # 1b. Tên ≥3 âm tiết không có dạng chuẩn nhưng có đúng MỘT cụm viết hoa khác đúng một
    # âm (vd "Bùi Thiên Cang" ↔ "Bùi Thiên Cương"), cụm đó không phải tên nào trong bảng →
    # coi là cùng người, sửa. Tên 2 âm tiết chỉ báo (dễ nhầm người cùng họ).
    all_vi = {t.vi for t in profile.all_terms() if t.vi}
    for t in present:
        target = syllables(t.vi)
        n = len(target)
        if n < 3 or re.search(rf"(?<!\w){re.escape(t.vi)}(?!\w)", text, re.IGNORECASE):
            continue
        cands: set[str] = set()
        for run in _runs(text):
            for i in range(len(run) - n + 1):
                words = [m.group(0) for m in run[i:i + n]]
                phrase = " ".join(words)
                if phrase in all_vi or any(v in phrase for v in canon):
                    continue
                same = sum(fold(a) == fold(b) for a, b in zip(words, target))
                # Âm tiết đầu (họ / chữ đầu tên) phải trùng: "Hứa Tư Lê" không phải "Tiêu Tứ Lê".
                if same == n - 1 and fold(words[0]) == fold(target[0]):
                    cands.add(phrase)
        if len(cands) == 1:
            found = next(iter(cands))
            text, k = re.subn(rf"(?<!\w){re.escape(found)}(?!\w)", t.vi, text)
            if k:
                res.fixes.append({"found": found, "expected": t.vi, "count": k})
    res.text = text

    # 2. Tên có trong bản gốc mà bản dịch không có tên chuẩn.
    for t in present:
        # Không phân biệt hoa thường: vật phẩm như "ngọc giản" viết thường vẫn là đúng tên.
        if not re.search(rf"(?<!\w){re.escape(t.vi)}(?!\w)", text, re.IGNORECASE):
            res.issues.append({"kind": "missing", "zh": t.zh, "expected": t.vi,
                               "detail": f"{t.zh} → bản dịch không có «{t.vi}»"})

    # 3. Còn chữ Hán.
    if has_han(text):
        sample = "、".join(dict.fromkeys(_HAN_RUN.findall(text)))[:60]
        res.issues.append({"kind": "han", "detail": f"Bản dịch còn chữ Hán: {sample}"})
    return res


def _write_atomic(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(text.encode("utf-8"))
    os.replace(tmp, path)


async def check_chapter_file(state, chapter: dict, source_path: Path,
                             profile: NovelProfile) -> CheckResult | None:
    """Kiểm + tự sửa file bản dịch của một chương, lưu kết quả vào DB.

    Không có file bản dịch hoặc file nguồn (vd chương OCR chưa có .txt) → None.
    Dòng tiêu đề "# …" được sửa cùng các thay thế của phần thân.
    """
    out_path = Path(chapter.get("translated_path") or "")
    if not chapter.get("translated_path") or not out_path.is_file() or not source_path.is_file():
        return None
    raw = source_path.read_text(encoding="utf-8")
    text = out_path.read_text(encoding="utf-8")
    head, body = "", text
    if text.startswith("# ") and "\n\n" in text:
        head, body = text.split("\n\n", 1)
        head += "\n\n"
    res = check_and_fix(raw, body, profile)
    new_head = head
    for f in res.fixes:
        new_head = re.sub(rf"(?<!\w){re.escape(f['found'])}(?!\w)", f["expected"], new_head)
    if res.text != body or new_head != head:
        _write_atomic(out_path, new_head + res.text)
    await state.save_name_check(chapter["filename"], chapter.get("novel_slug") or "",
                                res.fixes, res.issues)
    return res
