"""Shared singletons — dùng chung across toàn bộ app."""
from pathlib import Path

import anthropic

from .agent.state import SharedState
from .config import settings

_state = SharedState(str(settings.db_path))
_relocated = _state.relocate_outputs(settings.output_dir)
if _relocated:
    print(f"[db] trỏ lại {_relocated} bản dịch theo OUTPUT_DIR hiện tại", flush=True)
_client: anthropic.AsyncAnthropic | None = None


def get_state() -> SharedState:
    return _state


def get_client() -> anthropic.AsyncAnthropic:
    """AsyncAnthropic dùng chung. Key lấy theo thứ tự: ANTHROPIC_API_KEY (env/.env),
    rồi file ANTHROPIC_API_KEY_FILE. SDK tự thử lại 408/409/429/5xx + lỗi kết nối."""
    global _client
    if _client is None:
        key = settings.anthropic_api_key.strip()
        if not key and settings.anthropic_api_key_file:
            path = Path(settings.anthropic_api_key_file)
            if not path.is_file():
                raise RuntimeError(
                    f"ANTHROPIC_API_KEY_FILE trỏ tới file không tồn tại: {str(path)!r} "
                    "— kiểm tra volume mount / secrets."
                )
            key = path.read_text(encoding="utf-8").strip()
        if not key:
            raise RuntimeError("Chưa cấu hình Claude API key (ANTHROPIC_API_KEY hoặc ANTHROPIC_API_KEY_FILE)")
        _client = anthropic.AsyncAnthropic(api_key=key, max_retries=settings.llm_retry_attempts)
    return _client
