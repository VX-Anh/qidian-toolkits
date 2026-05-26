import re

from .novel_loader import NovelProfile


def replace_proper_nouns(text: str, profile: NovelProfile) -> tuple[str, list[tuple[str, str]]]:
    """Replace known zh proper nouns with vi equivalents before translation.

    Sorts by length descending so longer terms (天演境) are replaced before
    shorter substrings (天演). Uses null-byte markers to prevent cascading
    replacements when one vi term contains characters from another zh term.
    """
    terms = sorted(
        [t for t in profile.all_terms() if t.zh and t.vi],
        key=lambda t: len(t.zh),
        reverse=True,
    )

    markers: dict[str, str] = {}
    substitutions: list[tuple[str, str]] = []

    for i, term in enumerate(terms):
        if term.zh in text:
            marker = f"\x00T{i}\x00"
            text = text.replace(term.zh, marker)
            markers[marker] = term.vi
            substitutions.append((term.zh, term.vi))

    for marker, vi in markers.items():
        text = text.replace(marker, vi)

    return text, substitutions


def build_segments(text: str, profile: NovelProfile) -> tuple[list[dict], int]:
    """Break text into plain-text and term segments for highlight display.

    Returns (segments, substitution_count).
    Each segment: {"type": "text", "content": str}
                  {"type": "term",  "zh": str, "vi": str}
    """
    terms = sorted(
        [t for t in profile.all_terms() if t.zh and t.vi],
        key=lambda t: len(t.zh),
        reverse=True,
    )
    markers: dict[str, tuple[str, str]] = {}

    for i, term in enumerate(terms):
        if term.zh in text:
            marker = f"\x00S{i}\x00"
            text = text.replace(term.zh, marker)
            markers[marker] = (term.zh, term.vi)

    parts = re.split(r'(\x00S\d+\x00)', text)
    segments: list[dict] = []
    for part in parts:
        if part.startswith('\x00S') and part.endswith('\x00') and part in markers:
            zh, vi = markers[part]
            segments.append({"type": "term", "zh": zh, "vi": vi})
        elif part:
            segments.append({"type": "text", "content": part})

    return segments, len(markers)
