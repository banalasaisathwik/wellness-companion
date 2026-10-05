import asyncio
import math

import httpx

from .state import ChoiceResult, TurnAnalysis, TurnState

DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions"
JEV_TIMEOUT_SECONDS = 10.0

QUESTIONS = {
    "energy": {
        "type": "choice",
        "instructions": "What level of energy or activation is directly expressed in this latest user transcript? Use only the transcript, not inferred circumstances. Calmness or relaxation alone does not establish low energy; strong feelings alone do not establish high energy. Choose UNKNOWN when energy is not expressed.",
        "criteria": {
            "LOW": "The utterance directly suggests tiredness, exhaustion, low activation, or low energy.",
            "MEDIUM": "The utterance provides evidence of ordinary or moderate energy or activation.",
            "HIGH": "The utterance directly suggests strong energy, excitement, or high activation.",
            "UNKNOWN": "The utterance does not provide enough evidence about energy.",
        },
    },
    "stress": {
        "type": "choice",
        "instructions": "What level of stress, worry, or pressure is directly expressed in this latest user transcript? A contextual fact, such as having an interview tomorrow, is not by itself evidence of stress.",
        "criteria": {
            "LOW": "The utterance directly indicates calmness, relaxation, or low pressure.",
            "MEDIUM": "The utterance indicates noticeable but moderate worry, pressure, or tension.",
            "HIGH": "The utterance strongly indicates pressure, worry, tension, or feeling overwhelmed.",
            "UNKNOWN": "The utterance does not provide enough evidence about stress.",
        },
    },
    "frustration": {
        "type": "choice",
        "instructions": "What level of annoyance, resistance, or frustration is directly expressed in this latest user transcript? Choose LOW only when the user directly says they are not bothered or frustrated. The absence of frustration, including a factual statement or an utterance about another feeling, is UNKNOWN, not LOW. Do not infer frustration from an event alone.",
        "criteria": {
            "LOW": "The utterance directly indicates the user is not bothered, annoyed, or frustrated.",
            "MEDIUM": "The utterance indicates noticeable but moderate annoyance, resistance, or dissatisfaction.",
            "HIGH": "The utterance strongly indicates being fed up, annoyed, blocked, or frustrated.",
            "UNKNOWN": "The utterance does not provide enough evidence about frustration.",
        },
    },
    "sentiment": {
        "type": "choice",
        "instructions": "What affective direction is clearly expressed in this latest user transcript? Treat genuinely ambiguous wording as unknown.",
        "criteria": {
            "NEGATIVE": "The utterance clearly expresses negative affect or evaluation.",
            "NEUTRAL": "The utterance is clearly factual or affectively neutral.",
            "POSITIVE": "The utterance clearly expresses positive affect or evaluation.",
            "UNKNOWN": "The affective direction is genuinely ambiguous or there is insufficient evidence to distinguish it reliably.",
        },
    },
    "response_preference": {
        "type": "choice",
        "instructions": "Identify an explicit conversational response preference in the latest user transcript. Do not infer a preference from emotional state. Choose NONE unless the user directly asks for a response style.",
        "criteria": {
            "LISTEN": "The user explicitly asks to be heard, listened to, or to vent without advice.",
            "CLARIFY": "The user explicitly asks a clarifying question or asks the companion to clarify.",
            "ENCOURAGE": "The user explicitly asks for motivation or encouragement.",
            "PROBLEM_SOLVE": "The user explicitly asks for advice, options, or help deciding what to do.",
            "GROUND": "The user explicitly asks for help calming down or grounding.",
            "CHECK_IN": "The user explicitly asks the companion to check in or ask how they are doing.",
            "NONE": "No explicit response preference is requested.",
        },
    },
    "needs_clarification": {
        "type": "choice",
        "instructions": "Does the user indicate that a prior response misunderstood them, such as 'that's not what I meant'? Use YES only for an explicit correction or clear request to clarify.",
        "criteria": {"YES": "The user indicates a prior response missed their meaning.", "NO": "No such clarification need is expressed."},
    },
}


def validate_answers(payload: object) -> TurnAnalysis:
    if not isinstance(payload, dict) or not isinstance(payload.get("answers"), dict):
        raise ValueError("Missing Jev answers")

    results: dict[str, ChoiceResult] = {}
    for dimension, question in QUESTIONS.items():
        answer = payload["answers"].get(dimension)
        choices = question["criteria"]
        if not isinstance(answer, dict) or answer.get("type") != "choice":
            raise ValueError(f"Invalid Jev {dimension} answer type")
        if not isinstance(answer.get("choice"), str) or answer["choice"] not in choices:
            raise ValueError(f"Invalid Jev {dimension} choice")
        confidence = answer.get("confidence")
        probabilities = answer.get("probabilities")
        if (
            not isinstance(confidence, (int, float))
            or isinstance(confidence, bool)
            or not math.isfinite(confidence)
            or not 0 <= confidence <= 1
            or not isinstance(probabilities, dict)
            or set(probabilities) != set(choices)
        ):
            raise ValueError(f"Invalid Jev {dimension} diagnostics")
        if any(
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            or not 0 <= value <= 1
            for value in probabilities.values()
        ):
            raise ValueError(f"Invalid Jev {dimension} probabilities")
        results[dimension] = ChoiceResult(
            choice=answer["choice"],
            confidence=float(confidence),
            probabilities={key: float(value) for key, value in probabilities.items()},
        )

    preference = results.pop("response_preference").choice
    needs_clarification = results.pop("needs_clarification").choice == "YES"
    state = TurnState(**results)
    return TurnAnalysis(
        state=state,
        response_preference=None if preference == "NONE" else preference.lower(),
        preference_is_explicit=preference != "NONE",
        needs_clarification=needs_clarification,
        confidence=sum(result.confidence for result in state.__dict__.values()) / 4,
    )


def classifier_input(transcript: str, features: dict[str, object] | None) -> str:
    if not features:
        return transcript
    measurements = (
        ("speech_rate_wpm", "words/minute"),
        ("speech_ratio", "speech ratio"),
        ("pause_ratio", "pause ratio"),
        ("average_energy", "average RMS energy"),
    )
    lines = [
        f"{label}: {features[key]:.2f}"
        for key, label in measurements
        if isinstance(features.get(key), (int, float))
        and not isinstance(features[key], bool)
        and math.isfinite(features[key])
    ]
    if not lines:
        return transcript
    return (
        f"Current transcript: {transcript}\n"
        "Voice measurements (supporting context only; do not infer emotion or "
        "diagnosis from these values, and prioritize explicit words):\n"
        + "\n".join(lines)
    )


async def analyze_state(
    transcript: str, api_key: str, model: str,
    features: dict[str, object] | None = None,
) -> TurnAnalysis:
    async with asyncio.timeout(JEV_TIMEOUT_SECONDS):
        async with httpx.AsyncClient(timeout=JEV_TIMEOUT_SECONDS) as client:
            response = await client.post(
                DECISIONS_URL,
                headers={"Authorization": f"Bearer {api_key}"},
                json={"model": model, "state": classifier_input(transcript, features), "questions": QUESTIONS},
            )
            response.raise_for_status()
            return validate_answers(response.json())
