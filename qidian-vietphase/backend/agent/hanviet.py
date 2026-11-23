"""Âm Hán-Việt tất định cho tên riêng, theo từng truyện.

Mục tiêu: cùng một chữ Hán thì luôn ra cùng một âm Việt trong một truyện (蔡 luôn
"Thái", không lúc "Thái" lúc "Sái"). Không có bộ dữ liệu mở đủ tốt cho âm Hán-Việt
(Unihan kVietnamese là âm Nôm: 司 → "ti"), nên âm được học từ chính truyện:

1. Mục "## Âm Hán-Việt" trong novel.md (chữ → âm): ghi khi một chữ được chốt lần đầu
   hoặc do người dùng sửa — ưu tiên cao nhất, chữ đó chỉ có đúng một âm.
2. Học từ bảng thuật ngữ: tên viết hoa mà số âm tiết bằng số chữ Hán → ghép từng cặp
   chữ–âm. Khi phiên âm tên người, ưu tiên âm học từ tên người (mục Nhân vật), và với
   chữ đầu tên thì ưu tiên âm ở vị trí họ: 司 là "Tư" trong 司奇 (họ) nhưng "Ty" trong
   chức danh 执司.

Chữ đa âm đã dùng nhiều âm trong truyện thì mọi âm đó đều hợp lệ (không ép); xung đột
được liệt kê để người dùng chốt trong mục Âm Hán-Việt.
Chữ chưa có âm: model chọn khi dò tên (name_scout), rồi âm đó được ghi vào mục (1).
"""
from __future__ import annotations

import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field

READINGS_SECTION = "Âm Hán-Việt"

_HAN = re.compile(r"[㐀-䶿一-鿿豈-﫿]")


def is_han(ch: str) -> bool:
    return bool(_HAN.fullmatch(ch))


def has_han(text: str) -> bool:
    return bool(_HAN.search(text))


def syllables(vi: str) -> list[str]:
    """Tách tên Việt thành âm tiết (bỏ dấu gạch nối, khoảng trắng thừa)."""
    return [s for s in re.split(r"[\s\-]+", vi.strip()) if s]


def norm_syllable(s: str) -> str:
    """Âm tiết chuẩn hoá để so khớp: thường, NFC."""
    return unicodedata.normalize("NFC", s.strip().lower())


def fold(s: str) -> str:
    """Bỏ dấu + đ→d + y→i, thường: so khớp "gần như cùng tên" (Kì/Kỳ, Ky/Kỳ)."""
    s = unicodedata.normalize("NFD", s.lower().replace("đ", "d"))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s.replace("y", "i")


def title_syllable(s: str) -> str:
    return s[:1].upper() + s[1:] if s else s


def is_name_like(vi: str) -> bool:
    """Tên riêng: mọi âm tiết viết hoa (loại dòng kiểu "truyền chiến lực")."""
    sy = syllables(vi)
    return bool(sy) and all(s[:1].isupper() for s in sy)


def _pairs(zh: str, vi: str) -> list[tuple[str, str]] | None:
    """[(chữ, âm tiết gốc)] nếu số âm tiết bằng số chữ Hán và toàn chữ Hán."""
    chars, sy = list(zh.strip()), syllables(vi)
    if not chars or len(chars) != len(sy) or not all(is_han(c) for c in chars):
        return None
    return list(zip(chars, sy))


def _best(c: Counter | None) -> str | None:
    # Nhiều nhất; hoà thì âm gặp trước trong bảng (Counter giữ thứ tự chèn).
    return max(c.items(), key=lambda kv: kv[1])[0] if c else None


