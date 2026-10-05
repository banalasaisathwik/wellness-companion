import asyncio
import json

import httpx
import pytest

from src.conversation import analyze


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
    result = asyncio.run(analyze.analyze_state("I'm completely exhausted.", "test-key", "typesafe/jev-1.13"))

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
    asyncio.run(analyze.analyze_state(
        "I am tired.", "test-key", "typesafe/jev-1.13",
        {
            "speech_rate_wpm": 90.0, "speech_ratio": 0.7,
            "pause_ratio": 0.3, "average_energy": 0.125,
            "partial_transcript": "I am tire", "raw_audio": "excluded",
        },
    ))

    assert len(requests) == 1
    state = json.loads(requests[0].content)["state"]
    assert "Current transcript: I am tired." in state
    assert "words/minute: 90.00" in state
    assert "speech ratio: 0.70" in state
    assert "pause ratio: 0.30" in state
    assert "average RMS energy: 0.12" in state
    assert "partial_transcript" not in state
    assert "raw_audio" not in state


def test_http_error_does_not_become_state(monkeypatch: pytest.MonkeyPatch) -> None:
    client = httpx.AsyncClient
    monkeypatch.setattr(
        analyze.httpx,
        "AsyncClient",
        lambda **kwargs: client(
            transport=httpx.MockTransport(lambda _: httpx.Response(429)), **kwargs
        ),
    )

    with pytest.raises(httpx.HTTPStatusError) as error:
        asyncio.run(analyze.analyze_state("I'm exhausted.", "test-key", "typesafe/jev-1.13"))
    assert error.value.response.status_code == 429


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
