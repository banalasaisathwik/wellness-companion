import pytest

from src.conversation.analyze import validate_answers
from src.conversation.state import (
    STATE_STALE_AFTER_TURNS,
    ChoiceResult,
    ConversationState,
    TurnState,
    merge_state,
)


def turn(**choices: str) -> TurnState:
    return TurnState(
        **{
            dimension: ChoiceResult(choices.get(dimension, "UNKNOWN"), 0.1, {})
            for dimension in ("energy", "stress", "frustration", "sentiment")
        }
    )


def applied(state: ConversationState, result: TurnState, sequence: int):
    merged = merge_state(state, result, sequence)
    assert merged is not None
    return merged


def test_new_session_starts_unknown_and_is_independent() -> None:
    first, _ = applied(ConversationState(), turn(stress="HIGH"), 1)
    second = ConversationState()
    assert (second.energy, second.stress, second.frustration, second.sentiment) == (
        "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN"
    )
    assert first.stress == "HIGH"
    assert second.latest_applied_turn == 0


def test_concrete_correction_wins_without_averaging() -> None:
    state, _ = applied(ConversationState(), turn(stress="HIGH"), 1)
    state, changes = applied(state, turn(stress="LOW"), 2)
    assert state.stress == "LOW"
    assert [(change.field, change.previous, change.current) for change in changes] == [
        ("stress", "HIGH", "LOW")
    ]
    state, changes = applied(state, turn(stress="LOW"), 3)
    assert changes == []
    assert state.last_concrete_analysis["stress"] == 3


def test_unknown_carries_forward_then_expires_on_third_no_evidence_turn() -> None:
    state, _ = applied(ConversationState(), turn(stress="HIGH"), 1)
    for sequence in range(2, 2 + STATE_STALE_AFTER_TURNS):
        state, changes = applied(state, turn(), sequence)
        assert state.stress == "HIGH"
        assert changes == []
    state, changes = applied(state, turn(), 2 + STATE_STALE_AFTER_TURNS)
    assert state.stress == "UNKNOWN"
    assert [(change.field, change.reason) for change in changes] == [("stress", "stale")]
    assert state.last_concrete_analysis["stress"] is None


def test_fields_change_independently() -> None:
    state, _ = applied(ConversationState(), turn(energy="LOW", frustration="HIGH"), 1)
    state, changes = applied(state, turn(energy="LOW", frustration="LOW", sentiment="POSITIVE"), 2)
    assert (state.energy, state.stress, state.frustration, state.sentiment) == (
        "LOW", "UNKNOWN", "LOW", "POSITIVE"
    )
    assert {change.field for change in changes} == {"frustration", "sentiment"}


def test_failure_does_not_advance_freshness() -> None:
    state, _ = applied(ConversationState(), turn(stress="HIGH"), 1)
    before_failure = state
    with pytest.raises(ValueError, match="Invalid Jev energy answer type"):
        validate_answers({"answers": {}})
    assert state == before_failure
    assert state.analyzed_turn_count == 1
    assert state.latest_applied_turn == 1
    state, _ = applied(state, turn(), 3)
    state, _ = applied(state, turn(), 4)
    assert state.stress == "HIGH"
    state, _ = applied(state, turn(), 5)
    assert state.stress == "UNKNOWN"


def test_late_older_result_cannot_mutate_or_age_state() -> None:
    state, _ = applied(ConversationState(), turn(stress="HIGH"), 5)
    state, _ = applied(state, turn(stress="LOW"), 6)
    assert merge_state(state, turn(stress="HIGH", energy="LOW"), 5) is None
    assert state.stress == "LOW"
    assert state.energy == "UNKNOWN"
    assert state.analyzed_turn_count == 2
    assert merge_state(state, turn(stress="HIGH"), 6) is None


def test_latest_concrete_evidence_refreshes_field_age() -> None:
    state, _ = applied(ConversationState(), turn(stress="HIGH"), 1)
    state, _ = applied(state, turn(), 2)
    state, changes = applied(state, turn(stress="LOW"), 3)
    assert [(change.previous, change.current) for change in changes] == [("HIGH", "LOW")]
    assert state.last_concrete_analysis["stress"] == 3
    state, _ = applied(state, turn(), 4)
    state, _ = applied(state, turn(), 5)
    assert state.stress == "LOW"


def test_reset_starts_unknown_with_no_freshness() -> None:
    state, _ = applied(ConversationState(), turn(stress="HIGH", energy="LOW"), 1)
    state, _ = applied(state, turn(), 2)
    reset = ConversationState()
    assert (reset.energy, reset.stress, reset.frustration, reset.sentiment) == (
        "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN"
    )
    assert reset.analyzed_turn_count == 0
    assert reset.latest_applied_turn == 0
    assert all(value is None for value in reset.last_concrete_analysis.values())
    state, _ = applied(reset, turn(frustration="HIGH"), 3)
    assert state.stress == "UNKNOWN"
    assert state.frustration == "HIGH"
