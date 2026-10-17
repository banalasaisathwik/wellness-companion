import asyncio
import math
import re
import time
from dataclasses import dataclass, field, replace

import httpx


# Application heuristic: a value survives two later valid turns without evidence.
STATE_STALE_AFTER_TURNS = 2
DIMENSIONS = ("energy", "stress", "frustration", "sentiment")


@dataclass(frozen=True)
class ChoiceResult:
    choice: str
    confidence: float
    probabilities: dict[str, float]


@dataclass(frozen=True)
class TurnState:
    energy: ChoiceResult
    stress: ChoiceResult
    frustration: ChoiceResult
    sentiment: ChoiceResult


@dataclass(frozen=True)
class TurnAnalysis:
    """Evidence and response controls extracted from one committed user turn."""

    state: TurnState
    response_preference: str | None
    preference_is_explicit: bool
    needs_clarification: bool
    confidence: float
    acoustic_clarification_hint: bool = False


@dataclass(frozen=True)
class ConversationState:
    """Session-local state dimensions carried forward across valid turns."""

    energy: str = "UNKNOWN"
    stress: str = "UNKNOWN"
    frustration: str = "UNKNOWN"
    sentiment: str = "UNKNOWN"
    latest_applied_turn: int = 0
    analyzed_turn_count: int = 0
    last_concrete_analysis: dict[str, int | None] = field(
        default_factory=lambda: {dimension: None for dimension in DIMENSIONS}
    )


@dataclass(frozen=True)
class StateTransition:
    field: str
    previous: str
    current: str
    reason: str


@dataclass(frozen=True)
class FusionDecision:
    state: TurnState
    confidence: float
    voice: str
    result: str
    reliable: bool
    reliability_reason: str
    clarification_hint: bool
    evidence: dict[str, str]


def fuse_state(
    transcript: str, text_state: TurnAnalysis,
    audio_metrics: dict[str, object] | None,
) -> FusionDecision:
    """Let delivery adjust only energy certainty; explicit text controls meaning."""
    evidence = {name: "unavailable" for name in ("speech_rate", "pause_ratio", "audio_energy")}
    reliable = bool(
        audio_metrics
        and audio_metrics.get("baseline_status") == "READY"
        and audio_metrics.get("baseline_eligible") is True
        and all(
            isinstance(audio_metrics.get(name), (int, float))
            and not isinstance(audio_metrics.get(name), bool)
            and math.isfinite(audio_metrics[name])
            for name in ("speech_rate_delta", "rms_delta")
        )
    )
    if reliable:
        reliability_reason = "ready"
    elif audio_metrics is None:
        reliability_reason = "metrics_unavailable"
    elif audio_metrics.get("baseline_status") != "READY":
        reliability_reason = "baseline_unavailable"
    elif audio_metrics.get("baseline_eligible") is not True:
        reliability_reason = "short_or_invalid_turn"
    else:
        reliability_reason = "comparison_unavailable"
    if reliable and audio_metrics is not None:
        for name, key in (("speech_rate", "speech_rate_delta"), ("pause_ratio", "pause_ratio_delta"), ("audio_energy", "rms_delta")):
            delta = audio_metrics.get(key)
            if isinstance(delta, (int, float)) and not isinstance(delta, bool) and math.isfinite(delta):
                if delta <= -0.2:
                    evidence[name] = "below_baseline"
                elif delta >= 0.2:
                    evidence[name] = "above_baseline"
                else:
                    evidence[name] = "near_baseline"

    lower_votes = sum(evidence[name] == value for name, value in (
        ("speech_rate", "below_baseline"), ("pause_ratio", "above_baseline"), ("audio_energy", "below_baseline")))
    higher_votes = sum(evidence[name] == value for name, value in (
        ("speech_rate", "above_baseline"), ("pause_ratio", "below_baseline"), ("audio_energy", "above_baseline")))
    if lower_votes >= 2:
        voice = "lower_than_baseline"
    elif higher_votes >= 2:
        voice = "higher_than_baseline"
    elif reliable:
        voice = "no_clear_direction"
    else:
        voice = "unavailable"

    # These narrow, first-person corrections override even a contradictory text classification.
    explicit: dict[str, str] = {}
    correction = False
    if re.search(r"\b(?:i(?:['’]m| am)|i feel)\s+(?:really\s+)?not\s+stressed\b", transcript, re.I):
        explicit["stress"] = "LOW"
        correction = True
    if re.search(r"\b(?:i(?:['’]m| am)|i feel)\s+(?:really\s+)?not\s+(?:frustrated|annoyed)\b", transcript, re.I):
        explicit["frustration"] = "LOW"
        correction = True
    if re.search(r"\b(?:i(?:['’]m| am)|i feel)\s+(?:just\s+)?(?:tired|exhausted)\b", transcript, re.I):
        explicit["energy"] = "LOW"
        correction = correction or bool(re.match(r"\s*no\b", transcript, re.I))

    choices: dict[str, ChoiceResult] = {}
    for dimension in DIMENSIONS:
        answer = getattr(text_state.state, dimension)
        if dimension in explicit:
            answer = replace(answer, choice=explicit[dimension],
                             confidence=max(answer.confidence, 0.85) if correction else answer.confidence)
        elif answer.choice != "UNKNOWN" and answer.confidence < 0.55:
            # A weak label becomes UNKNOWN so the existing merge carries prior state.
            answer = replace(answer, choice="UNKNOWN")
        choices[dimension] = answer

    energy = choices["energy"]
    result = "text_only"
    confidence = text_state.confidence
    clarification_hint = False
    if correction:
        result = "explicit_correction"
        confidence = max(confidence, 0.85)
    elif energy.choice == "UNKNOWN" and voice in ("lower_than_baseline", "higher_than_baseline"):
        result = "uncertain_audio_hint"
        confidence = min(confidence, 0.54)
        clarification_hint = True
    elif energy.choice in ("LOW", "HIGH") and voice in ("lower_than_baseline", "higher_than_baseline"):
        agrees = (energy.choice == "LOW") == (voice == "lower_than_baseline")
        result = "agreement" if agrees else "disagreement"
        adjustment = 0.05 if agrees else -0.05
        choices["energy"] = replace(energy, confidence=max(0.0, min(1.0, energy.confidence + adjustment)))
        confidence = max(0.0, min(1.0, confidence + adjustment))

    return FusionDecision(TurnState(**choices), confidence, voice, result, reliable, reliability_reason, clarification_hint, evidence)


