"""ToolRegistry — khai báo tool cho Claude từ type hint của hàm Python.

Mỗi agent dựng registry riêng qua closure (giữ trạng thái chương mà không cần global).
Tool được khai báo `eager_input_streaming` (input stream ra ngay khi model viết), nên
server không validate input → `validate()` kiểm lại trước khi chạy tool.
"""
import asyncio
import json
from dataclasses import dataclass
from typing import Any, Callable, Optional, get_type_hints


@dataclass
class ToolResult:
    tool_name: str
    success: bool
    data: Any
    error: Optional[str] = None

    def to_content(self) -> str:
        """Nội dung tool_result gửi lại cho Claude."""
        if not self.success:
            return f"ERROR: {self.error}"
        if isinstance(self.data, str):
            return self.data
        return json.dumps(self.data, ensure_ascii=False)


_JSON_TYPES = {str: "string", int: "integer", float: "number", bool: "boolean"}
_PY_CHECK = {"string": str, "integer": int, "number": (int, float), "boolean": bool}


class ToolRegistry:
    def __init__(self):
        self._fns: dict[str, Callable] = {}
        self._tools: list[dict] = []
        self._props: dict[str, dict[str, str]] = {}

    def register(self, fn: Callable, name: str, description: str):
        hints = get_type_hints(fn)
        hints.pop("return", None)
        props = {k: _JSON_TYPES.get(v, "string") for k, v in hints.items()}
        self._props[name] = props
        self._tools.append({
            "name": name,
            "description": (description or "").strip(),
            "eager_input_streaming": True,
            "input_schema": {
                "type": "object",
                "properties": {k: {"type": t} for k, t in props.items()},
                "required": list(props),
                "additionalProperties": False,
            },
        })
        self._fns[name] = fn

    def anthropic_tools(self) -> list[dict]:
        return self._tools

    def validate(self, name: str, args: Any) -> Optional[str]:
        """None nếu hợp lệ; ngược lại là nội dung tool_result lỗi (INVALID_JSON)."""
        props = self._props.get(name)
        if props is None:
            return f"Unknown tool: {name}"
        ok = isinstance(args, dict) and set(args) == set(props) and all(
            isinstance(args[k], _PY_CHECK[t]) and not (t != "boolean" and isinstance(args[k], bool))
            for k, t in props.items()
        )
        if ok:
            return None
        return json.dumps({"INVALID_JSON": json.dumps(args, ensure_ascii=False)}, ensure_ascii=False)

    async def call(self, name: str, kwargs: dict) -> ToolResult:
        fn = self._fns.get(name)
        if fn is None:
            return ToolResult(name, False, None, f"Unknown tool: {name}")
        try:
            result = fn(**kwargs)
            if asyncio.iscoroutine(result):
                result = await result
            return ToolResult(name, True, result)
        except Exception as exc:
            return ToolResult(name, False, None, str(exc))
