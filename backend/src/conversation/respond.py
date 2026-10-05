from .state import TurnState
from .strategy import Strategy
from livekit.agents import llm


STRATEGY_INSTRUCTIONS = {
    Strategy.LISTEN: (
        "Acknowledge the user's words reflectively and briefly. Let them continue. "
        "Do not give unsolicited advice, numbered steps, or switch to problem-solving."
    ),
    Strategy.CLARIFY: (
        "Ask one specific, useful, concise clarifying question. Do not assume what "
        "the user means or try to solve the whole situation yet."
    ),
    Strategy.ENCOURAGE: (
        "Acknowledge the difficulty first. Offer realistic encouragement grounded "
        "in the user's words; avoid exaggerated positivity and guarantees."
    ),
    Strategy.PROBLEM_SOLVE: (
        "Offer concise, concrete help, preferably one to three useful steps or "
        "options. State assumptions when needed and avoid a long checklist."
    ),
    Strategy.GROUND: (
        "Use calm, short sentences and offer one simple immediate action at a time. "
        "Do not diagnose or overwhelm the user with explanation."
    ),
    Strategy.CHECK_IN: (
        "Reflect a possible interpretation tentatively and ask whether it is close. "
        "Communicate uncertainty naturally; do not state inferred feelings as facts."
    ),
}


def generate_response_instructions(
    transcript: str, state: TurnState, strategy: Strategy
) -> str:
    state_context = ", ".join(
        f"{dimension}={getattr(state, dimension).choice}"
        for dimension in ("energy", "stress", "frustration", "sentiment")
    )
    return (
        "Generate wording for the current user turn. You are a supportive, "
        "non-clinical conversational companion. Do not diagnose or present "
        "inferred state as certain truth. Keep the spoken response to one to "
        "three short sentences and leave room for the user to speak. The user's "
        "explicit words take priority over inferred state.\n\n"
        f"CURRENT STRATEGY (internal control; never say its label aloud): {strategy.value}\n"
        f"STRATEGY RULES: {STRATEGY_INSTRUCTIONS[strategy]}\n"
        f"CURRENT TURN STATE (context only; UNKNOWN means no new evidence): {state_context}\n"
        f"CURRENT USER MESSAGE: {transcript}"
    )


def update_turn_instructions(
    turn_ctx: llm.ChatContext,
    previous_message_id: str | None,
    instructions: str | None,
) -> str | None:
    """Remove the prior turn's control message and optionally add this turn's."""
    if previous_message_id is not None and turn_ctx.get_by_id(previous_message_id) is not None:
        turn_ctx.remove(previous_message_id)
    if instructions is None:
        return None
    return turn_ctx.add_message(role="system", content=instructions).id
