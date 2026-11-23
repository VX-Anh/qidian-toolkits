"""Kiểm tra slug / tên file từ client trước khi ghép vào đường dẫn.

Mọi giá trị do client gửi (path param, query, form, body JSON) mà sẽ được ghép vào
đường dẫn trên đĩa đều phải đi qua đây — chặn path traversal kiểu `../../x`,
đường dẫn tuyệt đối, hay `..\\x` trên Windows.
"""
import re
from pathlib import Path

from fastapi import HTTPException, Request

# Slug truyện: chữ/số (kể cả Unicode, vì slug có thể lấy từ tên folder), '-', '_', '.',
# không bắt đầu bằng '.'
_SLUG_RE = re.compile(r"^\w[\w.-]{0,127}$")
# Ký tự cấm trong một tên file đơn (một thành phần đường dẫn)
_BAD_NAME_CHARS = set('/\\\x00:')

# Tên tham số path/query được tự kiểm qua dependency check_request_params
_SLUG_PARAMS = {"slug", "novel_slug"}
_NAME_PARAMS = {"filename", "job_id"}


def check_slug(slug: str) -> str:
    if not isinstance(slug, str) or not _SLUG_RE.match(slug) or ".." in slug:
        raise HTTPException(400, f"Slug không hợp lệ: {slug!r}")
    return slug


def check_name(name: str) -> str:
    """Một tên file/thư mục đơn — không được chứa dấu phân cách hay '..'."""
    if (
        not isinstance(name, str)
        or not name
        or name in (".", "..")
        or any(c in _BAD_NAME_CHARS for c in name)
        or len(name) > 255
    ):
        raise HTTPException(400, f"Tên file không hợp lệ: {name!r}")
    return name


def safe_child(base: Path, *parts: str) -> Path:
    """Ghép base/parts rồi đảm bảo kết quả vẫn nằm trong base."""
    root = Path(base).resolve()
    p = root.joinpath(*parts).resolve()
    if p != root and not p.is_relative_to(root):
        raise HTTPException(400, "Đường dẫn không hợp lệ")
    return p


async def check_request_params(request: Request) -> None:
    """Dependency gắn ở mức router: kiểm mọi path/query param tên slug/filename/job_id."""
    params = {**request.query_params, **request.path_params}
    for key, val in params.items():
        if val == "" and key in request.query_params:
            continue  # query rỗng (vd ?novel_slug=) = không lọc, không ghép path
        if key in _SLUG_PARAMS:
            check_slug(val)
        elif key in _NAME_PARAMS:
            check_name(val)