def merge_state(
    previous: ConversationState, turn: TurnState, turn_sequence: int
) -> tuple[ConversationState, list[StateTransition]] | None:
    if turn_sequence <= previous.latest_applied_turn:
        return None

    analyzed_turn_count = previous.analyzed_turn_count + 1
    values: dict[str, str | int | dict[str, int | None]] = {
        "latest_applied_turn": turn_sequence,
        "analyzed_turn_count": analyzed_turn_count,
    }
    last_concrete_analysis = previous.last_concrete_analysis.copy()
    transitions: list[StateTransition] = []

    for dimension in DIMENSIONS:
        old_value = getattr(previous, dimension)
        new_value = getattr(turn, dimension).choice
        reason = "new_evidence"
        if new_value != "UNKNOWN":
            last_concrete_analysis[dimension] = analyzed_turn_count
        else:
            new_value = old_value
            last_concrete = last_concrete_analysis[dimension]
            if (
                last_concrete is not None
                and analyzed_turn_count - last_concrete > STATE_STALE_AFTER_TURNS
            ):
                new_value = "UNKNOWN"
                last_concrete_analysis[dimension] = None
                reason = "stale"
        values[dimension] = new_value
        if new_value != old_value:
            transitions.append(StateTransition(dimension, old_value, new_value, reason))

    return (
        ConversationState(**values, last_concrete_analysis=last_concrete_analysis),
        transitions,
    )


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
    transcript: str, api_key: str, model: str, client: httpx.AsyncClient,
    features: dict[str, object] | None = None,
    timings: dict[str, float] | None = None,
) -> TurnAnalysis:
    async with asyncio.timeout(JEV_TIMEOUT_SECONDS):
        request_body = {"model": model, "state": classifier_input(transcript, features), "questions": QUESTIONS}
        request_started = time.perf_counter()
        try:
            response = await client.post(
                DECISIONS_URL,
                headers={"Authorization": f"Bearer {api_key}"},
                json=request_body,
            )
        finally:
            if timings is not None:
                timings["jev_classification_seconds"] = time.perf_counter() - request_started
        parsing_started = time.perf_counter()
        try:
            response.raise_for_status()
            return validate_answers(response.json())
        finally:
            if timings is not None:
                timings["state_parsing_seconds"] = time.perf_counter() - parsing_started
