from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    openai_api_key: str = ""
    openai_model: str = "gpt-5.4-mini"

    input_dir: Path = Path(r"C:\Users\ASUS\Documents\work\qidian\data\input")
    output_dir: Path = Path(r"C:\Users\ASUS\Documents\work\qidian\data\output")
    ocr_images_dir: Path = Path(r"C:\Users\ASUS\Documents\work\qidian\data\ocr_images")
    # Thư mục import sẵn: vietphase/{slug}/{chương}/(output.txt + ảnh .jpg)
    vietphase_dir: Path = Path(r"C:\Users\ASUS\Documents\work\qidian\data\vietphase")
    rules_dir: Path = Path("rules")

    concurrency: int = 3

    # ── OCR ──────────────────────────────────────────────────────────────
    # "paddle" = PaddleOCR offline (mặc định), "openai" = gpt-4o-mini vision
    ocr_default_engine: str = "paddle"
    # PaddleOCR chạy trong venv riêng của project qidian-ocr (paddle + model đã cài sẵn)
    paddle_python: Path = Path(r"C:\Users\ASUS\Documents\work\qidian\qidian-ocr\.venv\Scripts\python.exe")
    paddle_ocr_script: Path = Path(r"C:\Users\ASUS\Documents\work\qidian\qidian-ocr\run_ocr.py")
    paddle_ocr_cwd: Path = Path(r"C:\Users\ASUS\Documents\work\qidian\qidian-ocr")
    paddle_use_server: bool = True


@lru_cache
def get_settings() -> Settings:
    return Settings()


# Convenient module-level proxy — reads .env lazily on first access
class _SettingsProxy:
    def __getattr__(self, name: str):
        return getattr(get_settings(), name)


settings = _SettingsProxy()
