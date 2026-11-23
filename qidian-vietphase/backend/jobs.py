"""Sổ đăng ký job nền (dịch / wiki / extractor / OCR) dùng chung cho các router.

- Job xong được giữ thêm JOB_TTL giây (để client mở lại stream vẫn xem được kết
  quả nhờ EventQueue có lịch sử), sau đó tự xoá — trước đây các dict job chỉ
  tăng mãi, giữ toàn bộ event trong RAM.
- Task kết thúc bất thường (cancel / exception chưa bắt) mà chưa đóng queue thì
  đóng hộ, để EventSource không treo.
"""
import asyncio

from .agent.state import EventQueue

JOB_TTL = 600  # giây


class JobRegistry:
    def __init__(self, ttl: float = JOB_TTL):
        self.ttl = ttl
        self.queues: dict[str, EventQueue] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self.meta: dict[str, dict] = {}

    def add(self, job_id: str, eq: EventQueue, task: asyncio.Task, **meta) -> None:
        self.queues[job_id] = eq
        self.tasks[job_id] = task
        self.meta[job_id] = meta
        task.add_done_callback(lambda _t, jid=job_id: self._on_done(jid))

    def _on_done(self, job_id: str) -> None:
        eq = self.queues.get(job_id)
        if eq is not None and not eq.closed:
            eq.close_nowait()
        asyncio.get_running_loop().call_later(self.ttl, self.drop, job_id)

    def drop(self, job_id: str) -> None:
        self.queues.pop(job_id, None)
        self.tasks.pop(job_id, None)
        self.meta.pop(job_id, None)

    def running(self, **match) -> list[str]:
        """job_id các job còn chạy có meta khớp mọi cặp key=value trong match."""
        out = []
        # Bản sao: có thể được gọi từ thread (thao tác tên riêng chạy trong threadpool).
        for jid, task in list(self.tasks.items()):
            if task.done():
                continue
            meta = self.meta.get(jid, {})
            if all(meta.get(k) == v for k, v in match.items()):
                out.append(jid)
        return out
