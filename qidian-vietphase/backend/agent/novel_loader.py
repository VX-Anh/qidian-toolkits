import os
import threading
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .hanviet import READINGS_SECTION, ReadingTable, build_table, parse_readings_section


@dataclass
class Term:
    zh: str
    vi: str
    notes: str = ""


@dataclass
class NovelProfile:
    slug: str
    zh_name: str
    vi_name: str
    genre: str
    style: str
    custom_prompt: str
    characters: list[Term] = field(default_factory=list)
    places: list[Term] = field(default_factory=list)
    realms: list[Term] = field(default_factory=list)
    skills: list[Term] = field(default_factory=list)
    extra_notes: str = ""
    # Mục "## Âm Hán-Việt": chữ → âm đã chốt (xem hanviet.py).
    readings: dict[str, str] = field(default_factory=dict)

    def all_terms(self) -> list[Term]:
        return self.characters + self.places + self.realms + self.skills

    def reading_table(self) -> ReadingTable:
        return build_table(self.all_terms(), self.readings, person_terms=self.characters)

    def glossary_block(self, only_in: str | None = None) -> str:
        """Bảng thuật ngữ cho prompt. only_in: chỉ giữ mục có chữ Hán xuất hiện trong văn
        bản này (bản gốc của chương) — đỡ nhiễu khi bảng lớn."""
        sections = [
            ("Nhân vật", self.characters),
            ("Địa danh", self.places),
            ("Cảnh giới", self.realms),
            ("Kỹ năng / Pháp thuật", self.skills),
        ]
        lines = ["=== BẢNG THUẬT NGỮ (BẮT BUỘC TUÂN THEO) ==="]
        for title, terms in sections:
            if only_in is not None:
                terms = [t for t in terms if t.zh and t.zh in only_in]
            if not terms:
                continue
            lines.append(f"\n[{title}]")
            for t in terms:
                note = f" — {t.notes}" if t.notes else ""
                lines.append(f"  {t.zh} → {t.vi}{note}")
        return "\n".join(lines)

    def system_prompt(self, only_in: str | None = None) -> str:
        parts = [self.custom_prompt.strip()]
        if self.extra_notes.strip():
            parts.append(f"\n[Ghi chú về truyện]\n{self.extra_notes.strip()}")
        parts.append(f"\n{self.glossary_block(only_in)}")
        return "\n\n".join(parts)

    def to_dict(self) -> dict:
        return {
            "slug": self.slug,
            "zh_name": self.zh_name,
            "vi_name": self.vi_name,
            "genre": self.genre,
            "style": self.style,
            "characters": [{"zh": t.zh, "vi": t.vi, "notes": t.notes} for t in self.characters],
            "places": [{"zh": t.zh, "vi": t.vi, "notes": t.notes} for t in self.places],
            "realms": [{"zh": t.zh, "vi": t.vi, "notes": t.notes} for t in self.realms],
            "skills": [{"zh": t.zh, "vi": t.vi, "notes": t.notes} for t in self.skills],
        }


def _parse_table(block: str) -> list[Term]:
    terms = []
    for line in block.splitlines():
        line = line.strip()
        if not line.startswith("|") or "---" in line or "Tiếng Trung" in line:
            continue
        cols = [c.strip() for c in line.strip("|").split("|")]
        if len(cols) >= 2 and cols[0]:
            terms.append(Term(
                zh=cols[0],
                vi=cols[1] if len(cols) > 1 else "",
                notes=cols[2] if len(cols) > 2 else "",
            ))
    return terms


def _split_sections(body: str) -> dict[str, str]:
    parts = re.split(r"^## (.+)$", body, flags=re.MULTILINE)
    result: dict[str, str] = {}
    for i in range(1, len(parts), 2):
        result[parts[i].strip()] = parts[i + 1].strip() if i + 1 < len(parts) else ""
    return result


