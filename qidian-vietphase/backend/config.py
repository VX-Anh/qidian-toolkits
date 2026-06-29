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

    input_dir: Path = Path(r"C:\Users\ASUS\Documents\work\qidian\data\input")
    output_dir: Path = Path(r"C:\Users\ASUS\Documents\work\qidian\data\output")
    ocr_images_dir: Path = Path(r"C:\Users\ASUS\Documents\work\qidian\data\ocr_images")
    # Thư mục import sẵn: vietphase/{slug}/{chương}/(output.txt + ảnh .jpg)
    vietphase_dir: Path = Path(r"C:\Users\ASUS\Documents\work\qidian\data\vietphase")
    rules_dir: Path = Path("rules")

    # Vị trí file SQLite. Khi host nên trỏ ra volume bền vững (vd /data/state.db)
    # để git pull / rebuild container không đụng vào DB.
    db_path: Path = Path("backend/db/state.db")

    concurrency: int = 3

    # ── OCR ──────────────────────────────────────────────────────────────
    # "paddle" = PaddleOCR offline (mặc định), "gemini" = Gemini vision
    ocr_default_engine: str = "paddle"
    # PaddleOCR chạy trong venv riêng của project qidian-ocr (paddle + model đã cài sẵn)
    paddle_python: Path = Path(r"C:\Users\ASUS\Documents\work\qidian\qidian-ocr\.venv\Scripts\python.exe")
    paddle_ocr_script: Path = Path(r"C:\Users\ASUS\Documents\work\qidian\qidian-ocr\run_ocr.py")
    paddle_ocr_cwd: Path = Path(r"C:\Users\ASUS\Documents\work\qidian\qidian-ocr")
    paddle_use_server: bool = True

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
