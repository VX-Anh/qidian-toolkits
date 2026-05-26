import asyncio
import time


class RateLimiter:
    """Token bucket cho OpenAI API — giới hạn RPM và TPM."""

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
