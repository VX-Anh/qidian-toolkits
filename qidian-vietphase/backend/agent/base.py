import asyncio
import json
from dataclasses import dataclass, field
from typing import AsyncIterator

from openai import AsyncOpenAI

from .tools import ToolRegistry


@dataclass
class AgentEvent:
    agent_id: str
    type: str
    data: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"agent": self.agent_id, "type": self.type, **self.data}


class _ContentStreamer:
    """Trích xuất và stream giá trị field 'content' từ JSON arguments của save_chapter.

    Arguments được gửi dưới dạng chuỗi JSON streaming, ví dụ:
        {"vi_title": "Thiên Diễn Quyết", "content": "Chương 675\\n\\nNội dung..."}
    Class này phát hiện khi nào đang ở trong value của "content" và trả về
    các ký tự đã decode (xử lý JSON escape sequences).
    """
    _MARKER = '"content":'

    def __init__(self):
        self._buf = ""
        self._active = False   # đang bên trong value của content
        self._escape = False   # đang xử lý escape sequence

    def feed(self, chunk: str) -> str:
        """Trả về chuỗi decoded content (có thể rỗng nếu chưa đến phần content)."""
        out = []
        self._buf += chunk

        if not self._active:
            if self._MARKER not in self._buf:
                keep = len(self._MARKER) + 4
                if len(self._buf) > keep:
                    self._buf = self._buf[-keep:]
                return ""
            pos = self._buf.index(self._MARKER) + len(self._MARKER)
            rest = self._buf[pos:].lstrip()
            if not rest.startswith('"'):
                self._buf = rest
                return ""
            self._active = True
            self._buf = rest[1:]

        i = 0
        buf = self._buf
        while i < len(buf):
            c = buf[i]
            if self._escape:
                self._escape = False
                if   c == 'n':  out.append('\n')
                elif c == 't':  out.append('\t')
                elif c == 'r':  out.append('\r')
                elif c == '"':  out.append('"')
                elif c == '\\': out.append('\\')
                elif c == 'u':
                    # \uXXXX — OpenAI có thể escape tiếng Việt thành dạng này
                    if i + 4 < len(buf):
                        try:
                            out.append(chr(int(buf[i + 1:i + 5], 16)))
                            i += 4
                        except ValueError:
                            out.append('\\u')
                    else:
                        # Chưa đủ dữ liệu, lưu lại để xử lý ở chunk tiếp
                        self._buf = buf[i - 1:]
                        return "".join(out)
                else:
                    out.append('\\')
                    out.append(c)
            elif c == '\\':
                self._escape = True
            elif c == '"':
                self._active = False
                self._buf = buf[i + 1:]
                return "".join(out)
            else:
                out.append(c)
            i += 1

        self._buf = ""
        return "".join(out)


class BaseAgent:
    MAX_ITER = 20
    TOOL_CHOICE = "auto"

    def __init__(self, agent_id: str, client: AsyncOpenAI, registry: ToolRegistry, model: str):
        self.agent_id = agent_id
        self.client = client
        self.registry = registry
        self.model = model
        self.messages: list[dict] = []

    def _system_prompt(self) -> str:
        raise NotImplementedError

    def _emit(self, type: str, **data) -> AgentEvent:
        return AgentEvent(agent_id=self.agent_id, type=type, data=data)

    async def run(self, user_message: str) -> AsyncIterator[AgentEvent]:
        self.messages = [
            {"role": "system", "content": self._system_prompt()},
            {"role": "user", "content": user_message},
        ]

        for iteration in range(self.MAX_ITER):
            yield self._emit("thinking", iteration=iteration)

            stream = await self.client.chat.completions.create(
                model=self.model,
                messages=self.messages,
                tools=self.registry.schemas() or None,
                tool_choice=self.TOOL_CHOICE if self.registry.schemas() else "none",
                stream=True,
            )

            full_content = ""
            # key = tool call index, value = accumulated fields
            acc: dict[int, dict] = {}
            streamer = _ContentStreamer()

            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta

                # Stream text tokens (khi model trả lời text thay vì tool call)
                if delta.content:
                    full_content += delta.content
                    yield self._emit("token", text=delta.content)

                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        idx = tc.index
                        if idx not in acc:
                            acc[idx] = {"id": "", "name": "", "arguments": ""}
                        if tc.id:
                            acc[idx]["id"] += tc.id
                        if tc.function:
                            if tc.function.name:
                                acc[idx]["name"] += tc.function.name
                            if tc.function.arguments:
                                arg_chunk = tc.function.arguments
                                acc[idx]["arguments"] += arg_chunk
                                # Stream nội dung dịch từ save_chapter arguments
                                if acc[idx]["name"] == "save_chapter":
                                    text = streamer.feed(arg_chunk)
                                    if text:
                                        yield self._emit("token", text=text)

            # Không có tool call → model đã trả lời xong
            if not acc:
                self.messages.append({"role": "assistant", "content": full_content})
                yield self._emit("done", content=full_content)
                return

            # Tái tạo message assistant với tool_calls để đưa vào history
            tool_calls_list = [
                {
                    "id": acc[i]["id"],
                    "type": "function",
                    "function": {"name": acc[i]["name"], "arguments": acc[i]["arguments"]},
                }
                for i in sorted(acc.keys())
            ]
            msg: dict = {"role": "assistant", "tool_calls": tool_calls_list}
            if full_content:
                msg["content"] = full_content
            self.messages.append(msg)

            yield self._emit("tool_call", tools=[acc[i]["name"] for i in sorted(acc.keys())])

            # Thực thi tất cả tool calls song song
            results = await asyncio.gather(*[
                self.registry.call(acc[i]["name"], json.loads(acc[i]["arguments"]))
                for i in sorted(acc.keys())
            ])

            for i, result in zip(sorted(acc.keys()), results):
                self.messages.append({
                    "role": "tool",
                    "tool_call_id": acc[i]["id"],
                    "content": result.to_content(),
                })
                yield self._emit(
                    "tool_result",
                    tool=acc[i]["name"],
                    success=result.success,
                    preview=str(result.data)[:300] if result.success else result.error,
                )

        yield self._emit("max_iter", limit=self.MAX_ITER)
