import asyncio
import json
import logging
import os
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
    llm as livekit_llm,
)

if __package__:
    from .acoustics import AcousticAudioInput
    from .conversation.state import ConversationState, analyze_state, fuse_state, merge_state
    from .conversation.strategy import choose_strategy, generate_response_instructions, update_turn_instructions
    from .metrics import TurnMetrics, sanitize_diagnostic_message
    from .metric_trace import stamp_metric_publish, finish_metric_publish
    from .providers import create_classifier, create_llm, create_stt, create_tts, create_turn_detector, create_vad
else:
    # The documented `python src/agent.py dev` entrypoint runs this as a script.
    from acoustics import AcousticAudioInput
    from conversation.state import ConversationState, analyze_state, fuse_state, merge_state
    from conversation.strategy import choose_strategy, generate_response_instructions, update_turn_instructions
    from metrics import TurnMetrics, sanitize_diagnostic_message
    from metric_trace import stamp_metric_publish, finish_metric_publish
    from providers import create_classifier, create_llm, create_stt, create_tts, create_turn_detector, create_vad

load_dotenv(Path(__file__).resolve().parents[1] / ".env.local")

logger = logging.getLogger("voice_companion.agent")
# Bound the idle pool and allow cold imports/prewarm on Render's shared CPU.
server = AgentServer(num_idle_processes=1, initialize_process_timeout=60.0)

COMPANION_INSTRUCTIONS = """
You are a warm, general emotional-support companion. Listen carefully and reply
naturally in one or two concise sentences. You are not a therapist, do not
diagnose, and do not present your responses as medical or clinical advice.
""".strip()

ENDPOINTING_MODE = "dynamic"
MIN_ENDPOINTING_DELAY_SECONDS = 0.5
MAX_ENDPOINTING_DELAY_SECONDS = 1.2
PREEMPTIVE_GENERATION_ENABLED = False


def prewarm(process: JobProcess) -> None:
    # Silero loads an ONNX model, so do it before the worker accepts a room job.
    started = time.perf_counter()
    logger.info("Silero VAD prewarm started pid=%s", os.getpid())
    try:
        process.userdata["vad"] = create_vad()
    except Exception:
        logger.exception("Silero VAD prewarm failed pid=%s", os.getpid())
        raise
    logger.info(
        "Silero VAD prewarm completed pid=%s duration_seconds=%.3f",
        os.getpid(), time.perf_counter() - started,
    )


server.setup_fnc = prewarm


@server.on("worker_started")
def on_worker_started() -> None:
    logger.info("agent worker started idle_processes=1 initialize_timeout_seconds=60")


@server.on("worker_registered")
def on_worker_registered(worker_id: str, server_info: object) -> None:
    logger.info("LiveKit worker registered agent_name=companion-agent")


