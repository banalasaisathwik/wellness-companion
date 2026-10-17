import asyncio
import json

import httpx
import pytest

from src.conversation import state as analyze


def valid_response() -> dict:
    return {
        "answers": {
            name: {
                "type": "choice",
                "choice": "UNKNOWN" if name in {"energy", "stress", "frustration", "sentiment"} else "NONE" if name == "response_preference" else "NO",
                "probabilities": {choice: 1.0 if choice == ("UNKNOWN" if name in {"energy", "stress", "frustration", "sentiment"} else "NONE" if name == "response_preference" else "NO") else 0.0 for choice in question["criteria"]},
                "confidence": 0.9,
            }
            for name, question in analyze.QUESTIONS.items()
        }
    }


def test_one_decisions_request_contains_only_latest_transcript(monkeypatch: pytest.MonkeyPatch) -> None:
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=valid_response())

    client = httpx.AsyncClient
    monkeypatch.setattr(
        analyze.httpx,
        "AsyncClient",
        lambda **kwargs: client(transport=httpx.MockTransport(respond), **kwargs),
    )
    async def classify() -> analyze.TurnAnalysis:
        async with analyze.httpx.AsyncClient(timeout=analyze.JEV_TIMEOUT_SECONDS) as jev_client:
            return await analyze.analyze_state(
                "I'm completely exhausted.", "test-key", "typesafe/jev-1.13", jev_client,
            )

    result = asyncio.run(classify())

    assert result.state.energy.choice == "UNKNOWN"
    assert result.response_preference is None
    assert result.preference_is_explicit is False
    assert result.needs_clarification is False
    assert len(requests) == 1
    assert requests[0].method == "POST"
    assert str(requests[0].url) == analyze.DECISIONS_URL
    assert json.loads(requests[0].content) == {
        "model": "typesafe/jev-1.13",
        "state": "I'm completely exhausted.",
        "questions": analyze.QUESTIONS,
    }
    assert all(question["type"] == "choice" for question in analyze.QUESTIONS.values())


def test_decisions_request_includes_only_compact_final_voice_features(monkeypatch: pytest.MonkeyPatch) -> None:
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=valid_response())

    client = httpx.AsyncClient
    monkeypatch.setattr(
        analyze.httpx, "AsyncClient",
        lambda **kwargs: client(transport=httpx.MockTransport(respond), **kwargs),
    )
    async def classify() -> None:
        async with analyze.httpx.AsyncClient(timeout=analyze.JEV_TIMEOUT_SECONDS) as jev_client:
            await analyze.analyze_state(
                "I am tired.", "test-key", "typesafe/jev-1.13", jev_client,
                {
                    "speech_rate_wpm": 90.0, "speech_ratio": 0.7,
                    "pause_ratio": 0.3, "average_energy": 0.125,
                    "partial_transcript": "I am tire", "raw_audio": "excluded",
                },
            )

    asyncio.run(classify())

    assert len(requests) == 1
    state = json.loads(requests[0].content)["state"]
    assert "Current transcript: I am tired." in state
    assert "words/minute: 90.00" in state
    assert "speech ratio: 0.70" in state
    assert "pause ratio: 0.30" in state
    assert "average RMS energy: 0.12" in state
    assert "partial_transcript" not in state
    assert "raw_audio" not in state


def test_reused_client_keeps_request_and_parsing_timings_per_turn(monkeypatch: pytest.MonkeyPatch) -> None:
    requests: list[httpx.Request] = []
    created_clients: list[httpx.AsyncClient] = []

    async def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        await asyncio.sleep(0.01)
        return httpx.Response(200, json=valid_response())

    client_type = httpx.AsyncClient

    def create_client(**kwargs: object) -> httpx.AsyncClient:
        client = client_type(transport=httpx.MockTransport(respond), **kwargs)
        created_clients.append(client)
        return client

    monkeypatch.setattr(
        analyze.httpx, "AsyncClient", create_client,
    )

    async def classify_twice() -> tuple[dict[str, float], dict[str, float]]:
        jev_client = analyze.httpx.AsyncClient(timeout=analyze.JEV_TIMEOUT_SECONDS)
        try:
            first: dict[str, float] = {}
            second: dict[str, float] = {}
            await analyze.analyze_state("I'm tired.", "test-key", "typesafe/jev-1.13", jev_client, timings=first)
            await analyze.analyze_state("I'm calmer.", "test-key", "typesafe/jev-1.13", jev_client, timings=second)
            return first, second
        finally:
            await jev_client.aclose()

    for timings in asyncio.run(classify_twice()):
        assert "jev_client_setup_seconds" not in timings
        assert timings["jev_classification_seconds"] >= 0.01
        assert timings["state_parsing_seconds"] >= 0
    assert len(created_clients) == 1
    assert created_clients[0].is_closed
    assert [json.loads(request.content)["state"] for request in requests] == [
        "I'm tired.", "I'm calmer.",
    ]


def test_http_error_does_not_become_state(monkeypatch: pytest.MonkeyPatch) -> None:
    client = httpx.AsyncClient
    monkeypatch.setattr(
        analyze.httpx,
        "AsyncClient",
        lambda **kwargs: client(
            transport=httpx.MockTransport(lambda _: httpx.Response(429)), **kwargs
        ),
    )

    timings: dict[str, float] = {}
    async def classify() -> None:
        async with analyze.httpx.AsyncClient(timeout=analyze.JEV_TIMEOUT_SECONDS) as jev_client:
            await analyze.analyze_state(
                "I'm exhausted.", "test-key", "typesafe/jev-1.13", jev_client, timings=timings,
            )

    with pytest.raises(httpx.HTTPStatusError) as error:
        asyncio.run(classify())
    assert error.value.response.status_code == 429
    assert timings["jev_classification_seconds"] >= 0
    assert timings["state_parsing_seconds"] >= 0


@pytest.mark.parametrize(
    "change",
    [
        lambda data: data["answers"].pop("stress"),
        lambda data: data["answers"]["energy"].update(choice="VERY_TIRED"),
        lambda data: data["answers"]["sentiment"].update(type="score"),
        lambda data: data["answers"]["frustration"].update(confidence="high"),
        lambda data: data["answers"]["stress"]["probabilities"].update(LOW=float("nan")),
    ],
)
def test_malformed_answers_fail_instead_of_becoming_state(change) -> None:
    payload = valid_response()
    change(payload)
    with pytest.raises(ValueError):
        analyze.validate_answers(payload)
