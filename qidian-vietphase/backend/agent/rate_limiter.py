import asyncio
import time


class RateLimiter:
    """Token bucket cho Gemini (Vertex) — giới hạn RPM và TPM, dùng chung toàn app."""

    def __init__(self, rpm: int = 500, tpm: int = 150_000):
        self._rpm = rpm
        self._tpm = tpm
        self._request_times: list[float] = []
        self._token_used: int = 0
        self._window_start: float = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self, estimated_tokens: int = 3000):
        async with self._lock:
            now = time.monotonic()

            # Reset token window mỗi 60s
            if now - self._window_start >= 60:
                self._token_used = 0
                self._window_start = now
                self._request_times = [t for t in self._request_times if now - t < 60]

            # Wait nếu vượt TPM
            while self._token_used + estimated_tokens > self._tpm:
                wait = 60 - (now - self._window_start) + 0.1
                await asyncio.sleep(wait)
                now = time.monotonic()
                self._token_used = 0
                self._window_start = now

            # Wait nếu vượt RPM
            self._request_times = [t for t in self._request_times if now - t < 60]
            while len(self._request_times) >= self._rpm:
                oldest = self._request_times[0]
                wait = 60 - (now - oldest) + 0.1
                await asyncio.sleep(wait)
                now = time.monotonic()
                self._request_times = [t for t in self._request_times if now - t < 60]

            self._token_used += estimated_tokens
            self._request_times.append(now)


_shared: "RateLimiter | None" = None


def get_rate_limiter() -> RateLimiter:
    """Một limiter cho mọi agent/job — trước đây mỗi Orchestrator tạo riêng và chỉ
    translator gọi acquire một lần, nên các job song song + reviewer/wiki/extractor
    không bị giới hạn chung."""
    global _shared
    if _shared is None:
        from ..config import settings
        _shared = RateLimiter(rpm=settings.llm_rpm, tpm=settings.llm_tpm)
    return _shared


def estimate_tokens(contents) -> int:
    """Ước lượng thô số token input từ list types.Content (chữ Hán ~1 token/ký tự,
    tiếng Việt ~1 token/3-4 ký tự → lấy chung len//2)."""
    n = 0
    for c in contents or []:
        for p in getattr(c, "parts", None) or []:
            t = getattr(p, "text", None)
            if t:
                n += len(t)
            fc = getattr(p, "function_call", None)
            if fc is not None and getattr(fc, "args", None):
                n += len(str(fc.args))
    return n // 2 + 1000
