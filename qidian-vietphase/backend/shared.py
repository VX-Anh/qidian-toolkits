"""Shared singletons — dùng chung across toàn bộ app."""
from google import genai

from .agent.state import SharedState
from .config import settings

_state = SharedState()
_client: genai.Client | None = None


def get_state() -> SharedState:
    return _state


def get_client() -> genai.Client:
    """Native google-genai client trên Vertex AI.

    Auth qua Application Default Credentials (gcloud auth application-default
    login) hoặc GOOGLE_APPLICATION_CREDENTIALS. Dùng client.aio.* cho async.
    """
    global _client
    if _client is None:
        _client = genai.Client(
            vertexai=True,
            project=settings.gcp_project_id,
            location=settings.gcp_location,
        )
    return _client