def load_novel(rules_dir: Path, slug: str) -> NovelProfile:
    path = rules_dir / slug / "novel.md"
    if not path.exists():
        raise FileNotFoundError(f"novel.md not found for slug '{slug}'")

    raw = path.read_text(encoding="utf-8")

    # Parse YAML frontmatter
    fm: dict = {}
    body = raw
    fm_match = re.match(r"^---\n(.+?)\n---\s*\n", raw, re.DOTALL)
    if fm_match:
        fm = yaml.safe_load(fm_match.group(1)) or {}
        body = raw[fm_match.end():]

    sections = _split_sections(body)

    return NovelProfile(
        slug=slug,
        zh_name=fm.get("zh_name", ""),
        vi_name=fm.get("vi_name", slug),
        genre=fm.get("genre", ""),
        style=fm.get("style", ""),
        custom_prompt=sections.get("Prompt dịch", _default_prompt()),
        characters=_parse_table(sections.get("Nhân vật", "")),
        places=_parse_table(sections.get("Địa danh", "")),
        realms=_parse_table(sections.get("Cảnh giới tu luyện", "")),
        skills=_parse_table(sections.get("Kỹ năng / Pháp thuật", "")),
        extra_notes=sections.get("Ghi chú thêm", ""),
        readings=parse_readings_section(sections.get(READINGS_SECTION, "")),
    )


def list_novels(rules_dir: Path) -> list[str]:
    if not rules_dir.exists():
        return []
    return [
        d.name
        for d in rules_dir.iterdir()
        if d.is_dir() and not d.name.startswith("_") and (d / "novel.md").exists()
    ]


# Mọi read-modify-write novel.md (extractor, sửa glossary/Settings trên UI) đi qua
# lock này + ghi atomic, để hai luồng ghi cùng lúc không đè mất thay đổi của nhau
# và crash giữa chừng không để lại file hỏng.
NOVEL_MD_LOCK = threading.RLock()


