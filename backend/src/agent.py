import asyncio
import json
import logging
import os
import re
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


def prewarm(process: JobProcess) -> None:
    # Silero loads an ONNX model, so do it before the worker accepts a room job.
    process.userdata["vad"] = silero.VAD.load(min_silence_duration=0.55)


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


@server.rtc_session(agent_name="companion-agent")
async def companion_agent(ctx: JobContext) -> None:
    room_name = ctx.room.name
    logger.info("agent assigned to room %s", room_name)
    browser_disconnected = asyncio.Event()

    async def publish_diagnostic(message: dict[str, object]) -> None:
        try:
            await ctx.room.local_participant.publish_data(
                json.dumps(message, separators=(",", ":")),
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
        session = AgentSession(
            stt=inference.STT(model="assemblyai/universal-streaming", language="en"),
            vad=ctx.proc.userdata["vad"],
            llm=llm,
            tts=tts,
            turn_handling={
                "turn_detection": "vad",
                "endpointing": {"min_delay": 0.5, "max_delay": 3.0},
                "preemptive_generation": {"enabled": False},
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

    turn_metric_totals: dict[str, dict[str, float | bool]] = {}

    def record_plugin_duration(metrics: object, field: str) -> None:
        speech_id = getattr(metrics, "speech_id", None)
        if not isinstance(speech_id, str):
            return

        totals = turn_metric_totals.setdefault(speech_id, {})
        if getattr(metrics, "cancelled", False):
            totals["incomplete"] = True
            return

        duration = getattr(metrics, "duration", None)
        if (
            isinstance(duration, (int, float))
            and not isinstance(duration, bool)
            and duration >= 0
        ):
            totals[field] = float(totals.get(field, 0.0)) + duration

    def on_llm_metrics(metrics: object) -> None:
        # AgentActivity attaches speech_id while it dispatches this event.
        asyncio.get_running_loop().call_soon(
            record_plugin_duration, metrics, "llm_duration"
        )

    def on_tts_metrics(metrics: object) -> None:
        # Streaming TTS emits one metric per segment, so their durations are summed.
        asyncio.get_running_loop().call_soon(
            record_plugin_duration, metrics, "tts_duration"
        )

    async def publish_completed_turn_metrics(speech_handle: object) -> None:
        # Let queued plugin metric callbacks run after the handle finishes.
        await asyncio.sleep(0)
        speech_id = getattr(speech_handle, "id", None)
        if not isinstance(speech_id, str):
            return

        totals = turn_metric_totals.pop(speech_id, None)
        if (
            not totals
            or totals.get("incomplete")
            or getattr(speech_handle, "interrupted", True)
        ):
            return

        try:
            if speech_handle.exception() is not None:
                return
        except (AttributeError, asyncio.InvalidStateError):
            return

        chat_items = getattr(speech_handle, "chat_items", [])
        assistant_item = next(
            (
                item
                for item in reversed(chat_items)
                if getattr(item, "role", None) == "assistant"
            ),
            None,
        )
        if assistant_item is None or getattr(assistant_item, "interrupted", True):
            return

        metrics = conversation_metrics(assistant_item)
        llm_duration = totals.get("llm_duration")
        tts_duration = totals.get("tts_duration")
        if (
            not isinstance(llm_duration, float)
            or not isinstance(tts_duration, float)
            or {"llm_node_ttft", "tts_node_ttfb", "e2e_latency"} - metrics.keys()
        ):
            return

        await publish_diagnostic(
            {
                "type": "turn_metrics",
                "item_id": getattr(assistant_item, "id", None),
                "llm_first_token_seconds": metrics["llm_node_ttft"],
                "llm_duration_seconds": llm_duration,
                "tts_first_audio_seconds": metrics["tts_node_ttfb"],
                "tts_duration_seconds": tts_duration,
                "speech_end_to_agent_audio_seconds": metrics["e2e_latency"],
            }
        )

    def on_speech_created(event: object) -> None:
        speech_handle = getattr(event, "speech_handle", None)
        if speech_handle is not None:
            speech_handle.add_done_callback(
                lambda completed_handle: asyncio.create_task(
                    publish_completed_turn_metrics(completed_handle)
                )
            )

    @session.on("user_state_changed")
    def on_user_state_changed(event: object) -> None:
        asyncio.create_task(
            publish_diagnostic(
                {
                    "type": "user_state_changed",
                    "state": getattr(event, "new_state", "unknown"),
                }
            )
        )

    @session.on("agent_state_changed")
    def on_agent_state_changed(event: object) -> None:
        asyncio.create_task(
            publish_diagnostic(
                {
                    "type": "agent_state_changed",
                    "state": getattr(event, "new_state", "unknown"),
                }
            )
        )

    @session.on("conversation_item_added")
    def on_conversation_item_added(event: object) -> None:
        item = getattr(event, "item", None)
        role = getattr(item, "role", None)
        if isinstance(role, str):
            text = getattr(item, "raw_text_content", "")
            asyncio.create_task(
                publish_diagnostic(
                    {
                        "type": "conversation_item_added",
                        "item_id": getattr(item, "id", None),
                        "role": role,
                        "text": text if isinstance(text, str) else "",
                        "interrupted": getattr(item, "interrupted", False),
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
    await publish_diagnostic({"type": "session_started", "llm_model": llm_model})

    if not ctx.room.remote_participants:
        browser_disconnected.set()

    try:
        await browser_disconnected.wait()
        logger.info("browser disconnected from room %s", room_name)
    finally:
        llm.off("metrics_collected", on_llm_metrics)
        tts.off("metrics_collected", on_tts_metrics)
        session.off("speech_created", on_speech_created)
        turn_metric_totals.clear()
        session.shutdown(drain=False)
        ctx.shutdown(reason="browser disconnected")


if __name__ == "__main__":
    cli.run_app(server)
