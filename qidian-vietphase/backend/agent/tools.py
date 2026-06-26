import asyncio
import json
from dataclasses import dataclass
from typing import Any, Callable, Optional, get_type_hints

from google.genai import types


@dataclass
class ToolResult:
    tool_name: str
    success: bool
    data: Any
    error: Optional[str] = None

    def to_content(self) -> str:
        if self.success:
            return json.dumps(self.data) if not isinstance(self.data, str) else self.data
        return f"ERROR: {self.error}"

    def to_response(self) -> dict:
        """Function response dict cho genai Part.from_function_response."""
        if not self.success:
            return {"error": self.error}
        return self.data if isinstance(self.data, dict) else {"result": self.data}


_TYPE_MAP = {str: "STRING", int: "INTEGER", float: "NUMBER", bool: "BOOLEAN"}


def _py_type_to_genai(annotation) -> types.Schema:
    return types.Schema(type=_TYPE_MAP.get(annotation, "STRING"))


class ToolRegistry:
    def __init__(self):
        self._fns: dict[str, Callable] = {}
        self._decls: list[types.FunctionDeclaration] = []

    def register(self, fn: Callable, name: str, description: str):
        hints = get_type_hints(fn)
        hints.pop("return", None)
        props = {k: _py_type_to_genai(v) for k, v in hints.items()}

        self._decls.append(types.FunctionDeclaration(
            name=name,
            description=description,
            parameters=types.Schema(
                type="OBJECT",
                properties=props,
                required=list(props.keys()),
            ),
        ))
        self._fns[name] = fn

    def genai_tools(self) -> list[types.Tool]:
        """Bọc tất cả function declarations thành list[types.Tool] cho genai."""
        if not self._decls:
            return []
        return [types.Tool(function_declarations=self._decls)]

    def has_tools(self) -> bool:
        return bool(self._decls)

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


def make_registry() -> ToolRegistry:
    return ToolRegistry()
