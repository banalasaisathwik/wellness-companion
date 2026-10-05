from dataclasses import replace

import pytest

from src.conversation.state import ChoiceResult, ConversationState, TurnAnalysis, TurnState, fuse_state, merge_state
from src.conversation.strategy import Strategy, choose_strategy


def analysis(energy: str, confidence: float = 0.72, stress: str = "UNKNOWN") -> TurnAnalysis:
    return TurnAnalysis(
        TurnState(
            ChoiceResult(energy, confidence, {}),
            ChoiceResult(stress, confidence, {}),
            ChoiceResult("UNKNOWN", confidence, {}),
            ChoiceResult("UNKNOWN", confidence, {}),
        ),
        None, False, False, confidence,
    )


def lower_voice() -> dict[str, object]:
    return {
        "baseline_status": "READY", "baseline_eligible": True,
        "speech_rate_delta": -0.4, "pause_ratio_delta": 0.5, "rms_delta": -0.3,
    }


def test_agreement_only_raises_confidence_slightly() -> None:
    fusion = fuse_state("I'm exhausted", analysis("LOW"), lower_voice())
    assert (fusion.result, fusion.voice, fusion.state.energy.choice) == ("agreement", "lower_than_baseline", "LOW")
    assert fusion.confidence == 0.77
    assert fusion.state.energy.confidence == 0.77
    assert fusion.evidence == {
        "speech_rate": "below_baseline", "pause_ratio": "above_baseline", "audio_energy": "below_baseline",
    }


def test_disagreement_keeps_text_choice() -> None:
    fusion = fuse_state("I'm feeling great", analysis("HIGH"), lower_voice())
    assert (fusion.result, fusion.state.energy.choice) == ("disagreement", "HIGH")
    assert fusion.confidence == pytest.approx(0.67)


def test_explicit_correction_overrides_previous_and_audio() -> None:
    previous = ConversationState(energy="HIGH", stress="HIGH")
    fusion = fuse_state("No, I'm not stressed. I'm just tired.", analysis("HIGH", 0.4, "HIGH"), lower_voice())
    merged = merge_state(previous, fusion.state, 1)
    assert merged is not None
    final, _ = merged
    assert (fusion.result, final.energy, final.stress) == ("explicit_correction", "LOW", "LOW")
    assert fusion.confidence >= 0.85


def test_missing_short_or_invalid_audio_is_text_only() -> None:
    for audio in (None, {**lower_voice(), "baseline_status": "CALIBRATING"},
                  {**lower_voice(), "baseline_eligible": False},
                  {**lower_voice(), "rms_delta": None}):
        fusion = fuse_state("I'm tired", analysis("LOW"), audio)
        assert (fusion.result, fusion.reliable, fusion.state.energy.choice) == ("text_only", False, "LOW")


def test_ambiguous_text_uses_previous_state_and_can_clarify() -> None:
    previous = ConversationState(energy="LOW")
    fusion = fuse_state("Yeah... I'm fine.", analysis("UNKNOWN", 0.72), lower_voice())
    merged = merge_state(previous, fusion.state, 1)
    assert merged is not None
    final, _ = merged
    assert (fusion.result, final.energy, fusion.confidence) == ("uncertain_audio_hint", "LOW", 0.54)
    decision = choose_strategy(replace(analysis("UNKNOWN"), state=fusion.state,
                                       confidence=fusion.confidence, acoustic_clarification_hint=fusion.clarification_hint))
    assert decision.strategy == Strategy.CLARIFY


def test_weak_text_does_not_flip_previous_state() -> None:
    fusion = fuse_state("Maybe", analysis("HIGH", 0.4), None)
    merged = merge_state(ConversationState(energy="LOW"), fusion.state, 1)
    assert merged is not None
    final, _ = merged
    assert final.energy == "LOW"
    assert fusion.state.energy.choice == "UNKNOWN"