@server.rtc_session(agent_name="companion-agent")
async def companion_agent(ctx: JobContext) -> None:
    room_name = ctx.room.name
    logger.info("agent assigned to room %s", room_name)
    browser_disconnected = asyncio.Event()
    closing = False

    async def publish_diagnostic(message: dict[str, object]) -> None:
        if closing:
            return
        traces = stamp_metric_publish(message, room_name)
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
            finish_metric_publish(traces, "returned")
        except Exception:
            finish_metric_publish(traces, "failed")
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
        main_llm = create_llm(llm_model)
        tts = create_tts()
        turn_detector = create_turn_detector()
        session = AgentSession(
            stt=create_stt(),
            vad=ctx.proc.userdata["vad"],
            llm=main_llm,
            tts=tts,
            turn_handling={
                "turn_detection": turn_detector,
                "interruption": {"mode": "adaptive"},
                "endpointing": {
                    "mode": ENDPOINTING_MODE,
                    "min_delay": MIN_ENDPOINTING_DELAY_SECONDS,
                    "max_delay": MAX_ENDPOINTING_DELAY_SECONDS,
                    "alpha": 0.7,
                },
                "preemptive_generation": {
                    "enabled": PREEMPTIVE_GENERATION_ENABLED
                },
            },
            transcription_timeout=5.0,
        )
        jev_client_creation_started = time.perf_counter()
        jev_client = create_classifier()
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

    logger.info(
        "Jev client ready room=%s creation_seconds=%.3f",
        room_name, time.perf_counter() - jev_client_creation_started,
    )
    metrics = TurnMetrics(session, main_llm, tts, publish_diagnostic, session_id=room_name)
    llm_http_client = getattr(getattr(main_llm, "_client", None), "_client", None)
    if isinstance(llm_http_client, httpx.AsyncClient):
        llm_http_client.event_hooks["request"].append(metrics.on_llm_http_request)
    else:
        logger.warning("main LLM HTTP request hook unavailable room=%s", room_name)
    acoustic_input: AcousticAudioInput | None = None
    conversation_state = ConversationState()
    next_state_turn_sequence = 0
    speech_generation = 0
    agent_is_speaking = False
    overlapping_user_speech_started_at: float | None = None
    interrupted_speech_id: str | None = None
    strategy_instruction_id: str | None = None

    class StrategyAgent(Agent):
        async def llm_node(
            self, chat_ctx: livekit_llm.ChatContext, tools: list[livekit_llm.Tool],
            model_settings: object,
        ):
            # The SDK starts its native TTFT just before entering this node.
            # Inspect only scalar context sizes; keep its streaming path intact.
            metrics.record_llm_node_entry(chat_ctx)
            async for chunk in super().llm_node(chat_ctx, tools, model_settings):
                yield chunk

        async def on_user_turn_completed(
            self, turn_ctx: livekit_llm.ChatContext, new_message: livekit_llm.ChatMessage
        ) -> None:
            nonlocal conversation_state, next_state_turn_sequence, strategy_instruction_id
            hook_started = time.perf_counter()
            transcript = new_message.text_content.strip()
            if not transcript:
                return

            # ChatContext persists: remove the previous turn's instruction first.
            strategy_instruction_id = update_turn_instructions(
                turn_ctx, strategy_instruction_id, None
            )
            next_state_turn_sequence += 1
            turn_sequence = next_state_turn_sequence
            item_id = new_message.id
            timings: dict[str, float] = {}
            audio_metrics = None
            if acoustic_input is not None:
                finalization_started = time.perf_counter()
                try:
                    audio_metrics = acoustic_input.finish_turn(transcript)
                except Exception:
                    acoustic_input.disabled = True
                    logger.exception("acoustic turn analysis disabled room=%s", room_name)
                timings["feature_finalization_seconds"] = time.perf_counter() - finalization_started
            # Classify the committed turn before LiveKit starts its main LLM response.
            turn_speech_generation = speech_generation
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
                    jev_client,
                    audio_metrics,
                    timings,
                )
            except asyncio.CancelledError:
                raise
            except Exception as error:
                timings["state_analysis_seconds"] = time.perf_counter() - analysis_started
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
                analysis = None
            else:
                timings["state_analysis_seconds"] = time.perf_counter() - analysis_started

            if analysis is not None:
                if turn_speech_generation != speech_generation:
                    await publish_diagnostic({
                        "type": "state_result_ignored",
                        "item_id": item_id,
                        "turn_sequence": turn_sequence,
                        "reason": "new_user_speech",
                    })
                else:
                    state_update_started = time.perf_counter()
                    fusion = fuse_state(transcript, analysis, audio_metrics)
                    merged = merge_state(conversation_state, fusion.state, turn_sequence)
                    if merged is not None:
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
                    timings["state_update_seconds"] = time.perf_counter() - state_update_started

                    if merged is not None:
                        strategy_started = time.perf_counter()
                        decision = choose_strategy(replace(
                            analysis, state=fusion.state, confidence=fusion.confidence,
                            acoustic_clarification_hint=fusion.clarification_hint,
                        ))
                        timings["strategy_selection_seconds"] = time.perf_counter() - strategy_started
                        strategy_ready_at = time.perf_counter()
                        await publish_diagnostic({
                            "type": "strategy_selected",
                            "item_id": item_id,
                            "turn_sequence": turn_sequence,
                            "strategy": decision.strategy.value,
                        })

                        preparation_started = time.perf_counter()
                        strategy_instruction_id = update_turn_instructions(
                            turn_ctx, strategy_instruction_id,
                            generate_response_instructions(
                                transcript, fusion.state, decision.strategy
                            ),
                        )
                        preparation_seconds = time.perf_counter() - preparation_started
                        metrics.record_llm_preparation(
                            item_id, strategy_ready_at, preparation_seconds,
                        )
                        logger.info(
                            "TURN %s LLM request prep: %.1f ms; client setup: reused",
                            turn_sequence, preparation_seconds * 1000,
                        )
            timings["turn_hook_seconds"] = time.perf_counter() - hook_started
            metrics.record_agent_logic(item_id)
            await publish_diagnostic({
                "type": "agent_logic_metrics", "user_item_id": item_id,
                "turn_sequence": turn_sequence, "metrics": timings,
            })
            logger.info("agent_logic_metrics published room=%s turn=%s user_item=%s seconds=%s",
                        room_name, turn_sequence, item_id, timings)

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
        native_received_at = time.perf_counter()
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

        metrics.trace_assistant_item(item, native_received_at)

        def publish_assistant_item() -> None:
            # The SDK adds the item to SpeechHandle just after emitting this event.
            owner = metrics.speech_owner(item)
            metrics.trace_item_owner(item, owner)
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

    try:
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

        await browser_disconnected.wait()
        logger.info("browser disconnected from room %s", room_name)
    finally:
        closing = True
        if isinstance(llm_http_client, httpx.AsyncClient):
            llm_http_client.event_hooks["request"].remove(metrics.on_llm_http_request)
        metrics.close()
        try:
            # Wait for LiveKit to interrupt speech and detach room I/O before ending the job.
            await session.aclose()
        finally:
            await jev_client.aclose()
        ctx.shutdown(reason="browser disconnected")


if __name__ == "__main__":
    cli.run_app(server)
