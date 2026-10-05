import asyncio
import json
import logging
import os
import re
import time
from dataclasses import replace
from pathlib import Path

import httpx
from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    JobProcess,
    cli,
    inference,
    llm as livekit_llm,
)
from livekit.plugins import openai, silero

if __package__:
    from .acoustics import AcousticAudioInput
    from .conversation.analyze import analyze_state
    from .conversation.state import ConversationState, TurnState, fuse_state, merge_state
    from .conversation.strategy import StrategyDecision, choose_strategy
    from .conversation.respond import generate_response_instructions, update_turn_instructions
    from .metrics import TurnMetrics
else:
    # The documented `python src/agent.py dev` entrypoint runs this as a script.
    from acoustics import AcousticAudioInput
    from conversation.analyze import analyze_state
    from conversation.state import ConversationState, TurnState, fuse_state, merge_state
    from conversation.strategy import StrategyDecision, choose_strategy
    from conversation.respond import generate_response_instructions, update_turn_instructions
    from metrics import TurnMetrics

load_dotenv(Path(__file__).resolve().parents[1] / ".env.local")

logger = logging.getLogger("voice_companion.agent")
server = AgentServer()

COMPANION_INSTRUCTIONS = """
You are a warm, general emotional-support companion. Listen carefully and reply
naturally in one or two concise sentences. You are not a therapist, do not
diagnose, and do not present your responses as medical or clinical advice.
""".strip()

VAD_MIN_SILENCE_SECONDS = 0.55
ENDPOINTING_MODE = "fixed"
MIN_ENDPOINTING_DELAY_SECONDS = 0.5
MAX_ENDPOINTING_DELAY_SECONDS = 3.0
PREEMPTIVE_GENERATION_ENABLED = False


def prewarm(process: JobProcess) -> None:
    # Silero loads an ONNX model, so do it before the worker accepts a room job.
    process.userdata["vad"] = silero.VAD.load(
        min_silence_duration=VAD_MIN_SILENCE_SECONDS
    )


server.setup_fnc = prewarm


def sanitize_diagnostic_message(message: str) -> str:
    return re.sub(
        r"(?i)(api[_ -]?key|authorization|token)\s*[=:]\s*\S+",
        r"\1=[redacted]",
        message,
    )[:300]


