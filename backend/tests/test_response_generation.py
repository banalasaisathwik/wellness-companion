from livekit.agents import llm

from src.conversation.respond import STRATEGY_INSTRUCTIONS, generate_response_instructions, update_turn_instructions
from src.conversation.state import ChoiceResult, TurnAnalysis, TurnState
from src.conversation.strategy import Strategy
from src.conversation.strategy import choose_strategy


def test_every_strategy_has_a_generation_instruction() -> None:
    high_stress = TurnState(
        ChoiceResult("UNKNOWN", 0.9, {}), ChoiceResult("HIGH", 0.9, {}),
        ChoiceResult("UNKNOWN", 0.9, {}), ChoiceResult("UNKNOWN", 0.9, {}),
    )
    assert set(STRATEGY_INSTRUCTIONS) == set(Strategy)
    for strategy, instruction in STRATEGY_INSTRUCTIONS.items():
        prompt = generate_response_instructions(
            "I need help with this.", high_stress, strategy
        )
        assert strategy.value in prompt
        assert instruction in prompt
        assert "stress=HIGH" in prompt
        assert "I need help with this." in prompt


def test_listen_instruction_resists_problem_solving_even_with_high_stress() -> None:
    high_stress = TurnState(
        ChoiceResult("UNKNOWN", 0.9, {}), ChoiceResult("HIGH", 0.9, {}),
        ChoiceResult("UNKNOWN", 0.9, {}), ChoiceResult("UNKNOWN", 0.9, {}),
    )
    prompt = generate_response_instructions(
        "I'm stressed, but just listen.",
        high_stress,
        Strategy.LISTEN,
    )
    assert "Do not give unsolicited advice" in prompt
    assert "CURRENT STRATEGY (internal control; never say its label aloud): LISTEN" in prompt


def test_clarify_and_check_in_require_questions_and_uncertainty() -> None:
    clarify = STRATEGY_INSTRUCTIONS[Strategy.CLARIFY]
    check_in = STRATEGY_INSTRUCTIONS[Strategy.CHECK_IN]
    assert "clarifying question" in clarify
    assert "tentatively" in check_in
    assert "do not state inferred feelings as facts" in check_in


def test_response_instructions_follow_each_turns_strategy_transition() -> None:
    unknown = ChoiceResult("UNKNOWN", 0.9, {})
    turn_state = TurnState(unknown, unknown, unknown, unknown)
    listen_analysis = TurnAnalysis(turn_state, "listen", True, False, 0.9)
    solve_analysis = TurnAnalysis(turn_state, "problem_solve", True, False, 0.9)

    listen_prompt = generate_response_instructions(
        "I just need to vent.", turn_state, choose_strategy(listen_analysis).strategy
    )
    solve_prompt = generate_response_instructions(
        "What should I do now?", turn_state, choose_strategy(solve_analysis).strategy
    )

    assert "CURRENT STRATEGY (internal control; never say its label aloud): LISTEN" in listen_prompt
    assert "Do not give unsolicited advice" in listen_prompt
    assert "CURRENT STRATEGY (internal control; never say its label aloud): PROBLEM_SOLVE" in solve_prompt
    assert "one to three useful steps or options" in solve_prompt
    assert "CURRENT TURN STATE (context only; UNKNOWN means no new evidence)" in solve_prompt


def test_only_the_current_turn_instruction_remains_in_chat_context() -> None:
    turn_ctx = llm.ChatContext.empty()
    first_id = update_turn_instructions(turn_ctx, None, "CURRENT STRATEGY: LISTEN")
    assert first_id is not None

    second_id = update_turn_instructions(turn_ctx, first_id, "CURRENT STRATEGY: PROBLEM_SOLVE")

    assert second_id is not None and second_id != first_id
    assert [message.text_content for message in turn_ctx.messages()] == [
        "CURRENT STRATEGY: PROBLEM_SOLVE"
    ]
    assert update_turn_instructions(turn_ctx, second_id, None) is None
    assert turn_ctx.messages() == []
