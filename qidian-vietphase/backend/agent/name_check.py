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
import unicodedata
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


def _nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def check_and_fix(raw: str, translated: str, profile: NovelProfile) -> CheckResult:
    """Kiểm + tự sửa tên. Văn bản được chuẩn hoá NFC trước (dấu tổ hợp → dựng sẵn)."""
    raw, translated = _nfc(raw), _nfc(translated)
    res = CheckResult(text=translated)
    present = present_terms(raw, profile)
    canon = {_nfc(t.vi) for t in present}
    by_fold: dict[str, set[str]] = {}
    for vi in canon:
        by_fold.setdefault(fold(vi), set()).add(vi)
    # Tên 1 âm tiết không tự sửa: chữ đầu câu viết hoa + bỏ dấu dễ trùng từ thường
    # ("Ăn" ~ "An").
    lengths = sorted({k for k in (len(syllables(v)) for v in canon) if k >= 2}, reverse=True)

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
    res.fixes = [{"found": f, "expected": e, "count": c} for (f, e), c in sorted(counts.items())]

    # 1b. Tên ≥3 âm tiết không có dạng chuẩn nhưng có cụm viết hoa khác đúng một âm, cùng âm
    # đầu (vd "Bùi Thiên Cang" ↔ "Bùi Thiên Cương") → cùng người, sửa — chỉ khi khớp duy
    # nhất theo CẢ HAI chiều: tên đích có đúng một cụm ứng viên, và cụm đó không gần tên
    # nào khác trong bảng. Tên 2 âm tiết chỉ báo (dễ nhầm người cùng họ).
    all_names = {_nfc(t.vi) for t in profile.all_terms() if t.vi and is_name_like(t.vi)}

    def near(words: list[str], target: list[str]) -> bool:
        same = sum(fold(a) == fold(b) for a, b in zip(words, target))
        # Âm đầu (họ / chữ đầu tên) phải trùng: "Hứa Tư Lê" không phải "Tiêu Tứ Lê".
        return len(words) == len(target) and same == len(target) - 1 and fold(words[0]) == fold(target[0])

    def has(vi: str, body: str) -> bool:
        return bool(re.search(rf"(?<!\w){re.escape(vi)}(?!\w)", body, re.IGNORECASE))

    def name_spans(body: str) -> list[tuple[int, int]]:
        # Vị trí đang là đúng một tên chuẩn trong bảng (vd "Bùi Thiên Cang Sơn"): không lấy
        # cụm con của nó làm ứng viên, không thay bên trong nó.
        return [(m.start(), m.end()) for v in all_names
                for m in re.finditer(rf"(?<!\w){re.escape(v)}(?!\w)", body)]

    def inside(a: int, b: int, spans: list[tuple[int, int]]) -> bool:
        return any(a < e and s < b for s, e in spans)

    targets = [_nfc(t.vi) for t in present
               if len(syllables(t.vi)) >= 3 and not has(_nfc(t.vi), text)]
    runs = _runs(text)
    spans = name_spans(text)
    cand_of: dict[str, set[str]] = {}
    for vi in targets:
        tgt = syllables(vi)
        n = len(tgt)
        for run in runs:
            for i in range(len(run) - n + 1):
                words = [m.group(0) for m in run[i:i + n]]
                phrase = " ".join(words)
                if phrase in all_names or inside(run[i].start(), run[i + n - 1].end(), spans):
                    continue
                if near(words, tgt):
                    cand_of.setdefault(vi, set()).add(phrase)
    for vi, cands in cand_of.items():
        if len(cands) != 1:
            continue
        found = next(iter(cands))
        fw = syllables(found)
        if sum(near(fw, syllables(other)) for other in all_names) != 1:
            res.issues.append({"kind": "ambiguous", "found": found,
                               "detail": f"«{found}» gần nhiều tên trong bảng, không tự sửa"})
            continue
        protect = name_spans(text)
        k = 0

        def sub(m: re.Match, vi: str = vi) -> str:
            nonlocal k
            if inside(m.start(), m.end(), protect):
                return m.group(0)
            k += 1
            return vi
        text = re.sub(rf"(?<!\w){re.escape(found)}(?!\w)", sub, text)
        if k:
            res.fixes.append({"found": found, "expected": vi, "count": k})
    res.text = text

    # 2. Tên có trong bản gốc mà bản dịch không có tên chuẩn.
    for t in present:
        # Không phân biệt hoa thường: vật phẩm như "ngọc giản" viết thường vẫn là đúng tên.
        if not has(_nfc(t.vi), text):
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
    """Kiểm + tự sửa cả file bản dịch (kể cả dòng tiêu đề "# …"), lưu kết quả vào DB.

    Không có file bản dịch hoặc file nguồn (vd chương OCR chưa có .txt) → None.
    """
    out_path = Path(chapter.get("translated_path") or "")
    if not chapter.get("translated_path") or not out_path.is_file() or not source_path.is_file():
        return None
    raw = source_path.read_text(encoding="utf-8")
    text = out_path.read_text(encoding="utf-8")
    res = check_and_fix(raw, text, profile)
    if res.text != text:
        _write_atomic(out_path, res.text)
    await state.save_name_check(chapter["filename"], chapter.get("novel_slug") or "",
                                res.fixes, res.issues)
    return res