@server.rtc_session(agent_name="companion-agent")
async def companion_agent(ctx: JobContext) -> None:
    room_name = ctx.room.name
    logger.info("agent assigned to room %s", room_name)
    browser_disconnected = asyncio.Event()
    closing = False

    async def publish_diagnostic(message: dict[str, object]) -> None:
        if closing:
            return
        try:
            await ctx.room.local_participant.publish_data(
                json.dumps(
                    {
                        **message,
                        "session_id": room_name,
                    },
                    separators=(",", ":"),
                ),
                reliable=True,
                topic="session_diagnostics",
            )
        except Exception:
            logger.exception("session diagnostic publish failed room=%s", room_name)

    @ctx.room.on("participant_disconnected")
    def on_participant_disconnected(_: object) -> None:
        browser_disconnected.set()

    missing_configuration = [
        name for name in ("OPENROUTER_API_KEY", "LLM_MODEL") if not os.getenv(name)
    ]

    await ctx.connect()

    if missing_configuration:
        await publish_diagnostic(
            {
                "type": "session_error",
                "source": "configuration",
                "message": f"Missing required backend configuration: {', '.join(missing_configuration)}.",
            }
        )
        await browser_disconnected.wait()
        ctx.shutdown(reason="voice pipeline configuration error")
        return

    try:
        llm_model = os.environ["LLM_MODEL"]
        llm = openai.LLM.with_openrouter(model=llm_model)
        tts = inference.TTS(
            model="cartesia/sonic-3",
            voice="9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
            language="en",
        )
        turn_detector = inference.TurnDetector()
        session = AgentSession(
            stt=inference.STT(model="assemblyai/universal-streaming", language="en"),
            vad=ctx.proc.userdata["vad"],
            llm=llm,
            tts=tts,
            turn_handling={
                "turn_detection": turn_detector,
                "interruption": {"mode": "adaptive"},
                "endpointing": {
                    "mode": ENDPOINTING_MODE,
                    "min_delay": MIN_ENDPOINTING_DELAY_SECONDS,
                    "max_delay": MAX_ENDPOINTING_DELAY_SECONDS,
                },
                "preemptive_generation": {
                    "enabled": PREEMPTIVE_GENERATION_ENABLED
                },
            },
            transcription_timeout=5.0,
        )
    except (KeyError, ValueError) as error:
        await publish_diagnostic(
            {
                "type": "session_error",
                "source": "configuration",
                "message": sanitize_diagnostic_message(str(error)),
            }
        )
        await browser_disconnected.wait()
        ctx.shutdown(reason="voice pipeline configuration error")
        return

    metrics = TurnMetrics(session, llm, tts, publish_diagnostic)
    acoustic_input: AcousticAudioInput | None = None
    conversation_state = ConversationState()
    next_state_turn_sequence = 0
    speech_generation = 0
    agent_is_speaking = False
    overlapping_user_speech_started_at: float | None = None
    interrupted_speech_id: str | None = None
    strategy_instruction_id: str | None = None

    async def analyze_user_turn(
        transcript: str, item_id: str, turn_sequence: int,
        audio_metrics: dict[str, object] | None, turn_speech_generation: int,
    ) -> tuple[StrategyDecision, TurnState] | None:
        nonlocal conversation_state
        await publish_diagnostic({
            "type": "state_analysis_started",
            "item_id": item_id,
            "turn_sequence": turn_sequence,
        })
        analysis_started = time.perf_counter()
        try:
            analysis = await analyze_state(
                transcript,
                os.environ["OPENROUTER_API_KEY"],
                os.getenv("JEV_MODEL", "typesafe/jev-1.13"),
                audio_metrics,
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            metrics.record_agent_logic(item_id, time.perf_counter() - analysis_started, None)
            if isinstance(error, (httpx.TimeoutException, TimeoutError)):
                reason = "Jev request timed out"
            elif isinstance(error, httpx.HTTPStatusError):
                reason = f"Jev HTTP {error.response.status_code}"
            elif isinstance(error, ValueError):
                reason = "Invalid Jev response"
            else:
                reason = "Jev request failed"
            logger.warning(
                "state analysis failed room=%s item=%s error_type=%s reason=%s",
                room_name, item_id, type(error).__name__, reason,
            )
            await publish_diagnostic({
                "type": "state_analysis_failed",
                "item_id": item_id,
                "turn_sequence": turn_sequence,
                "message": reason,
            })
            return None

        state_analysis_seconds = time.perf_counter() - analysis_started
        if turn_speech_generation != speech_generation:
            metrics.record_agent_logic(item_id, state_analysis_seconds, None)
            await publish_diagnostic({
                "type": "state_result_ignored",
                "item_id": item_id,
                "turn_sequence": turn_sequence,
                "reason": "new_user_speech",
            })
            return None
        fusion = fuse_state(transcript, analysis, audio_metrics)
        merged = merge_state(conversation_state, fusion.state, turn_sequence)
        if merged is None:
            metrics.record_agent_logic(item_id, state_analysis_seconds, None)
            return None
        conversation_state, _ = merged
        await publish_diagnostic({
            "type": "conversation_state_updated",
            "item_id": item_id,
            "turn_sequence": turn_sequence,
            "conversation_state": {
                dimension: getattr(conversation_state, dimension)
                for dimension in ("energy", "stress", "frustration", "sentiment")
            },
            "turn_state": {
                dimension: getattr(fusion.state, dimension).choice
                for dimension in ("energy", "stress", "frustration", "sentiment")
            },
            "confidence": fusion.confidence,
            "fusion_result": fusion.result,
        })
        strategy_started = time.perf_counter()
        decision = choose_strategy(replace(
            analysis, state=fusion.state, confidence=fusion.confidence,
            acoustic_clarification_hint=fusion.clarification_hint,
        ))
        metrics.record_agent_logic(
            item_id, state_analysis_seconds, time.perf_counter() - strategy_started,
        )
        await publish_diagnostic({
            "type": "strategy_selected",
            "item_id": item_id,
            "turn_sequence": turn_sequence,
            "strategy": decision.strategy.value,
        })
        return decision, fusion.state

    class StrategyAgent(Agent):
        async def on_user_turn_completed(
            self, turn_ctx: livekit_llm.ChatContext, new_message: livekit_llm.ChatMessage
        ) -> None:
            nonlocal next_state_turn_sequence, strategy_instruction_id
            transcript = new_message.text_content
            if not transcript.strip():
                return

            # ChatContext persists: remove the previous turn's instruction first.
            strategy_instruction_id = update_turn_instructions(
                turn_ctx, strategy_instruction_id, None
            )
            next_state_turn_sequence += 1
            item_id = new_message.id
            audio_metrics = None
            if acoustic_input is not None:
                try:
                    audio_metrics = acoustic_input.finish_turn(transcript.strip())
                except Exception:
                    acoustic_input.disabled = True
                    logger.exception("acoustic turn analysis disabled room=%s", room_name)
            result = await analyze_user_turn(
                transcript.strip(), item_id, next_state_turn_sequence, audio_metrics,
                speech_generation,
            )
            if result is None:
                return
            decision, current_turn_state = result
            strategy_instruction_id = update_turn_instructions(
                turn_ctx, strategy_instruction_id,
                generate_response_instructions(
                    transcript.strip(), current_turn_state, decision.strategy
                ),
            )

    @session.on("user_state_changed")
    def on_user_state_changed(event: object) -> None:
        nonlocal overlapping_user_speech_started_at, interrupted_speech_id, speech_generation
        state = getattr(event, "new_state", "unknown")
        if state == "speaking":
            speech_generation += 1
            if acoustic_input is not None:
                acoustic_input.speech_started()
            if agent_is_speaking:
                overlapping_user_speech_started_at = time.monotonic()
                interrupted_speech_id = next(reversed(metrics.handles), None)
        elif state == "listening":
            if acoustic_input is not None:
                acoustic_input.speech_ended()
            if getattr(event, "old_state", None) == "speaking":
                metrics.user_speech_ended(getattr(event, "created_at", None))
        asyncio.create_task(publish_diagnostic({"type": "user_state_changed", "state": state}))

    @session.on("user_input_transcribed")
    def on_user_input_transcribed(event: object) -> None:
        if acoustic_input is not None:
            acoustic_input.update_transcript(
                getattr(event, "transcript", ""), getattr(event, "is_final", False)
            )

    @session.on("agent_state_changed")
    def on_agent_state_changed(event: object) -> None:
        nonlocal agent_is_speaking, overlapping_user_speech_started_at, interrupted_speech_id
        state = getattr(event, "new_state", "unknown")
        if agent_is_speaking and state != "speaking":
            if overlapping_user_speech_started_at is not None and interrupted_speech_id is not None:
                metrics.record_barge_in(interrupted_speech_id, max(
                    time.monotonic() - overlapping_user_speech_started_at, 0.0
                ))
            overlapping_user_speech_started_at = None
            interrupted_speech_id = None
        agent_is_speaking = state == "speaking"
        if agent_is_speaking:
            metrics.agent_speech_started(getattr(event, "created_at", None))
        asyncio.create_task(publish_diagnostic({"type": "agent_state_changed", "state": state}))

    @session.on("conversation_item_added")
    def on_conversation_item_added(event: object) -> None:
        item = getattr(event, "item", None)
        role = getattr(item, "role", None)
        if role not in ("user", "assistant"):
            return
        text = getattr(item, "raw_text_content", "")
        item_id = getattr(item, "id", None)
        if role == "user":
            metrics.user_item_added(item)
            asyncio.create_task(publish_diagnostic({
                "type": "conversation_item_added", "item_id": item_id, "role": role,
            }))
            return

        def publish_assistant_item() -> None:
            # The SDK adds the item to SpeechHandle just after emitting this event.
            owner = metrics.speech_owner(item)
            asyncio.create_task(publish_diagnostic({
                "type": "conversation_item_added",
                "item_id": item_id,
                "speech_id": owner,
                "turn_sequence": metrics.sequences.get(owner) if owner else None,
                "role": role,
                "text": text if isinstance(text, str) else "",
                "interrupted": getattr(item, "interrupted", False),
            }))

        asyncio.get_running_loop().call_soon(publish_assistant_item)

    @session.on("error")
    def on_session_error(event: object) -> None:
        source = getattr(event, "source", None)
        source_name = getattr(source, "provider", None) or type(source).__name__
        error = getattr(event, "error", None)
        logger.error("agent session error room=%s source=%s", room_name, source_name)
        asyncio.create_task(
            publish_diagnostic(
                {
                    "type": "session_error",
                    "source": source_name,
                    "message": sanitize_diagnostic_message(str(error)),
                }
            )
        )

    metrics.start()
    await session.start(
        StrategyAgent(instructions=COMPANION_INSTRUCTIONS), room=ctx.room, record=False
    )
    if session.input.audio is not None:
        acoustic_input = AcousticAudioInput(session.input.audio)
        session.input.audio = acoustic_input
    logger.info("voice pipeline ready room=%s llm_model=%s", room_name, llm_model)
    await publish_diagnostic({
        "type": "session_started",
        "stt_model": "assemblyai/universal-streaming",
        "llm_model": llm_model,
        "tts_model": "cartesia/sonic-3",
    })

    if not ctx.room.remote_participants:
        browser_disconnected.set()

    try:
        await browser_disconnected.wait()
        logger.info("browser disconnected from room %s", room_name)
    finally:
        closing = True
        metrics.close()
        # Wait for LiveKit to interrupt speech and detach room I/O before ending the job.
        await session.aclose()
        ctx.shutdown(reason="browser disconnected")


if __name__ == "__main__":
    cli.run_app(server)
