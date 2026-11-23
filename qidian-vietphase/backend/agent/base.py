"""BaseAgent — vòng lặp ReAct trên Claude Messages API (streaming + tool use).

Mỗi lượt: stream một response → nếu có tool_use thì chạy song song các tool, trả
mọi tool_result trong MỘT user message → lặp tới khi model không gọi tool nữa.

- Tool khai báo `eager_input_streaming` để nội dung save_chapter (rất dài) stream
  ra UI ngay khi model viết. Khi đó server không validate input nữa → tự kiểm
  input trước khi chạy tool (ToolRegistry.validate).
- stop_reason `max_tokens` có tool_use → bản dịch bị cắt, KHÔNG chạy tool (raise);
  `refusal` → raise. Orchestrator đánh FAILED với thông điệp rõ ràng.
- Lịch sử giữ nguyên `response.content` (kể cả thinking / fallback block).
"""
import asyncio
from dataclasses import dataclass, field
from typing import AsyncIterator

import anthropic
import jiter

from ..config import settings
from .rate_limiter import estimate_tokens, get_rate_limiter
from .tools import ToolRegistry


@dataclass
class AgentEvent:
    agent_id: str
    type: str
    data: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"agent": self.agent_id, "type": self.type, **self.data}


# Model có server-side refusal fallback ("default" = API tự chọn model thay thế theo
# loại từ chối). Haiku 5.5 không có.
_FALLBACK_MODELS = {"claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5",
                    "claude-fable-5-1", "claude-fable-5-2"}
_FALLBACK_BETA = "server-side-fallback-2026-07-01"

# Tool có tham số dài cần stream ra UI theo từng mảnh: tên tool → tên tham số.
STREAMED_TOOL_FIELDS = {"save_chapter": "content"}

_JSON_RETRIES = 2


def fallback_kwargs(model: str) -> dict:
    if model in _FALLBACK_MODELS:
        return {"betas": [_FALLBACK_BETA], "fallbacks": "default"}
    return {}


class BaseAgent:
    MAX_ITER = 20

    def __init__(self, agent_id: str, client: anthropic.AsyncAnthropic,
                 registry: ToolRegistry, model: str):
        self.agent_id = agent_id
        self.client = client
        self.registry = registry
        self.model = model
        self.messages: list[dict] = []
        self._final = None

    def _system_prompt(self) -> str:
        raise NotImplementedError

    def _emit(self, type: str, **data) -> AgentEvent:
        return AgentEvent(agent_id=self.agent_id, type=type, data=data)

    def _request_kwargs(self) -> dict:
        kwargs = dict(
            model=self.model,
            max_tokens=settings.max_output_tokens,
            # system + tools ổn định giữa các lượt → breakpoint trên system cache luôn
            # tools (thứ tự render: tools → system → messages).
            system=[{"type": "text", "text": self._system_prompt(),
                     "cache_control": {"type": "ephemeral"}}],
            # Tự cache lịch sử tới block cuối mỗi lượt (vòng tool gửi lại toàn bộ).
            cache_control={"type": "ephemeral"},
            output_config={"effort": settings.llm_effort},
            messages=self.messages,
            **fallback_kwargs(self.model),
        )
        tools = self.registry.anthropic_tools()
        if tools:
            kwargs["tools"] = tools
        return kwargs

    async def _stream_turn(self) -> AsyncIterator[AgentEvent]:
        """Stream một lượt, phát event token; response đầy đủ lưu ở self._final."""
        current_tool: str | None = None
        raw_json = ""
        streamed_len = 0
        async with self.client.beta.messages.stream(**self._request_kwargs()) as stream:
            async for event in stream:
                if event.type == "content_block_start":
                    block = event.content_block
                    current_tool = block.name if block.type == "tool_use" else None
                    raw_json = ""
                    streamed_len = 0
                elif event.type == "text":
                    if event.text:
                        yield self._emit("token", text=event.text)
                elif event.type == "input_json" and current_tool in STREAMED_TOOL_FIELDS:
                    # event.snapshot bỏ chuỗi đang viết dở → tự ghép partial_json rồi parse
                    # kiểu "trailing-strings" (giữ chuỗi dở) để phát phần chữ mới thêm.
                    raw_json += event.partial_json
                    try:
                        snap = jiter.from_json(raw_json.encode(), partial_mode="trailing-strings")
                    except ValueError:
                        continue
                    value = snap.get(STREAMED_TOOL_FIELDS[current_tool]) if isinstance(snap, dict) else None
                    if isinstance(value, str) and len(value) > streamed_len:
                        yield self._emit("token", text=value[streamed_len:])
                        streamed_len = len(value)
            self._final = await stream.get_final_message()

    async def run(self, user_message) -> AsyncIterator[AgentEvent]:
        self.messages = [{"role": "user", "content": user_message}]

        for iteration in range(self.MAX_ITER):
            yield self._emit("thinking", iteration=iteration)
            await get_rate_limiter().acquire(estimate_tokens(self.messages))

            json_retries = 0
            while True:
                try:
                    async for ev in self._stream_turn():
                        yield ev
                    break
                except ValueError:
                    # Input JSON của tool hỏng tới mức SDK không parse được: chưa có
                    # tool_use_id để trả lỗi → gửi lại lượt này (có giới hạn).
                    json_retries += 1
                    if json_retries > _JSON_RETRIES:
                        raise
            response = self._final

            tool_uses = [b for b in response.content if b.type == "tool_use"]
            if response.stop_reason == "refusal":
                detail = getattr(response, "stop_details", None)
                cat = getattr(detail, "category", None) if detail else None
                raise RuntimeError(f"Claude từ chối yêu cầu ({cat or 'không rõ lý do'})")
            if response.stop_reason == "max_tokens" and tool_uses:
                # Input tool bị cắt vẫn parse ra object "hợp lệ" một nửa → không chạy.
                raise RuntimeError(
                    "Output bị cắt do chạm MAX_OUTPUT_TOKENS "
                    f"({settings.max_output_tokens}) — tăng MAX_OUTPUT_TOKENS hoặc chia nhỏ chương"
                )

            self.messages.append({"role": "assistant", "content": response.content})

            if response.stop_reason == "pause_turn":
                continue
            if not tool_uses:
                text = "".join(b.text for b in response.content if b.type == "text")
                yield self._emit("done", content=text)
                return

            yield self._emit("tool_call", tools=[b.name for b in tool_uses])

            async def run_one(block):
                invalid = self.registry.validate(block.name, block.input)
                if invalid:
                    return None, invalid
                return await self.registry.call(block.name, block.input), None

            outcomes = await asyncio.gather(*[run_one(b) for b in tool_uses])

            tool_results = []
            for block, (result, invalid) in zip(tool_uses, outcomes):
                if invalid:
                    tool_results.append({"type": "tool_result", "tool_use_id": block.id,
                                         "is_error": True, "content": invalid})
                    yield self._emit("tool_result", tool=block.name, success=False, preview=invalid)
                    continue
                tool_results.append({"type": "tool_result", "tool_use_id": block.id,
                                     "is_error": not result.success,
                                     "content": result.to_content()})
                yield self._emit(
                    "tool_result",
                    tool=block.name,
                    success=result.success,
                    preview=str(result.data)[:300] if result.success else result.error,
                )
            # Mọi tool_result trong MỘT user message (tách ra làm model ngừng gọi song song).
            self.messages.append({"role": "user", "content": tool_results})

        yield self._emit("max_iter", limit=self.MAX_ITER)
