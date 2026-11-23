"""Tạo dữ liệu mẫu để kiểm giao diện VietPhase (màn đọc, danh sách chương...).

Ghi TOÀN BỘ vào một thư mục tạm (--root), không đụng dữ liệu thật:

    <root>/input/        chương gốc tiếng Trung (第N章 ….txt)
    <root>/output/<slug> bản dịch (Chuong_000N_….txt)
    <root>/rules/<slug>  novel.md
    <root>/db/state.db   SQLite (trạng thái chương)

Truyện A (truyen-mau-a): 5 chương, chương 1/2/3/5 đã dịch (done), chương 4 chưa.
Truyện B (truyen-mau-b): 2 chương, chương 1 đã dịch.
Bản dịch có đoạn chỉ xuống dòng đơn và một dòng dài không khoảng trắng (URL, chữ Hán)
để kiểm tách đoạn và cuộn ngang ở màn hẹp.

Cách dùng (chạy trong qidian-vietphase/):

    uv run python scripts/seed_ux_demo.py --root /tmp/vp-ux
    uv run python scripts/seed_ux_demo.py --root /tmp/vp-ux --mark-done 4
    uv run python scripts/seed_ux_demo.py --root /tmp/vp-ux --unmark 3 --novel b

Script in ra các biến môi trường để chạy uvicorn trên dữ liệu mẫu. Không commit dữ
liệu sinh ra.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent      # qidian-vietphase/
REPO_DIR = APP_DIR.parent                              # gốc repo
MARKER = ".vp-ux-demo"                                 # đánh dấu thư mục do script tạo

# Biến cấu hình đường dẫn của backend/config.py
PATH_VARS = ("INPUT_DIR", "OUTPUT_DIR", "OCR_IMAGES_DIR", "VIETPHASE_DIR", "RULES_DIR", "DB_PATH")

NOVELS = {
    "a": {
        "slug": "truyen-mau-a",
        "zh_name": "示例小说甲",
        "vi_name": "Truyện mẫu A — Kiếm Khách Sơn Môn",
        "chapters": {
            1: ("初入山门", "Lần đầu vào sơn môn"),
            2: ("拜师学艺", "Bái sư học nghệ"),
            3: ("夜半惊雷", "Sấm động nửa đêm"),
            4: ("秘境开启", "Bí cảnh mở ra"),
            5: ("剑气纵横", "Kiếm khí tung hoành"),
        },
        "done": {1, 2, 3, 5},
    },
    "b": {
        "slug": "truyen-mau-b",
        "zh_name": "示例小说乙",
        "vi_name": "Truyện mẫu B — Thư Sinh Hồ Tây",
        "chapters": {
            1: ("湖畔书生", "Thư sinh bên hồ"),
            2: ("烟雨楼台", "Lâu đài trong mưa khói"),
        },
        "done": {1},
    },
}

_VI_SENTENCES = [
    "Gió núi thổi qua rừng trúc, lá xào xạc như tiếng ai thì thầm bên tai.",
    "Hắn đứng lặng trước cổng đá, nhìn bậc thang dài dẫn lên đỉnh núi mờ sương.",
    "Sư huynh áo xanh khẽ gật đầu, ánh mắt bình thản nhưng ẩn chứa vẻ dò xét.",
    "Trên quảng trường, hàng trăm đệ tử đang luyện kiếm, kiếm quang loang loáng.",
    "Nàng mỉm cười, giọng nói trong trẻo như suối chảy qua khe đá.",
    "Đêm xuống, ánh trăng bạc phủ lên mái ngói cong của Tàng Kinh Các.",
    "Lão giả vuốt chòm râu bạc, chậm rãi nói từng chữ một.",
    "Một luồng linh khí ấm áp chạy dọc kinh mạch, khiến toàn thân hắn nhẹ bẫng.",
]


def _paragraph(seed: int, n: int = 3) -> str:
    return " ".join(_VI_SENTENCES[(seed + i) % len(_VI_SENTENCES)] for i in range(n))


def _vi_content(num: int, vi_title: str) -> str:
    """Nội dung bản dịch: nhiều đoạn (đủ dài để cuộn), có đoạn xuống dòng đơn và dòng
    dài không khoảng trắng."""
    paras = [f"Chương {num}: {vi_title}."]
    for i in range(36):
        paras.append(_paragraph(num * 7 + i, 2 + (i % 3)))
        if i == 5:
            # Khối thơ/hội thoại chỉ xuống dòng đơn (không có dòng trống giữa các dòng).
            paras.append(
                "“Sư phụ, đệ tử đã hiểu.”\n"
                "“Hiểu cái gì?”\n"
                "“Kiếm ở trong tâm, không ở trong tay.”\n"
                "Lão giả cười lớn, phất tay áo bỏ đi."
            )
        if i == 12:
            # Dòng dài không khoảng trắng: URL và chuỗi chữ Hán liền nhau.
            paras.append(
                "Nguồn:https://example.invalid/truyen/kiem-khach-son-mon/chuong-"
                f"{num:04d}/doan-van-rat-dai-khong-co-khoang-trang-nao-ca-de-kiem-tra-xuong-dong"
                "?tham-so=gia-tri-rat-dai-de-kiem-tra-tran-ngang-tren-man-hinh-hep"
            )
            paras.append("剑" * 40 + "气纵横三万里一剑光寒十九洲" * 4)
    return "\n\n".join(paras)


def _zh_content(num: int, zh_title: str) -> str:
    lines = [f"第{num}章 {zh_title}"]
    lines += ["山风吹过竹林，竹叶沙沙作响，仿佛有人在耳边低语。" * 3 for _ in range(12)]
    return "\n\n".join(lines) + "\n"


# ── Bảo vệ dữ liệu thật ──────────────────────────────────────────────────────

def _norm(p: Path) -> Path:
    return Path(os.path.realpath(os.path.expanduser(str(p))))


def _configured_paths() -> list[Path]:
    """Đường dẫn dữ liệu đang cấu hình (env + qidian-vietphase/.env + mặc định)."""
    vals: list[str] = []
    env_file = APP_DIR / ".env"
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            if key.strip().upper() in PATH_VARS:
                vals.append(val.split("#", 1)[0].strip().strip("'\""))
    for key in PATH_VARS:
        if os.environ.get(key):
            vals.append(os.environ[key])
    out = []
    for v in vals:
        if not v:
            continue
        p = Path(v.replace("\\", "/"))
        out.append(_norm(p if p.is_absolute() else APP_DIR / p))
    return out


def _is_within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def check_root(root: Path) -> str | None:
    """Trả về lý do từ chối, hoặc None nếu được phép ghi vào root."""
    if root == Path(root.anchor) or root == _norm(Path.home()):
        return f"{root} là thư mục gốc/thư mục nhà"
    if _is_within(root, _norm(REPO_DIR)) or _is_within(_norm(REPO_DIR), root):
        return f"{root} nằm trong (hoặc chứa) repo — dùng thư mục tạm ngoài repo, vd /tmp/vp-ux"
    has_marker = (root / MARKER).is_file()
    for real in _configured_paths():
        if has_marker and _is_within(real, root):
            continue  # env đang trỏ vào chính dữ liệu mẫu (vd đã export để chạy uvicorn)
        if _is_within(root, real) or _is_within(real, root):
            return f"{root} trùng với thư mục dữ liệu đang cấu hình ({real})"
    for p in (Path("/data"), Path("/app")):           # volume Docker (docker-compose.yml)
        if _is_within(root, p) or root == p:
            return f"{root} nằm trong {p} (volume dữ liệu khi deploy)"
    return None


# ── Ghi dữ liệu ─────────────────────────────────────────────────────────────

def _paths(root: Path) -> dict[str, Path]:
    return {
        "INPUT_DIR": root / "input",
        "OUTPUT_DIR": root / "output",
        "OCR_IMAGES_DIR": root / "ocr_images",
        "VIETPHASE_DIR": root / "vietphase",
        "RULES_DIR": root / "rules",
        "DB_PATH": root / "db" / "state.db",
    }


def _zh_filename(num: int, zh_title: str) -> str:
    return f"第{num}章 {zh_title}.txt"


def _out_path(paths: dict[str, Path], slug: str, num: int, vi_title: str) -> Path:
    # Cùng quy tắc đặt tên với translator.save_chapter
    return paths["OUTPUT_DIR"] / slug / f"Chuong_{num:04d}_{vi_title}.txt"


def _open_state(paths: dict[str, Path]):
    # Đặt env trước khi import backend để mọi cấu hình đọc sau này trỏ vào root tạm.
    for k, v in paths.items():
        os.environ[k] = str(v)
    sys.path.insert(0, str(APP_DIR))
    from backend.agent.state import SharedState  # noqa: E402
    return SharedState(str(paths["DB_PATH"]))


def _mark(state, paths, novel: dict, num: int, done: bool) -> None:
    from backend.agent.state import ChapterStatus  # noqa: E402
    if num not in novel["chapters"]:
        raise SystemExit(f"Truyện {novel['slug']} không có chương {num}")
    zh_title, vi_title = novel["chapters"][num]
    filename = _zh_filename(num, zh_title)
    out = _out_path(paths, novel["slug"], num, vi_title)
    if done:
        out.parent.mkdir(parents=True, exist_ok=True)
        if not out.is_file():
            out.write_bytes(f"# {vi_title}\n\n{_vi_content(num, vi_title)}\n".encode("utf-8"))
        asyncio.run(state.set_status(
            filename, ChapterStatus.DONE, vi_title=vi_title, translated_path=str(out.resolve()),
        ))
    else:
        # Giả lập "đang dịch lại / không còn bản dịch": bỏ trạng thái done và đường dẫn
        # bản dịch trong DB, giữ file trên đĩa để --mark-done khôi phục được.
        asyncio.run(state.set_status(filename, ChapterStatus.PENDING, translated_path=None))


def seed(root: Path) -> None:
    paths = _paths(root)
    for key, p in paths.items():
        (p.parent if key == "DB_PATH" else p).mkdir(parents=True, exist_ok=True)
    (root / MARKER).write_text("Dữ liệu mẫu do scripts/seed_ux_demo.py tạo. Xoá thoải mái.\n",
                               encoding="utf-8")

    sys.path.insert(0, str(APP_DIR))
    from backend.agent.novel_loader import render_novel_template  # noqa: E402

    state = _open_state(paths)
    for novel in NOVELS.values():
        slug = novel["slug"]
        rules = paths["RULES_DIR"] / slug
        rules.mkdir(parents=True, exist_ok=True)
        (rules / "novel.md").write_text(
            render_novel_template(APP_DIR / "rules", novel["zh_name"], novel["vi_name"]),
            encoding="utf-8",
        )
        for num, (zh_title, _vi) in novel["chapters"].items():
            filename = _zh_filename(num, zh_title)
            (paths["INPUT_DIR"] / filename).write_bytes(_zh_content(num, zh_title).encode("utf-8"))
            asyncio.run(state.upsert_chapter(filename, slug, num, zh_title))
            _mark(state, paths, novel, num, num in novel["done"])
        print(f"  {slug}: {len(novel['chapters'])} chương, done = {sorted(novel['done'])}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Tạo dữ liệu mẫu VietPhase trong thư mục tạm.")
    ap.add_argument("--root", required=True, type=Path, help="thư mục tạm (ngoài repo)")
    ap.add_argument("--force", action="store_true",
                    help="cho phép ghi vào thư mục không trống chưa có dấu dữ liệu mẫu")
    ap.add_argument("--novel", default="a",
                    help="truyện áp dụng cho --mark-done/--unmark: a | b | slug (mặc định a)")
    ap.add_argument("--mark-done", type=int, action="append", default=[], metavar="N",
                    help="đánh dấu chương N đã dịch (tạo file bản dịch nếu thiếu)")
    ap.add_argument("--unmark", type=int, action="append", default=[], metavar="N",
                    help="bỏ trạng thái đã dịch của chương N (giữ file trên đĩa)")
    args = ap.parse_args()

    root = _norm(args.root)
    reason = check_root(root)
    if reason:
        print(f"Từ chối: {reason}.", file=sys.stderr)
        return 2

    has_marker = (root / MARKER).is_file()
    modify = bool(args.mark_done or args.unmark)

    if modify:
        if not has_marker:
            print(f"Từ chối: {root} chưa phải thư mục dữ liệu mẫu. "
                  f"Chạy trước: seed_ux_demo.py --root {root}", file=sys.stderr)
            return 2
        key = args.novel.lower()
        novel = NOVELS.get(key) or next((n for n in NOVELS.values() if n["slug"] == args.novel), None)
        if not novel:
            print(f"Không có truyện '{args.novel}' (dùng a, b hoặc slug).", file=sys.stderr)
            return 2
        paths = _paths(root)
        state = _open_state(paths)
        for n in args.mark_done:
            _mark(state, paths, novel, n, True)
            print(f"  {novel['slug']}: chương {n} → done")
        for n in args.unmark:
            _mark(state, paths, novel, n, False)
            print(f"  {novel['slug']}: chương {n} → pending")
    else:
        if root.exists() and not root.is_dir():
            print(f"Từ chối: {root} không phải thư mục.", file=sys.stderr)
            return 2
        if root.is_dir() and any(root.iterdir()) and not has_marker and not args.force:
            print(f"Từ chối: {root} không trống và không phải dữ liệu mẫu (thêm --force nếu chắc chắn).",
                  file=sys.stderr)
            return 2
        print(f"Tạo dữ liệu mẫu trong {root}")
        seed(root)

    env = " ".join(f"{k}={v}" for k, v in _paths(root).items())
    print("\nChạy server trên dữ liệu mẫu (trong qidian-vietphase/):")
    print(f"  {env} uv run uvicorn backend.main:app --port 9999")
    return 0


if __name__ == "__main__":
    sys.exit(main())
