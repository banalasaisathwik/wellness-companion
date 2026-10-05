from dataclasses import dataclass
from enum import StrEnum

from .state import TurnAnalysis


class Strategy(StrEnum):
    LISTEN = "LISTEN"
    CLARIFY = "CLARIFY"
    ENCOURAGE = "ENCOURAGE"
    PROBLEM_SOLVE = "PROBLEM_SOLVE"
    GROUND = "GROUND"
    CHECK_IN = "CHECK_IN"


@dataclass(frozen=True)
class StrategyDecision:
    strategy: Strategy
    source: str
    reason: str


PREFERENCE_STRATEGIES = {
    "listen": Strategy.LISTEN,
    "clarify": Strategy.CLARIFY,
    "encourage": Strategy.ENCOURAGE,
    "problem_solve": Strategy.PROBLEM_SOLVE,
    "ground": Strategy.GROUND,
    "check_in": Strategy.CHECK_IN,
}
LOW_CONFIDENCE_THRESHOLD = 0.55


def choose_strategy(analysis: TurnAnalysis) -> StrategyDecision:
    if analysis.preference_is_explicit and analysis.response_preference in PREFERENCE_STRATEGIES:
        strategy = PREFERENCE_STRATEGIES[analysis.response_preference]
        return StrategyDecision(strategy, "explicit_request", f"User asked for {analysis.response_preference.replace('_', ' ')}.")

    if analysis.needs_clarification:
        return StrategyDecision(Strategy.CLARIFY, "clarification", "User indicated the prior response missed their meaning.")

    if analysis.acoustic_clarification_hint:
        return StrategyDecision(Strategy.CLARIFY, "uncertain_delivery", "Text is uncertain and delivery differs from baseline; ask without assuming a feeling.")

    if analysis.confidence < LOW_CONFIDENCE_THRESHOLD:
        return StrategyDecision(Strategy.CHECK_IN, "low_confidence", "State interpretation is uncertain; check with the user.")

    if analysis.state.stress.choice == "HIGH":
        return StrategyDecision(Strategy.GROUND, "current_turn_state", "High stress was expressed; offer a grounding response.")

    return StrategyDecision(Strategy.LISTEN, "default", "Listen and let the user guide the conversation.")
