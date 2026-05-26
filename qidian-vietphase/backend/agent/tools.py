import asyncio
import inspect
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
        if self.success:
            return json.dumps(self.data) if not isinstance(self.data, str) else self.data
        return f"ERROR: {self.error}"


def _py_type_to_json(annotation) -> dict:
    mapping = {str: "string", int: "integer", float: "number", bool: "boolean"}
    return {"type": mapping.get(annotation, "string")}


class ToolRegistry:
    def __init__(self):
        self._fns: dict[str, Callable] = {}
        self._schemas: list[dict] = []

    def register(self, fn: Callable, name: str, description: str):
        hints = get_type_hints(fn)
        hints.pop("return", None)
        props = {k: _py_type_to_json(v) for k, v in hints.items()}

        self._schemas.append({
            "type": "function",
            "function": {
                "name": name,
                "description": description,
                "parameters": {
                    "type": "object",
                    "properties": props,
                    "required": list(props.keys()),
                },
            },
        })
        self._fns[name] = fn

    def schemas(self) -> list[dict]:
        return self._schemas

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
