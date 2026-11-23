"""Dò tên riêng mới của một chương TRƯỚC khi dịch, chốt tên Việt và ghi vào novel.md.

Mục tiêu: lúc dịch, mọi tên riêng của chương đã có trong bảng thuật ngữ → bước thay tên
trước khi dịch (preprocessor) đưa sẵn tên Việt chuẩn vào bản gốc, model không phải tự đặt
tên. Orchestrator dò lần lượt theo thứ tự chương (tên chốt ở chương 1 đã có khi dò chương 2),
rồi mới dịch song song.

Tên Việt: model đề xuất, rồi code ép theo âm Hán-Việt đã dùng trong truyện (hanviet.py).
Chữ mới gặp lần đầu → âm model chọn được ghi vào mục "Âm Hán-Việt" để lần sau giống hệt.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import anthropic

from ..config import settings
from .cli_translator import CliUnavailable, cli_complete
from .hanviet import has_han, is_name_like, syllables, title_syllable
from .novel_loader import NovelProfile, append_readings_to_novel, append_terms_to_novel
from .rate_limiter import estimate_tokens, get_rate_limiter

KINDS = {
    "nhan_vat": "character",
    "dia_danh": "place",
    "canh_gioi": "realm",
    "ky_nang": "skill",
}
_MAX_ZH = 12

SYSTEM = """Bạn là chuyên gia tên riêng trong tiểu thuyết {genre} Trung → Việt.
Nhiệm vụ: đọc một chương tiếng Trung và liệt kê MỌI danh từ riêng CHƯA có trong danh sách
"đã có": tên người, biệt danh, cách xưng hô gắn với tên (vd 司师兄, 奇哥), tông môn, địa danh,
cảnh giới tu luyện, công pháp, pháp bảo, đan dược, chức danh riêng.

Quy tắc tên Việt:
- Tên người, biệt danh: phiên âm Hán-Việt từng chữ, viết hoa mỗi âm tiết (陈庆 → Trần Khánh).
- Địa danh, tông môn, công pháp, pháp bảo, cảnh giới: Hán-Việt, viết hoa mỗi âm tiết
  (天演宗 → Thiên Diễn Tông, 元神境 → Nguyên Thần Cảnh).
- Giữ đúng âm Hán-Việt đã dùng trong bảng âm được cung cấp.
- KHÔNG liệt kê từ thông thường, đại từ, số đếm, từ chỉ thời gian; KHÔNG liệt kê một chữ Hán đơn lẻ.
- Chữ Hán phải chép đúng y như trong chương.

Trả lời ĐÚNG định dạng, không viết gì ngoài thẻ:
<ten_rieng>
chữ Hán | loại | tên Việt | ghi chú ngắn
</ten_rieng>
loại là một trong: nhan_vat, dia_danh, canh_gioi, ky_nang. Không có tên mới thì để trống khối."""


@dataclass(frozen=True)
class NewName:
    zh: str
    kind: str        # character | place | realm | skill
    vi: str
    notes: str


def build_prompt(raw: str, profile: NovelProfile) -> str:
    known = sorted({t.zh for t in profile.all_terms() if t.zh and t.zh in raw}, key=len, reverse=True)
    table = profile.reading_table()
    chars = sorted({c for c in raw if has_han(c)})
    hints = [f"{c}={table.reading(c)}" for c in chars if table.reading(c)]
    return "\n".join([
        "Danh sách đã có (bỏ qua các tên này): " + ("、".join(known) if known else "(trống)"),
        "",
        "Bảng âm Hán-Việt đã dùng trong truyện (chữ=âm): " + (" ".join(hints) if hints else "(trống)"),
        "",
        "Chương:",
        raw.strip(),
    ])


def parse_names(text: str) -> list[tuple[str, str, str, str]]:
    m = re.search(r"<ten_rieng>(.*?)</ten_rieng>", text, re.S)
    out = []
    for line in (m.group(1) if m else "").splitlines():
        cols = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cols) >= 3:
            out.append((cols[0], cols[1].lower(), cols[2], cols[3] if len(cols) > 3 else ""))
    return out


def normalize(raw: str, profile: NovelProfile, items, chapter_num: int) -> tuple[list[NewName], dict[str, str]]:
    """Lọc + ép âm. Trả (tên mới, âm mới cần ghi). Tên xử lý tuần tự: âm chốt cho tên
    trước áp luôn cho tên sau trong cùng chương."""
    table = profile.reading_table()
    known = {t.zh for t in profile.all_terms()}
    names: list[NewName] = []
    new_readings: dict[str, str] = {}
    seen: set[str] = set()
    for zh, kind_raw, vi, notes in items:
        zh = zh.strip()
        kind = KINDS.get(kind_raw.replace(" ", "_"))
        if (not kind or not zh or zh in known or zh in seen or len(zh) < 2 or len(zh) > _MAX_ZH
                or not all(has_han(c) for c in zh) or zh not in raw):
            continue   # sai loại, đã có, chữ đơn, không phải toàn chữ Hán, hoặc không có trong chương
        vi = " ".join(title_syllable(s) for s in syllables(vi))
        if not vi or not is_name_like(vi) or has_han(vi):
            continue
        vi, learned = table.enforce(zh, vi, strict=(kind == "character"))
        for c, r in learned.items():
            table.explicit[c] = r      # áp cho các tên sau trong chương
            new_readings[c] = r
        seen.add(zh)
        note = f"tự động · chương {chapter_num}" + (f" · {notes[:120]}" if notes else "")
        names.append(NewName(zh, kind, vi, note.replace("|", "/")))
    return names, new_readings


async def _ask(system: str, prompt: str, client: anthropic.AsyncAnthropic | None) -> str:
    model = settings.scout_model or settings.llm_model
    if settings.translate_provider.strip().lower() == "cli":
        try:
            return await cli_complete(system, prompt, model)
        except CliUnavailable:
            if not settings.cli_fallback_api or client is None:
                raise
    if client is None:
        raise RuntimeError("Không có Claude API client cho bước dò tên")
    await get_rate_limiter().acquire(estimate_tokens([{"role": "user", "content": prompt}]))
    resp = await client.messages.create(
        model=model, max_tokens=4000, system=system,
        messages=[{"role": "user", "content": prompt}],
    )
    return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")


async def scout_chapter(raw: str, profile: NovelProfile, rules_dir: Path, slug: str,
                        chapter_num: int, client: anthropic.AsyncAnthropic | None) -> list[NewName]:
    """Dò + ghi tên mới của một chương vào novel.md. Trả các tên đã thêm."""
    system = SYSTEM.format(genre=profile.genre or "tiên hiệp")
    reply = await _ask(system, build_prompt(raw, profile), client)
    names, readings = normalize(raw, profile, parse_names(reply), chapter_num)
    if names:
        append_terms_to_novel(rules_dir, slug, [
            {"zh": n.zh, "vi": n.vi, "type": n.kind, "notes": n.notes} for n in names])
    if readings:
        append_readings_to_novel(rules_dir, slug, readings, f"tự động · chương {chapter_num}")
    return names
