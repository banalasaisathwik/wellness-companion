import asyncio
from unittest.mock import AsyncMock

import httpx
import pytest

from src import api


@pytest.fixture
def worker_client(monkeypatch):
    for name in ("LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"):
        monkeypatch.setenv(name, "test-credential-" * 3)
    monkeypatch.setenv("LIVEKIT_URL", "wss://example.livekit.cloud")
    monkeypatch.setenv("VOICE_WORKER_HEALTH_URL", "http://127.0.0.1:8081")
    client = AsyncMock()
    client.__aenter__.return_value = client
    monkeypatch.setattr(api.httpx, "AsyncClient", lambda **kwargs: client)
    return client


def test_session_reports_unavailable_worker_instead_of_minting_token(worker_client):
    worker_client.get.side_effect = httpx.ConnectError("connection refused")
    with pytest.raises(api.HTTPException) as error:
        asyncio.run(api.create_session())
    assert error.value.status_code == 503
    assert "still starting" in error.value.detail


def test_session_rejects_another_room_while_worker_is_busy(worker_client):
    worker_client.get.return_value = httpx.Response(
        200, json={"active_jobs": 1}, request=httpx.Request("GET", "http://127.0.0.1:8081"),
    )
    with pytest.raises(api.HTTPException) as error:
        asyncio.run(api.create_session())
    assert error.value.status_code == 409


def test_session_token_preserves_dispatch_when_worker_is_available(worker_client):
    worker_client.get.return_value = httpx.Response(
        200, json={"active_jobs": 0}, request=httpx.Request("GET", "http://127.0.0.1:8081"),
    )
    session = asyncio.run(api.create_session())
    assert session["server_url"] == "wss://example.livekit.cloud"
    assert session["room_name"].startswith("voice-companion-")
    assert session["token"]
