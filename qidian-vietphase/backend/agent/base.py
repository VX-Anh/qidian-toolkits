import asyncio
from dataclasses import dataclass, field
from typing import AsyncIterator

from google import genai
from google.genai import types

from ..config import settings
from .tools import ToolRegistry


@dataclass
class AgentEvent:
    agent_id: str
    type: str
    data: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"agent": self.agent_id, "type": self.type, **self.data}


def _frag_kv(frag) -> tuple[str, object, bool]:
    """Giải mã 1 fragment partial_args của genai → (key, value, is_string).

    Fragment có json_path kiểu '$.content' và một trong các *_value đã decode sẵn.
    Trả về is_string=True cho string_value (để nối chuỗi + stream live).
    """
    path = frag.json_path or ""
    key = path[2:] if path.startswith("$.") else path
    key = key.split(".")[0].strip("[]'\"")
    if frag.string_value is not None:
        return key, frag.string_value, True
    if frag.number_value is not None:
        return key, frag.number_value, False
    if frag.bool_value is not None:
        return key, frag.bool_value, False
    if getattr(frag, "null_value", None) is not None:
        return key, None, False
    return key, None, False


class BaseAgent:
    MAX_ITER = 20
    TOOL_CHOICE = "auto"  # auto | required | none

    def __init__(self, agent_id: str, client: genai.Client, registry: ToolRegistry, model: str):
        self.agent_id = agent_id
        self.client = client
        self.registry = registry
        self.model = model
        # Lịch sử hội thoại dạng genai Content (giữ nguyên thought_signature trong
        # các part function_call để Gemini 3 không lỗi 400 ở vòng tool đa lượt).
        self.history: list[types.Content] = []

    def _system_prompt(self) -> str:
        raise NotImplementedError

    def _emit(self, type: str, **data) -> AgentEvent:
        return AgentEvent(agent_id=self.agent_id, type=type, data=data)

    def _gen_config(self) -> types.GenerateContentConfig:
        tools = self.registry.genai_tools()
        if self.TOOL_CHOICE == "none" or not tools:
            mode = types.FunctionCallingConfigMode.NONE
        elif self.TOOL_CHOICE in ("required", "any"):
            mode = types.FunctionCallingConfigMode.ANY
        else:
            mode = types.FunctionCallingConfigMode.AUTO

        level = getattr(types.ThinkingLevel, settings.thinking_level.upper(),
                        types.ThinkingLevel.LOW)

        return types.GenerateContentConfig(
            system_instruction=self._system_prompt(),
            temperature=1.0,  # Gemini 3 khuyến nghị giữ mặc định 1.0
            max_output_tokens=settings.max_output_tokens,
            thinking_config=types.ThinkingConfig(thinking_level=level),
            tools=tools or None,
            tool_config=types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode=mode,
                    # Stream từng mảnh JSON arguments để hiện bản dịch live (save_chapter)
                    stream_function_call_arguments=bool(tools),
                )
            ),
        )

    async def run(self, user_message: str) -> AsyncIterator[AgentEvent]:
        self.history = [
            types.Content(role="user", parts=[types.Part(text=user_message)])
        ]
        config = self._gen_config()

        for iteration in range(self.MAX_ITER):
            yield self._emit("thinking", iteration=iteration)

            stream = await self.client.aio.models.generate_content_stream(
                model=self.model,
                contents=self.history,
                config=config,
            )

            full_text = ""
            fcalls: list[dict] = []   # [{name, id, args, raw, sig}]
            cur: dict | None = None   # call đang nhận partial args
            pending_sig = None        # thought_signature chờ gắn vào function_call
            streamed_content = False  # đã stream nội dung save_chapter chưa

            async for chunk in stream:
                if not chunk.candidates or not chunk.candidates[0].content:
                    continue
                for part in (chunk.candidates[0].content.parts or []):
                    sig = getattr(part, "thought_signature", None)
                    if sig:
                        pending_sig = sig

                    fc = getattr(part, "function_call", None)
                    if fc is not None:
                        if fc.name:  # tên chỉ xuất hiện ở chunk đầu của mỗi call
                            cur = {"name": fc.name, "id": fc.id or "",
                                   "args": {}, "raw": None, "sig": None}
                            fcalls.append(cur)
                        if cur is not None:
                            if pending_sig is not None:
                                cur["sig"] = pending_sig
                                pending_sig = None
                            if fc.args:  # fallback non-stream: dict args đầy đủ
                                cur["raw"] = dict(fc.args)
                            # partial_args = list fragment {json_path, *_value}
                            for frag in (fc.partial_args or []):
                                key, val, is_str = _frag_kv(frag)
                                if not key:
                                    continue
                                if is_str:
                                    cur["args"][key] = cur["args"].get(key, "") + val
                                    if cur["name"] == "save_chapter" and key == "content" and val:
                                        streamed_content = True
                                        yield self._emit("token", text=val)
                                else:
                                    cur["args"][key] = val
                        continue

                    # Part văn bản thường (bỏ qua thought summary)
                    if getattr(part, "text", None) and not getattr(part, "thought", False):
                        full_text += part.text
                        yield self._emit("token", text=part.text)

            # Không có tool call → model đã trả lời xong
            if not fcalls:
                self.history.append(types.Content(
                    role="model", parts=[types.Part(text=full_text)]))
                yield self._emit("done", content=full_text)
                return

            # Resolve arguments cuối: ưu tiên dict đầy đủ, fallback dict tái tạo từ fragment
            for c in fcalls:
                c["final"] = c["raw"] if c["raw"] is not None else c["args"]

            # Tái tạo turn của model — giữ thought_signature trên part function_call
            model_parts: list[types.Part] = []
            if full_text:
                model_parts.append(types.Part(text=full_text))
            for c in fcalls:
                model_parts.append(types.Part(
                    function_call=types.FunctionCall(
                        name=c["name"], args=c["final"], id=c["id"] or None),
                    thought_signature=c["sig"],
                ))
            self.history.append(types.Content(role="model", parts=model_parts))

            # Nếu save_chapter không stream partial (model trả args 1 lần) → emit content 1 lần
            if not streamed_content:
                for c in fcalls:
                    if c["name"] == "save_chapter" and isinstance(c["final"], dict):
                        content = c["final"].get("content")
                        if content:
                            yield self._emit("token", text=content)

            yield self._emit("tool_call", tools=[c["name"] for c in fcalls])

            # Thực thi tất cả tool calls song song
            results = await asyncio.gather(*[
                self.registry.call(c["name"], c["final"]) for c in fcalls
            ])

            tool_parts = [
                types.Part.from_function_response(name=c["name"], response=r.to_response())
                for c, r in zip(fcalls, results)
            ]
            self.history.append(types.Content(role="tool", parts=tool_parts))

            for c, result in zip(fcalls, results):
                yield self._emit(
                    "tool_result",
                    tool=c["name"],
                    success=result.success,
                    preview=str(result.data)[:300] if result.success else result.error,
                )

        yield self._emit("max_iter", limit=self.MAX_ITER)
