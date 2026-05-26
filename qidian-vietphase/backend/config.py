from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    openai_api_key: str = ""
    openai_model: str = "gpt-4o"

    input_dir: Path = Path(r"C:\Users\ASUS\Documents\work\qidian\data\input")
    output_dir: Path = Path(r"C:\Users\ASUS\Documents\work\qidian\data\output")
    ocr_images_dir: Path = Path(r"C:\Users\ASUS\Documents\work\qidian\data\ocr_images")
    rules_dir: Path = Path("rules")

    concurrency: int = 3


@lru_cache
def get_settings() -> Settings:
    return Settings()


# Convenient module-level proxy — reads .env lazily on first access
class _SettingsProxy:
    def __getattr__(self, name: str):
        return getattr(get_settings(), name)


settings = _SettingsProxy()
