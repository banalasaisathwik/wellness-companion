import math
import re
from dataclasses import dataclass, field, replace


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
    reliability_reason = (
        "ready" if reliable else "metrics_unavailable" if audio_metrics is None
        else "baseline_unavailable" if audio_metrics.get("baseline_status") != "READY"
        else "short_or_invalid_turn" if audio_metrics.get("baseline_eligible") is not True
        else "comparison_unavailable"
    )
    if reliable and audio_metrics is not None:
        for name, key in (("speech_rate", "speech_rate_delta"), ("pause_ratio", "pause_ratio_delta"), ("audio_energy", "rms_delta")):
            delta = audio_metrics.get(key)
            if isinstance(delta, (int, float)) and not isinstance(delta, bool) and math.isfinite(delta):
                evidence[name] = "below_baseline" if delta <= -0.2 else "above_baseline" if delta >= 0.2 else "near_baseline"

    lower_votes = sum(evidence[name] == value for name, value in (
        ("speech_rate", "below_baseline"), ("pause_ratio", "above_baseline"), ("audio_energy", "below_baseline")))
    higher_votes = sum(evidence[name] == value for name, value in (
        ("speech_rate", "above_baseline"), ("pause_ratio", "below_baseline"), ("audio_energy", "above_baseline")))
    voice = "lower_than_baseline" if lower_votes >= 2 else "higher_than_baseline" if higher_votes >= 2 else "no_clear_direction" if reliable else "unavailable"

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