def write_novel_md(path: Path, content: str) -> None:
    """Ghi atomic: ghi file tạm cùng thư mục rồi os.replace."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


def append_terms_to_novel(rules_dir: Path, slug: str, new_terms: list[dict]):
    with NOVEL_MD_LOCK:
        _append_terms_locked(rules_dir, slug, new_terms)


def _append_terms_locked(rules_dir: Path, slug: str, new_terms: list[dict]):
    """Thêm các term mới vào đúng section trong novel.md."""
    path = rules_dir / slug / "novel.md"
    if not path.exists():
        return

    content = path.read_text(encoding="utf-8")
    section_map = {
        "character": "Nhân vật",
        "place": "Địa danh",
        "realm": "Cảnh giới tu luyện",
        "skill": "Kỹ năng / Pháp thuật",
    }

    additions: dict[str, list[str]] = {}
    for term in new_terms:
        zh = term['zh']
        if f"| {zh} |" in content:
            continue
        section = section_map.get(term.get("type", "character"), "Nhân vật")
        row = f"| {zh} | {term['vi']} | {term.get('notes', '')} |"
        additions.setdefault(section, []).append(row)

    for section_title, rows in additions.items():
        marker = f"## {section_title}"
        if marker in content:
            # Insert before the next ## or EOF
            idx = content.index(marker) + len(marker)
            next_section = re.search(r"\n## ", content[idx:])
            insert_at = idx + next_section.start() if next_section else len(content)
            insertion = "\n" + "\n".join(rows)
            content = content[:insert_at] + insertion + content[insert_at:]
        else:
            content += f"\n\n{marker}\n\n| Tiếng Trung | Tiếng Việt | Ghi chú |\n|---|---|---|\n"
            content += "\n".join(rows) + "\n"

    write_novel_md(path, content)


def append_readings_to_novel(rules_dir: Path, slug: str, readings: dict[str, str],
                             note: str = "") -> None:
    """Ghi âm Hán-Việt mới (chữ chưa có trong mục) vào cuối mục "## Âm Hán-Việt"."""
    if not readings:
        return
    with NOVEL_MD_LOCK:
        path = rules_dir / slug / "novel.md"
        if not path.exists():
            return
        content = path.read_text(encoding="utf-8")
        existing = parse_readings_section(_split_sections(content).get(READINGS_SECTION, ""))
        rows = [f"| {ch} | {r} | {note} |" for ch, r in readings.items() if ch not in existing]
        if not rows:
            return
        marker = f"## {READINGS_SECTION}"
        if marker in content:
            idx = content.index(marker) + len(marker)
            nxt = re.search(r"\n## ", content[idx:])
            at = idx + nxt.start() if nxt else len(content)
            content = content[:at].rstrip("\n") + "\n" + "\n".join(rows) + "\n" + content[at:]
        else:
            content = (content.rstrip("\n") + f"\n\n{marker}\n\n"
                       "Âm Hán-Việt đã chốt cho từng chữ (tự ghi khi gặp chữ mới; sửa ở đây để đổi).\n\n"
                       "| Chữ | Âm | Ghi chú |\n|---|---|---|\n" + "\n".join(rows) + "\n")
        write_novel_md(path, content)


AUTO_NOTE = "tự động · chương"
_GLOSSARY_SECTIONS = ("Nhân vật", "Địa danh", "Cảnh giới tu luyện", "Kỹ năng / Pháp thuật")


def remove_auto_terms(rules_dir: Path, slug: str,
                      rows: list[tuple[str, str, str]]) -> list[tuple[str, str]]:
    """Gỡ các dòng thuật ngữ do bước dò tên tự thêm: khớp ĐÚNG cả chữ Hán, tên Việt và ghi
    chú như lúc thêm (bắt đầu "tự động · chương"). Dòng người dùng đã sửa bất kỳ cột nào
    không bị đụng. Trả các (zh, vi) đã gỡ."""
    want = {(zh, vi, notes.strip()) for zh, vi, notes in rows if notes.startswith(AUTO_NOTE)}
    if not want:
        return []
    with NOVEL_MD_LOCK:
        path = rules_dir / slug / "novel.md"
        if not path.exists():
            return []
        content = path.read_text(encoding="utf-8")
        removed: list[tuple[str, str]] = []
        out: list[str] = []
        section = ""
        for line in content.splitlines(keepends=True):
            m = re.match(r"^## (.+)$", line.rstrip("\r\n"))
            if m:
                section = m.group(1).strip()
            elif section in _GLOSSARY_SECTIONS and line.lstrip().startswith("|"):
                cols = [c.strip() for c in line.strip().strip("|").split("|")]
                if len(cols) == 3 and (cols[0], cols[1], cols[2]) in want:
                    removed.append((cols[0], cols[1]))
                    continue
            out.append(line)
        if removed:
            write_novel_md(path, "".join(out))
        return removed


def _default_prompt() -> str:
    return (
        "Bạn là dịch giả tiểu thuyết tiên hiệp/võ hiệp Trung-Việt chuyên nghiệp. "
        "Dịch sang tiếng Việt tự nhiên, trang trọng, ưu tiên từ Hán Việt cho thuật ngữ tu luyện. "
        "Giữ nguyên cấu trúc đoạn văn. Không thêm bình luận hay giải thích. "
        "Tên riêng phải dịch đúng theo bảng thuật ngữ bên dưới."
    )


def render_novel_template(rules_dir: Path, zh_name: str, vi_name: str,
                          genre: str = "tiên hiệp") -> str:
    """Nội dung novel.md cho truyện mới: ưu tiên rules/_template.md, không có thì
    dùng template mặc định. Giá trị frontmatter được quote kiểu JSON (hợp lệ YAML)
    để tên có dấu ':' hay '"' không làm hỏng YAML."""
    import json as _json
    tpl = Path(rules_dir) / "_template.md"
    if tpl.exists():
        return (tpl.read_text(encoding="utf-8")
                .replace("NOVEL_ZH_NAME", zh_name)
                .replace("NOVEL_VI_NAME", vi_name)
                .replace("NOVEL_GENRE", genre))
    table = "| Tiếng Trung | Tiếng Việt | Ghi chú |\n|---|---|---|\n"
    sections = ["Nhân vật", "Địa danh", "Cảnh giới tu luyện", "Kỹ năng / Pháp thuật"]
    return (
        "---\n"
        f"zh_name: {_json.dumps(zh_name, ensure_ascii=False)}\n"
        f"vi_name: {_json.dumps(vi_name, ensure_ascii=False)}\n"
        f"genre: {_json.dumps(genre, ensure_ascii=False)}\n"
        "style: trang trọng, nhiều Hán Việt, không dùng từ hiện đại\n"
        "status: đang dịch\n"
        "---\n\n"
        "## Prompt dịch\n\n"
        f"Bạn là dịch giả tiểu thuyết {genre} Trung-Việt chuyên nghiệp.\n"
        "Dịch sang tiếng Việt tự nhiên, trang trọng, ưu tiên từ Hán Việt cho thuật ngữ tu luyện.\n"
        "Giữ nguyên cấu trúc đoạn văn. Không thêm bình luận hay giải thích.\n"
        "Tên riêng phải dịch đúng theo bảng thuật ngữ bên dưới.\n"
        + "".join(f"\n## {sec}\n\n{table}" for sec in sections)
    )
