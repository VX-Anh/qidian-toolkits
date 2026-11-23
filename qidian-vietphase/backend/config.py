from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # ── LLM — Google Gemini qua native SDK google-genai trên Vertex AI ───
    # Auth Vertex = Application Default Credentials (gcloud auth application-default login)
    # hoặc service-account JSON qua GOOGLE_APPLICATION_CREDENTIALS.
    gcp_project_id: str = Field(default="", validation_alias="GOOGLE_CLOUD_PROJECT")
    gcp_location: str = Field(default="global", validation_alias="GOOGLE_CLOUD_LOCATION")
    # Đường dẫn service-account JSON. Đọc tường minh trong get_client() để không
    # phụ thuộc việc biến này có nằm trong os.environ hay không (pydantic nạp .env
    # vào settings chứ không export ra môi trường process).
    google_application_credentials: str = Field(
        default="", validation_alias="GOOGLE_APPLICATION_CREDENTIALS"
    )
    gemini_model: str = "gemini-3.5-flash"
    gemini_vision_model: str = "gemini-3.5-flash"

    # Gemini 3 không tắt thinking được. LOW = nhanh/rẻ, hợp dịch tiểu thuyết.
    # Giá trị hợp lệ: LOW | MEDIUM | HIGH | MINIMAL
    thinking_level: str = "LOW"
    max_output_tokens: int = 16384

    # Rate limit (token-bucket nội bộ; hạ xuống nếu quota Vertex thấp)
    llm_rpm: int = 500
    llm_tpm: int = 150_000
    # Số lần thử (kể cả lần đầu) khi gặp 408/429/5xx/timeout, backoff mũ 2s→60s.
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
    # "paddle" = PaddleOCR offline (mặc định), "gemini" = Gemini vision
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
        return self.gemini_model

    @property
    def llm_vision_model(self) -> str:
        return self.gemini_vision_model


@lru_cache
def get_settings() -> Settings:
    return Settings()


# Convenient module-level proxy — reads .env lazily on first access
class _SettingsProxy:
    def __getattr__(self, name: str):
        return getattr(get_settings(), name)


settings = _SettingsProxy()