@dataclass
class ReadingTable:
    """Âm Hán-Việt của một truyện."""
    explicit: dict[str, str] = field(default_factory=dict)    # mục "Âm Hán-Việt"
    learned: dict[str, Counter] = field(default_factory=dict)  # mọi tên trong bảng
    person: dict[str, Counter] = field(default_factory=dict)   # chỉ tên người
    surname: dict[str, Counter] = field(default_factory=dict)  # chữ đầu tên người

    def reading(self, ch: str, person: bool = False, first: bool = False) -> str | None:
        if ch in self.explicit:
            return self.explicit[ch]
        if person and first and ch in self.surname:
            return _best(self.surname[ch])
        if person and ch in self.person:
            return _best(self.person[ch])
        return _best(self.learned.get(ch))

    def candidates(self, ch: str) -> set[str]:
        """Các âm hợp lệ: chỉ âm đã chốt nếu có, ngược lại mọi âm đã học."""
        if ch in self.explicit:
            return {self.explicit[ch]}
        return set(self.learned.get(ch, ()))

    def conflicts(self) -> dict[str, list[str]]:
        """Chữ học ra nhiều âm khác nhau mà chưa chốt trong mục Âm Hán-Việt."""
        return {ch: sorted(c) for ch, c in self.learned.items()
                if len(c) > 1 and ch not in self.explicit}

    def transliterate(self, zh: str, person: bool = True) -> tuple[str | None, list[str]]:
        """Phiên âm cả tên: (tên viết hoa từng âm, các chữ chưa biết âm).

        Tên chứa ký tự không phải chữ Hán → (None, []).
        """
        chars = list(zh.strip())
        if not chars or not all(is_han(c) for c in chars):
            return None, []
        out, unknown = [], []
        for i, c in enumerate(chars):
            r = self.reading(c, person, first=i == 0)
            if r is None:
                unknown.append(c)
            else:
                out.append(title_syllable(r))
        return (None, unknown) if unknown else (" ".join(out), [])

    def enforce(self, zh: str, vi: str, strict: bool = True) -> tuple[str, dict[str, str]]:
        """Ép tên Việt theo âm đã biết; trả (tên đã ép, âm MỚI cần ghi vào mục Âm Hán-Việt).

        Chỉ áp cho tên phiên âm từng chữ (số âm tiết = số chữ Hán); tên dịch nghĩa giữ
        nguyên. Âm model chọn được giữ nếu là một âm đã dùng của chữ đa âm.
        strict=True (tên người): âm khác hẳn bị thay bằng âm đã biết; chữ mới được học.
        strict=False (địa danh, kỹ năng… có thể dịch nghĩa): chỉ sửa biến thể của cùng
        âm (Kì → Kỳ), không thay âm khác hẳn, không học chữ mới.
        """
        pairs = _pairs(zh, vi)
        if pairs is None:
            return vi, {}
        out: list[str] = []
        new: dict[str, str] = {}
        for i, (c, s) in enumerate(pairs):
            ns = norm_syllable(s)
            known = new.get(c) or self.reading(c, person=strict, first=i == 0)
            if known is None:
                if strict:
                    new[c] = ns
                out.append(s)
                continue
            if ns in self.candidates(c) and not (strict and i == 0 and c in self.surname):
                chosen = ns   # âm đã dùng của chữ đa âm (họ thì luôn theo âm họ đã học)
            elif strict or fold(known) == fold(s):
                chosen = known
            else:
                out.append(s)
                continue
            out.append(title_syllable(chosen) if s[:1].isupper() else chosen)
        return " ".join(out), new


def build_table(terms, explicit: dict[str, str] | None = None,
                person_terms=()) -> ReadingTable:
    """terms: mọi Term (.zh/.vi); person_terms: các Term thuộc mục Nhân vật."""
    t = ReadingTable(explicit=dict(explicit or {}))
    person_ids = {id(x) for x in person_terms}
    for term in terms:
        if not term.zh or not term.vi or not is_name_like(term.vi):
            continue
        pairs = _pairs(term.zh, term.vi)
        if pairs is None:
            continue
        for i, (c, s) in enumerate(pairs):
            r = norm_syllable(s)
            t.learned.setdefault(c, Counter())[r] += 1
            if id(term) in person_ids:
                t.person.setdefault(c, Counter())[r] += 1
                if i == 0:
                    t.surname.setdefault(c, Counter())[r] += 1
    return t


def parse_readings_section(block: str) -> dict[str, str]:
    """Bảng | 蔡 | thái | ghi chú | → {chữ: âm thường}. Chỉ nhận đúng 1 chữ Hán, 1 âm."""
    out: dict[str, str] = {}
    for line in block.splitlines():
        line = line.strip()
        if not line.startswith("|") or "---" in line:
            continue
        cols = [c.strip() for c in line.strip("|").split("|")]
        if len(cols) >= 2 and len(cols[0]) == 1 and is_han(cols[0]):
            sy = syllables(cols[1])
            if len(sy) == 1:
                out[cols[0]] = norm_syllable(sy[0])
    return out
