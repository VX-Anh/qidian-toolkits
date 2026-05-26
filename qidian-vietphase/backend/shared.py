"""Shared singletons — dùng chung across toàn bộ app."""
from openai import AsyncOpenAI

from .agent.state import SharedState
from .config import settings

_state = SharedState()
_client: AsyncOpenAI | None = None


def get_state() -> SharedState:
    return _state


def get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=settings.openai_api_key)
    return _client
