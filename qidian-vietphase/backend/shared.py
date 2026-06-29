"""Shared singletons — dùng chung across toàn bộ app."""
from pathlib import Path

from google import genai

from .agent.state import SharedState
from .config import settings

_state = SharedState(str(settings.db_path))
_client: genai.Client | None = None


def get_state() -> SharedState:
    return _state


def get_client() -> genai.Client:
    """Native google-genai client trên Vertex AI.

    Auth:
    - Nếu GOOGLE_APPLICATION_CREDENTIALS trỏ tới file service-account JSON →
      nạp tường minh từ file đó (không phụ thuộc os.environ, vì pydantic nạp .env
      vào settings chứ không export ra môi trường process).
    - Nếu không → rơi về ADC mặc định (gcloud login khi dev, attached SA trên GCE).
    Dùng client.aio.* cho async.
    """
    global _client
    if _client is None:
        credentials = None
        cred_path = settings.google_application_credentials
        if cred_path:
            # Đã chỉ định path thì PHẢI có file thật. Nếu mount sai / thiếu file,
            # raise ngay lúc khởi tạo thay vì âm thầm rơi về ADC rồi lỗi mơ hồ
            # tận lúc gọi model (khó trace, nhất là trong container).
            if not Path(cred_path).is_file():
                raise RuntimeError(
                    f"GOOGLE_APPLICATION_CREDENTIALS trỏ tới file không tồn tại: {cred_path!r}. "
                    "Kiểm tra lại đường dẫn / volume mount (vd secrets/gcp-sa.json)."
                )
            from google.oauth2 import service_account
            credentials = service_account.Credentials.from_service_account_file(
                cred_path,
                scopes=["https://www.googleapis.com/auth/cloud-platform"],
            )
        _client = genai.Client(
            vertexai=True,
            project=settings.gcp_project_id,
            location=settings.gcp_location,
            credentials=credentials,
        )
    return _client
