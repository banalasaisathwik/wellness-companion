import asyncio
import json
import logging
import os
import re
import time
from pathlib import Path

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    JobProcess,
    cli,
    inference,
)
from livekit.plugins import openai, silero

load_dotenv(Path(__file__).resolve().parents[1] / ".env.local")

logger = logging.getLogger("voice_companion.agent")
server = AgentServer()

COMPANION_INSTRUCTIONS = """
You are a warm, general emotional-support companion. Listen carefully and reply
naturally in one or two concise sentences. You are not a therapist, do not
diagnose, and do not present your responses as medical or clinical advice.
""".strip()

VAD_MIN_SILENCE_SECONDS = 0.55
TURN_DETECTION_NAME = "LiveKit TurnDetector"
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


def conversation_metrics(item: object) -> dict[str, float]:
    metrics = getattr(item, "metrics", {})
    if not isinstance(metrics, dict):
        return {}

    return {
        name: value
        for name, value in metrics.items()
        if name in {"llm_node_ttft", "tts_node_ttfb", "e2e_latency"}
        and isinstance(value, (int, float))
        and not isinstance(value, bool)
        and value >= 0
    }


def user_turn_metrics(item: object) -> dict[str, float]:
    metrics = getattr(item, "metrics", {})
    if not isinstance(metrics, dict):
        return {}

    result: dict[str, float] = {}
    started_speaking_at = metrics.get("started_speaking_at")
    stopped_speaking_at = metrics.get("stopped_speaking_at")
    if (
        isinstance(started_speaking_at, (int, float))
        and not isinstance(started_speaking_at, bool)
        and isinstance(stopped_speaking_at, (int, float))
        and not isinstance(stopped_speaking_at, bool)
        and stopped_speaking_at >= started_speaking_at
    ):
        result["speech_span_seconds"] = stopped_speaking_at - started_speaking_at

    for source_name, result_name in (
        ("end_of_turn_delay", "speech_end_to_turn_decision_seconds"),
        ("transcription_delay", "speech_end_to_final_transcript_seconds"),
    ):
        value = metrics.get(source_name)
        if (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and value >= 0
        ):
            result[result_name] = value

    return result


def session_usage(usage: object) -> list[dict[str, object]]:
    usage_items = getattr(usage, "model_usage", [])
    if not isinstance(usage_items, list):
        return []

    return [
        {
            "type": getattr(item, "type", "unknown"),
            "provider": getattr(item, "provider", ""),
            "model": getattr(item, "model", ""),
            "input_tokens": getattr(item, "input_tokens", 0),
            "output_tokens": getattr(item, "output_tokens", 0),
            "characters_count": getattr(item, "characters_count", 0),
            "audio_duration": getattr(item, "audio_duration", 0.0),
        }
        for item in usage_items
    ]


def find_speech_owner(item: object, speech_handles: dict[str, object]) -> str | None:
    for speech_id, handle in speech_handles.items():
        if any(chat_item is item for chat_item in getattr(handle, "chat_items", [])):
            return speech_id
    return None


