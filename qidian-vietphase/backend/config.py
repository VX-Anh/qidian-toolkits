from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # ── LLM — Claude (Anthropic API) ─────────────────────────────────────
    # Key: ANTHROPIC_API_KEY, hoặc ANTHROPIC_API_KEY_FILE trỏ tới file chứa key
    # (Docker: secret mount; entrypoint chép ra bản app đọc được).
    anthropic_api_key: str = ""
    anthropic_api_key_file: str = ""
    # Tên biến env: MODEL_TRANSLATE / MODEL_LIGHT / MODEL_VISION / LLM_EFFORT (không dùng
    # tiền tố CLAUDE_ — trùng biến môi trường của Claude Code, vd CLAUDE_EFFORT).
    # Dịch chương: Sonnet (chất lượng văn). Việc phụ (trích thuật ngữ, review, wiki):
    # Haiku cho rẻ. OCR ảnh: Sonnet (đọc chữ Hán trong ảnh tốt hơn).
    model_translate: str = "claude-sonnet-5-5"
    model_light: str = "claude-haiku-5-5"
    model_vision: str = "claude-sonnet-5-5"
    # Mức suy nghĩ: low | medium | high | xhigh | max. Dịch truyện không cần suy
    # luận sâu → low (nhanh, rẻ); tăng nếu thấy chất lượng chưa đạt.
    llm_effort: str = "low"
    # Dịch chương qua: "api" (Claude API, key ở trên) | "cli" (Claude Code CLI `claude -p`
    # headless, dùng gói đăng ký đã đăng nhập trong CLI). Trích thuật ngữ, review, wiki,
    # OCR luôn đi API.
    translate_provider: str = "api"
    cli_bin: str = "claude"
    # Model cho CLI; rỗng = MODEL_TRANSLATE. CLI_EFFORT rỗng = mặc định của CLI.
    cli_model: str = ""
    cli_effort: str = ""
    # Quá thời gian (giây) một chương → coi như CLI lỗi.
    cli_timeout: int = 900
    # CLI lỗi (chưa đăng nhập, hết hạn mức, quá giờ) → dịch lại chương đó bằng API.
    cli_fallback_api: bool = True
    # Streaming nên đặt rộng (chương dài + phần thinking); chạm trần → chương FAILED.
    max_output_tokens: int = 64000

    # Rate limit (token-bucket nội bộ; đặt theo hạn mức tier của tài khoản Anthropic)
    llm_rpm: int = 500
    llm_tpm: int = 150_000
    # Số lần SDK tự thử lại khi gặp 408/409/429/5xx/lỗi kết nối (backoff mũ).
    llm_retry_attempts: int = 6

    # Default tương đối theo cwd chạy uvicorn (qidian-vietphase/); .env đè lại nếu cần.
    input_dir: Path = Path(r"..\data\input")
    output_dir: Path = Path(r"..\data\output")
    ocr_images_dir: Path = Path(r"..\data\ocr_images")
    # Thư mục import sẵn: vietphase/{slug}/{chương}/(output.txt + ảnh .jpg)
    vietphase_dir: Path = Path(r"..\data\vietphase")
    rules_dir: Path = Path("rules")

    # Vị trí file SQLite. Khi host nên trỏ ra volume bền vững (vd /data/state.db)
    # để git pull / rebuild container không đụng vào DB.
    db_path: Path = Path("backend/db/state.db")

    concurrency: int = 3

    # ── Bảo mật ──────────────────────────────────────────────────────────
    # Token bảo vệ toàn bộ /api/*. Rỗng = tắt auth (chỉ nên dùng khi chạy local).
    # Bắt buộc đặt khi deploy ra Internet (docker-compose sẽ báo lỗi nếu thiếu).
    api_token: str = ""
    # Origin được phép gọi API từ trình duyệt khác origin, phân tách bằng dấu phẩy.
    # Rỗng = không bật CORS (frontend cùng origin, extension có host_permissions
    # nên không cần CORS).
    cors_origins: str = ""
    # Bật FastAPI debug (traceback trong response) + endpoint /_dev/ping cho auto-reload.
    dev_mode: bool = False

    # ── OCR ──────────────────────────────────────────────────────────────
    # "paddle" = PaddleOCR offline (mặc định), "claude" = Claude vision
    ocr_default_engine: str = "paddle"
    # PaddleOCR chạy trong venv riêng của project qidian-ocr (paddle + model đã cài sẵn).
    # Default tương đối theo cwd chạy uvicorn (qidian-vietphase/); .env đè lại nếu cần.
    paddle_python: Path = Path(r"..\qidian-ocr\.venv\Scripts\python.exe")
    paddle_ocr_script: Path = Path(r"..\qidian-ocr\run_ocr.py")
    paddle_ocr_cwd: Path = Path(r"..\qidian-ocr")
    paddle_use_server: bool = True
    # URL sidecar OCR (PaddleOCR HTTP) khi deploy Docker. Rỗng = dùng subprocess venv
    # (dev Windows, qua paddle_python ở trên). Compose set OCR_SERVICE_URL=http://ocr:8000.
    ocr_service_url: str = ""

    # ── LLM resolvers ────────────────────────────────────────────────────
    @property
    def llm_model(self) -> str:
        return self.model_translate

    @property
    def llm_light_model(self) -> str:
        return self.model_light

    @property
    def llm_vision_model(self) -> str:
        return self.model_vision


@lru_cache
def get_settings() -> Settings:
    return Settings()


# Convenient module-level proxy — reads .env lazily on first access
class _SettingsProxy:
    def __getattr__(self, name: str):
        return getattr(get_settings(), name)


settings = _SettingsProxy()
