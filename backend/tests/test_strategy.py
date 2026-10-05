from src.conversation.state import ChoiceResult, TurnAnalysis, TurnState
from src.conversation.strategy import Strategy, choose_strategy


def analysis(
    preference: str | None = None,
    explicit: bool = False,
    needs_clarification: bool = False,
    confidence: float = 0.9,
    stress: str = "UNKNOWN",
) -> TurnAnalysis:
    unknown = ChoiceResult("UNKNOWN", 0.9, {})
    state = TurnState(unknown, ChoiceResult(stress, 0.9, {}), unknown, unknown)
    return TurnAnalysis(state, preference, explicit, needs_clarification, confidence)


def test_explicit_listen_overrides_high_stress() -> None:
    result = choose_strategy(analysis("listen", True))
    assert (result.strategy, result.source) == (Strategy.LISTEN, "explicit_request")


def test_explicit_problem_solve_maps_directly() -> None:
    result = choose_strategy(analysis("problem_solve", True))
    assert (result.strategy, result.source) == (Strategy.PROBLEM_SOLVE, "explicit_request")


def test_clarification_precedes_low_confidence() -> None:
    result = choose_strategy(analysis(needs_clarification=True, confidence=0.2))
    assert (result.strategy, result.source) == (Strategy.CLARIFY, "clarification")


def test_low_confidence_checks_in() -> None:
    result = choose_strategy(analysis(confidence=0.54))
    assert (result.strategy, result.source) == (Strategy.CHECK_IN, "low_confidence")


def test_default_listens_unless_current_turn_indicates_high_stress() -> None:
    assert choose_strategy(analysis()).strategy == Strategy.LISTEN
    result = choose_strategy(analysis(stress="HIGH"))
    assert (result.strategy, result.source) == (Strategy.GROUND, "current_turn_state")


def test_strategy_is_reselected_from_each_turn_without_previous_preference_or_state() -> None:
    listen = choose_strategy(analysis("listen", True))
    ordinary_turn = choose_strategy(analysis())
    problem_solving = choose_strategy(analysis("problem_solve", True))

    assert [listen.strategy, ordinary_turn.strategy, problem_solving.strategy] == [
        Strategy.LISTEN,
        Strategy.LISTEN,
        Strategy.PROBLEM_SOLVE,
    ]


def test_clarify_and_check_in_clear_when_current_turn_is_clear() -> None:
    clarify = choose_strategy(analysis(needs_clarification=True))
    recovered = choose_strategy(analysis())
    check_in = choose_strategy(analysis(confidence=0.54))
    clear_after_check_in = choose_strategy(analysis(confidence=0.9))

    assert clarify.strategy == Strategy.CLARIFY
    assert recovered.strategy == Strategy.LISTEN
    assert check_in.strategy == Strategy.CHECK_IN
    assert clear_after_check_in.strategy == Strategy.LISTEN
