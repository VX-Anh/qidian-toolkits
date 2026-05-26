import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml


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

    def all_terms(self) -> list[Term]:
        return self.characters + self.places + self.realms + self.skills

    def glossary_block(self) -> str:
        sections = [
            ("Nhân vật", self.characters),
            ("Địa danh", self.places),
            ("Cảnh giới", self.realms),
            ("Kỹ năng / Pháp thuật", self.skills),
        ]
        lines = ["=== BẢNG THUẬT NGỮ (BẮT BUỘC TUÂN THEO) ==="]
        for title, terms in sections:
            if not terms:
                continue
            lines.append(f"\n[{title}]")
            for t in terms:
                note = f" — {t.notes}" if t.notes else ""
                lines.append(f"  {t.zh} → {t.vi}{note}")
        return "\n".join(lines)

    def system_prompt(self) -> str:
        parts = [self.custom_prompt.strip()]
        if self.extra_notes.strip():
            parts.append(f"\n[Ghi chú về truyện]\n{self.extra_notes.strip()}")
        parts.append(f"\n{self.glossary_block()}")
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
    )


def list_novels(rules_dir: Path) -> list[str]:
    if not rules_dir.exists():
        return []
    return [
        d.name
        for d in rules_dir.iterdir()
        if d.is_dir() and not d.name.startswith("_") and (d / "novel.md").exists()
    ]


def append_terms_to_novel(rules_dir: Path, slug: str, new_terms: list[dict]):
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

    path.write_text(content, encoding="utf-8")


def _default_prompt() -> str:
    return (
        "Bạn là dịch giả tiểu thuyết tiên hiệp/võ hiệp Trung-Việt chuyên nghiệp. "
        "Dịch sang tiếng Việt tự nhiên, trang trọng, ưu tiên từ Hán Việt cho thuật ngữ tu luyện. "
        "Giữ nguyên cấu trúc đoạn văn. Không thêm bình luận hay giải thích. "
        "Tên riêng phải dịch đúng theo bảng thuật ngữ bên dưới."
    )