@server.rtc_session(agent_name="companion-agent")
async def companion_agent(ctx: JobContext) -> None:
    room_name = ctx.room.name
    logger.info("agent assigned to room %s", room_name)
    browser_disconnected = asyncio.Event()
    session_clock_started_at = time.monotonic()
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
                        "session_elapsed_seconds": time.monotonic()
                        - session_clock_started_at,
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
        await publish_diagnostic(
            {"type": "session_closed", "reason": "configuration_error"}
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
        await publish_diagnostic(
            {"type": "session_closed", "reason": "configuration_error"}
        )
        await browser_disconnected.wait()
        ctx.shutdown(reason="voice pipeline configuration error")
        return

    turn_metric_totals: dict[str, dict[str, float]] = {}
    turn_item_ids_by_speech_id: dict[str, str] = {}
    turn_sequences_by_speech_id: dict[str, int] = {}
    speech_handles_by_id: dict[str, object] = {}
    completed_speech_ids: set[str] = set()
    next_turn_sequence = 0
    user_turn_committed_at: float | None = None
    agent_is_speaking = False
    overlapping_user_speech_started_at: float | None = None

    async def publish_correlated_turn_metrics(
        speech_id: str, metrics: dict[str, float]
    ) -> None:
        item_id = turn_item_ids_by_speech_id.get(speech_id)
        turn_sequence = turn_sequences_by_speech_id.get(speech_id)
        if item_id is None or turn_sequence is None:
            return

        await publish_diagnostic(
            {
                "type": "turn_metrics",
                "speech_id": speech_id,
                "item_id": item_id,
                "turn_sequence": turn_sequence,
                "completed": speech_id in completed_speech_ids,
                **metrics,
            }
        )

    async def publish_uncorrelated_provider_metrics(speech_id: str) -> None:
        totals = turn_metric_totals.get(speech_id, {})
        values: dict[str, float] = {}
        for total_name, metric_name in (
            ("llm_duration", "llm_duration_seconds"),
            ("llm_first_token", "llm_first_token_seconds"),
            ("tts_duration", "tts_duration_seconds"),
            ("tts_first_audio", "tts_first_audio_seconds"),
        ):
            if total_name in totals:
                values[metric_name] = totals[total_name]
        if values:
            await publish_diagnostic(
                {
                    "type": "provider_metric",
                    "metric_type": "turn_metrics_unmatched",
                    "speech_id": speech_id,
                    **values,
                }
            )

    def record_plugin_metrics(metrics: object, metric_type: str) -> None:
        if closing:
            return
        speech_id = getattr(metrics, "speech_id", None)
        if getattr(metrics, "cancelled", False):
            return

        duration = getattr(metrics, "duration", None)
        first_audio = getattr(metrics, "ttft" if metric_type == "llm" else "ttfb", None)
        valid_duration = (
            float(duration)
            if isinstance(duration, (int, float))
            and not isinstance(duration, bool)
            and duration >= 0
            else None
        )
        valid_first_audio = (
            float(first_audio)
            if isinstance(first_audio, (int, float))
            and not isinstance(first_audio, bool)
            and first_audio >= 0
            else None
        )
        duration_name = f"{metric_type}_duration_seconds"
        first_audio_name = (
            "llm_first_token_seconds"
            if metric_type == "llm"
            else "tts_first_audio_seconds"
        )

        if not isinstance(speech_id, str) or speech_id not in turn_sequences_by_speech_id:
            values: dict[str, float] = {}
            if valid_duration is not None:
                values[duration_name] = valid_duration
            if valid_first_audio is not None:
                values[first_audio_name] = valid_first_audio
            if values:
                asyncio.create_task(
                    publish_diagnostic(
                        {
                            "type": "provider_metric",
                            "metric_type": f"{metric_type}_metrics",
                            "speech_id": speech_id if isinstance(speech_id, str) else None,
                            **values,
                        }
                    )
                )
            return

        totals = turn_metric_totals.setdefault(speech_id, {})
        updates: dict[str, float] = {}
        if valid_duration is not None:
            duration_total_name = f"{metric_type}_duration"
            totals[duration_total_name] = totals.get(duration_total_name, 0.0) + valid_duration
            updates[duration_name] = totals[duration_total_name]
        if valid_first_audio is not None:
            first_total_name = (
                "llm_first_token"
                if metric_type == "llm"
                else "tts_first_audio"
            )
            totals.setdefault(first_total_name, valid_first_audio)
            updates[first_audio_name] = totals[first_total_name]
        handle = speech_handles_by_id.get(speech_id)
        if updates and (
            getattr(handle, "interrupted", False)
            or turn_sequences_by_speech_id[speech_id] < next_turn_sequence
        ):
            asyncio.create_task(
                publish_diagnostic(
                    {
                        "type": "speech_provider_metric",
                        "speech_id": speech_id,
                        "turn_sequence": turn_sequences_by_speech_id[speech_id],
                        "metric_type": metric_type,
                        "interrupted": getattr(handle, "interrupted", False),
                        **updates,
                    }
                )
            )
        if speech_id in completed_speech_ids and updates:
            asyncio.create_task(publish_correlated_turn_metrics(speech_id, updates))

    def on_llm_metrics(metrics: object) -> None:
        # AgentActivity attaches speech_id while it dispatches this event.
        asyncio.get_running_loop().call_soon(
            record_plugin_metrics, metrics, "llm"
        )

    def on_tts_metrics(metrics: object) -> None:
        # Streaming TTS emits one metric per segment, so their durations are summed.
        asyncio.get_running_loop().call_soon(
            record_plugin_metrics, metrics, "tts"
        )

    async def publish_completed_turn_metrics(speech_handle: object) -> None:
        # Let provider metric callbacks already queued by the SDK run first.
        await asyncio.sleep(0)
        speech_id = getattr(speech_handle, "id", None)
        if not isinstance(speech_id, str):
            return

        assistant_item = next(
            (
                item
                for item in reversed(getattr(speech_handle, "chat_items", []))
                if getattr(item, "role", None) == "assistant"
            ),
            None,
        )
        await publish_diagnostic(
            {
                "type": "speech_finished",
                "speech_id": speech_id,
                "turn_sequence": turn_sequences_by_speech_id.get(speech_id),
                "item_id": getattr(assistant_item, "id", None),
                "interrupted": getattr(speech_handle, "interrupted", False),
            }
        )

        if getattr(speech_handle, "interrupted", True):
            return

        try:
            if speech_handle.exception() is not None:
                return
        except (AttributeError, asyncio.InvalidStateError):
            return

        if assistant_item is None:
            await publish_uncorrelated_provider_metrics(speech_id)
            return
        if getattr(assistant_item, "interrupted", True):
            return

        item_id = getattr(assistant_item, "id", None)
        if not isinstance(item_id, str):
            await publish_uncorrelated_provider_metrics(speech_id)
            return

        turn_item_ids_by_speech_id[speech_id] = item_id
        completed_speech_ids.add(speech_id)
        totals = turn_metric_totals.setdefault(speech_id, {})
        item_metrics = conversation_metrics(assistant_item)
        if "llm_node_ttft" in item_metrics:
            totals["llm_first_token"] = item_metrics["llm_node_ttft"]
        if "tts_node_ttfb" in item_metrics:
            totals["tts_first_audio"] = item_metrics["tts_node_ttfb"]
        if "e2e_latency" in item_metrics:
            totals["speech_end_to_agent_audio"] = item_metrics["e2e_latency"]

        updates: dict[str, float] = {}
        for total_name, metric_name in (
            ("llm_first_token", "llm_first_token_seconds"),
            ("llm_duration", "llm_duration_seconds"),
            ("tts_first_audio", "tts_first_audio_seconds"),
            ("tts_duration", "tts_duration_seconds"),
            ("speech_end_to_agent_audio", "speech_end_to_agent_audio_seconds"),
        ):
            if total_name in totals:
                updates[metric_name] = totals[total_name]

        turn_sequence = turn_sequences_by_speech_id.get(speech_id)
        if turn_sequence is None:
            return

        # The values available at completion establish the snapshot. Later provider
        # callbacks keep the same speech_id and publish only their updated fields.
        await publish_diagnostic(
            {
                "type": "turn_metrics",
                "speech_id": speech_id,
                "item_id": item_id,
                "turn_sequence": turn_sequence,
                "completed": True,
                **updates,
            }
        )

    def on_speech_created(event: object) -> None:
        nonlocal next_turn_sequence
        speech_handle = getattr(event, "speech_handle", None)
        if speech_handle is not None:
            speech_id = getattr(speech_handle, "id", None)
            if isinstance(speech_id, str):
                next_turn_sequence += 1
                turn_sequences_by_speech_id[speech_id] = next_turn_sequence
                speech_handles_by_id[speech_id] = speech_handle
                turn_metric_totals.setdefault(speech_id, {})
                asyncio.create_task(
                    publish_diagnostic(
                        {
                            "type": "speech_created",
                            "speech_id": speech_id,
                            "turn_sequence": next_turn_sequence,
                        }
                    )
                )
            speech_handle.add_done_callback(
                lambda completed_handle: asyncio.create_task(
                    publish_completed_turn_metrics(completed_handle)
                )
            )

    @session.on("user_state_changed")
    def on_user_state_changed(event: object) -> None:
        nonlocal user_turn_committed_at, overlapping_user_speech_started_at
        state = getattr(event, "new_state", "unknown")
        if state == "speaking":
            user_turn_committed_at = None
            overlapping_user_speech_started_at = (
                time.monotonic() if agent_is_speaking else None
            )
        elif state == "listening":
            overlapping_user_speech_started_at = None
        asyncio.create_task(
            publish_diagnostic(
                {
                    "type": "user_state_changed",
                    "state": state,
                }
            )
        )

    @session.on("agent_state_changed")
    def on_agent_state_changed(event: object) -> None:
        nonlocal user_turn_committed_at, agent_is_speaking, overlapping_user_speech_started_at
        state = getattr(event, "new_state", "unknown")
        timing: dict[str, float] = {}
        if agent_is_speaking and state != "speaking":
            if overlapping_user_speech_started_at is not None:
                timing["user_speech_to_agent_stopped_seconds"] = max(
                    time.monotonic() - overlapping_user_speech_started_at, 0.0
                )
            overlapping_user_speech_started_at = None
        agent_is_speaking = state == "speaking"
        if state == "thinking" and user_turn_committed_at is not None:
            timing["turn_commit_to_agent_thinking_seconds"] = max(
                time.monotonic() - user_turn_committed_at, 0.0
            )
            user_turn_committed_at = None
        asyncio.create_task(
            publish_diagnostic(
                {
                    "type": "agent_state_changed",
                    "state": state,
                    **timing,
                }
            )
        )

    @session.on("conversation_item_added")
    def on_conversation_item_added(event: object) -> None:
        nonlocal user_turn_committed_at
        item = getattr(event, "item", None)
        role = getattr(item, "role", None)
        if isinstance(role, str):
            timing: dict[str, float] = {}
            if role == "user":
                user_turn_committed_at = time.monotonic()
                timing = user_turn_metrics(item)
            elif role == "assistant":
                # LiveKit adds the item to its SpeechHandle before emitting this event.
                # The item ID alone does not reveal which response owns a late callback.
                owner = find_speech_owner(item, speech_handles_by_id)
                if owner is not None:
                    timing["turn_sequence"] = turn_sequences_by_speech_id[owner]
            text = getattr(item, "raw_text_content", "")
            asyncio.create_task(
                publish_diagnostic(
                    {
                        "type": "conversation_item_added",
                        "item_id": getattr(item, "id", None),
                        "speech_id": owner if role == "assistant" else None,
                        "role": role,
                        "text": text if isinstance(text, str) else "",
                        "interrupted": getattr(item, "interrupted", False),
                        **timing,
                    }
                )
            )

    @session.on("overlapping_speech")
    def on_overlapping_speech(event: object) -> None:
        # The native event also contains audio and probability arrays; send scalars only.
        asyncio.create_task(
            publish_diagnostic(
                {
                    "type": "overlapping_speech",
                    "is_interruption": getattr(event, "is_interruption", False),
                    "agent_ended": getattr(event, "agent_ended", False),
                    "detection_delay_seconds": getattr(event, "detection_delay", None),
                    "prediction_duration_seconds": getattr(event, "prediction_duration", None),
                    "total_duration_seconds": getattr(event, "total_duration", None),
                    "probability": getattr(event, "probability", None),
                    "num_requests": getattr(event, "num_requests", None),
                }
            )
        )

    @session.on("agent_false_interruption")
    def on_agent_false_interruption(event: object) -> None:
        asyncio.create_task(
            publish_diagnostic(
                {
                    "type": "agent_false_interruption",
                    "resumed": getattr(event, "resumed", False),
                }
            )
        )

    @session.on("session_usage_updated")
    def on_session_usage_updated(event: object) -> None:
        asyncio.create_task(
            publish_diagnostic(
                {
                    "type": "session_usage",
                    "items": session_usage(getattr(event, "usage", None)),
                }
            )
        )

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

    @session.on("close")
    def on_session_close(event: object) -> None:
        asyncio.create_task(
            publish_diagnostic(
                {
                    "type": "session_closed",
                    "reason": str(getattr(event, "reason", "unknown")),
                }
            )
        )

    session.on("speech_created", on_speech_created)
    await session.start(
        Agent(instructions=COMPANION_INSTRUCTIONS), room=ctx.room, record=False
    )
    llm.on("metrics_collected", on_llm_metrics)
    tts.on("metrics_collected", on_tts_metrics)
    logger.info("voice pipeline ready room=%s llm_model=%s", room_name, llm_model)
    await publish_diagnostic(
        {
            "type": "session_started",
            "llm_model": llm_model,
            "turn_configuration": {
                "vad": "Silero",
                "vad_min_silence_seconds": VAD_MIN_SILENCE_SECONDS,
                "turn_detection": TURN_DETECTION_NAME,
                "turn_detection_model": turn_detector.model,
                "endpointing_mode": ENDPOINTING_MODE,
                "endpointing_mode_source": "configured",
                "min_endpointing_delay_seconds": MIN_ENDPOINTING_DELAY_SECONDS,
                "min_endpointing_delay_source": "configured",
                "max_endpointing_delay_seconds": MAX_ENDPOINTING_DELAY_SECONDS,
                "max_endpointing_delay_source": "configured",
                "preemptive_generation_enabled": PREEMPTIVE_GENERATION_ENABLED,
                "interruption_mode": "adaptive",
                "interruption_mode_source": "configured",
                "interruption_enabled": session.options.interruption["enabled"],
                "interruption_min_duration_seconds": session.options.interruption["min_duration"],
                "interruption_min_words": session.options.interruption["min_words"],
                "false_interruption_timeout_seconds": session.options.interruption["false_interruption_timeout"],
                "resume_false_interruption": session.options.interruption["resume_false_interruption"],
                "backchannel_boundary_seconds": session.options.interruption["backchannel_boundary"],
            },
        }
    )

    if not ctx.room.remote_participants:
        browser_disconnected.set()

    try:
        await browser_disconnected.wait()
        logger.info("browser disconnected from room %s", room_name)
    finally:
        closing = True
        llm.off("metrics_collected", on_llm_metrics)
        tts.off("metrics_collected", on_tts_metrics)
        session.off("speech_created", on_speech_created)
        turn_metric_totals.clear()
        turn_item_ids_by_speech_id.clear()
        turn_sequences_by_speech_id.clear()
        speech_handles_by_id.clear()
        completed_speech_ids.clear()
        # Wait for LiveKit to interrupt speech and detach room I/O before ending the job.
        await session.aclose()
        ctx.shutdown(reason="browser disconnected")


if __name__ == "__main__":
    cli.run_app(server)
