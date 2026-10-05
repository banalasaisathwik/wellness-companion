"""Small, turn-owned timing snapshots from LiveKit's native events."""

import asyncio
import math
import re
from collections.abc import Awaitable, Callable


def valid_seconds(value: object) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
        return float(value)
    return None


def find_speech_owner(item: object, speech_handles: dict[str, object]) -> str | None:
    for speech_id, handle in speech_handles.items():
        if any(chat_item is item for chat_item in getattr(handle, "chat_items", [])):
            return speech_id
    return None


class TurnMetrics:
    """Keep late provider callbacks attached to the assistant item that owns them."""

    def __init__(self, session: object, llm: object, tts: object, publish: Callable[[dict[str, object]], Awaitable[None]]) -> None:
        self.session = session
        self.llm = llm
        self.tts = tts
        self.publish = publish
        self.handles: dict[str, object] = {}
        self.sequences: dict[str, int] = {}
        self.items: dict[str, str] = {}
        self.completed: set[str] = set()
        self.provider_times: dict[str, dict[str, float]] = {}
        self.user_speech_end_at: float | None = None
        self.user_speech_end_by_speech: dict[str, float] = {}
        self.fallback_response_latency: dict[str, float] = {}
        self.barge_in_seconds: dict[str, float] = {}
        self.interrupted_finished: set[str] = set()
        self.barge_in_published: set[str] = set()
        self.native_fields: dict[str, set[str]] = {}
        self.user_metrics_by_speech: dict[str, dict[str, object]] = {}
        self.pending_agent_logic: list[dict[str, object]] = []
        self.next_sequence = 0
        self.next_user_sequence = 0
        self.closed = False

    def start(self) -> None:
        self.session.on("speech_created", self.on_speech_created)
        self.session.on("metrics_collected", self.on_session_metrics)
        self.llm.on("metrics_collected", self.on_llm_metrics)
        self.tts.on("metrics_collected", self.on_tts_metrics)

    def close(self) -> None:
        self.closed = True
        self.session.off("speech_created", self.on_speech_created)
        self.session.off("metrics_collected", self.on_session_metrics)
        self.llm.off("metrics_collected", self.on_llm_metrics)
        self.tts.off("metrics_collected", self.on_tts_metrics)
        self.handles.clear()
        self.sequences.clear()
        self.items.clear()
        self.completed.clear()
        self.provider_times.clear()
        self.user_speech_end_by_speech.clear()
        self.fallback_response_latency.clear()
        self.native_fields.clear()
        self.user_metrics_by_speech.clear()
        self.pending_agent_logic.clear()
        self.barge_in_seconds.clear()
        self.interrupted_finished.clear()
        self.barge_in_published.clear()

    def speech_owner(self, item: object) -> str | None:
        return find_speech_owner(item, self.handles)

    def user_speech_ended(self, event_time: object) -> None:
        self.user_speech_end_at = valid_seconds(event_time)

    def agent_speech_started(self, event_time: object) -> None:
        speech_id = next(reversed(self.handles), None)
        started_at = valid_seconds(event_time)
        ended_at = self.user_speech_end_by_speech.get(speech_id) if speech_id else None
        if speech_id and started_at is not None and ended_at is not None and started_at >= ended_at:
            self.fallback_response_latency[speech_id] = started_at - ended_at

    def record_barge_in(self, speech_id: str, seconds: float) -> None:
        self.barge_in_seconds[speech_id] = seconds
        if speech_id in self.interrupted_finished:
            asyncio.create_task(self.publish_barge_in(speech_id))

    async def publish_barge_in(self, speech_id: str) -> None:
        if self.closed or speech_id in self.barge_in_published or speech_id not in self.barge_in_seconds:
            return
        self.barge_in_published.add(speech_id)
        await self.publish({
            "type": "barge_in",
            "speech_id": speech_id,
            "turn_sequence": self.sequences[speech_id],
            "barge_in_seconds": self.barge_in_seconds[speech_id],
        })

    def user_item_added(self, item: object) -> None:
        self.next_user_sequence += 1
        metrics = getattr(item, "metrics", None)
        endpointing = valid_seconds(metrics.get("end_of_turn_delay")) if isinstance(metrics, dict) else None
        item_id = getattr(item, "id", None)
        if endpointing is not None and isinstance(item_id, str):
            asyncio.create_task(self.publish({
                "type": "endpointing",
                "item_id": item_id,
                "user_turn_sequence": self.next_user_sequence,
                "endpointing_seconds": endpointing,
            }))

    def record_agent_logic(self, item_id: str, state_seconds: float | None, strategy_seconds: float | None) -> None:
        values: dict[str, object] = {"user_item_id": item_id}
        if state_seconds is not None:
            values["state_analysis_seconds"] = state_seconds
        if strategy_seconds is not None:
            values["strategy_selection_seconds"] = strategy_seconds
        self.pending_agent_logic.append(values)

    def on_session_metrics(self, event: object) -> None:
        report = getattr(event, "metrics", None)
        speech_id = getattr(report, "speech_id", None)
        if self.closed or getattr(report, "type", None) != "eou_metrics" or not isinstance(speech_id, str):
            return
        values = self.user_metrics_by_speech.setdefault(speech_id, {})
        for source, target in (
            ("transcription_delay", "final_transcript_seconds"),
            ("end_of_utterance_delay", "turn_detection_seconds"),
            ("on_user_turn_completed_delay", "turn_processing_seconds"),
        ):
            value = valid_seconds(getattr(report, source, None))
            if value is not None:
                values[target] = value
        if speech_id in self.completed:
            asyncio.create_task(self.publish_snapshot(speech_id, values))

    def on_speech_created(self, event: object) -> None:
        handle = getattr(event, "speech_handle", None)
        speech_id = getattr(handle, "id", None)
        if not isinstance(speech_id, str) or self.closed:
            return
        self.next_sequence += 1
        self.handles[speech_id] = handle
        self.sequences[speech_id] = self.next_sequence
        if getattr(event, "source", None) == "generate_reply" and self.pending_agent_logic:
            self.user_metrics_by_speech.setdefault(speech_id, {}).update(self.pending_agent_logic.pop(0))
        if self.user_speech_end_at is not None:
            self.user_speech_end_by_speech[speech_id] = self.user_speech_end_at
            self.user_speech_end_at = None
        asyncio.create_task(self.publish({"type": "speech_created", "speech_id": speech_id, "turn_sequence": self.next_sequence}))
        handle.add_done_callback(lambda completed: asyncio.create_task(self.publish_completed(completed)))

    def on_llm_metrics(self, metrics: object) -> None:
        asyncio.get_running_loop().call_soon(self.record_provider_time, metrics, "llm_first_token_seconds", "ttft")

    def on_tts_metrics(self, metrics: object) -> None:
        asyncio.get_running_loop().call_soon(self.record_provider_time, metrics, "tts_first_audio_seconds", "ttfb")

    def record_provider_time(self, metrics: object, name: str, source: str) -> None:
        speech_id = getattr(metrics, "speech_id", None)
        value = valid_seconds(getattr(metrics, source, None))
        if self.closed or getattr(metrics, "cancelled", False) or not isinstance(speech_id, str) or value is None:
            return
        if speech_id not in self.sequences:
            return
        times = self.provider_times.setdefault(speech_id, {})
        times.setdefault(name, value)
        if speech_id in self.completed and name not in self.native_fields.get(speech_id, set()):
            asyncio.create_task(self.publish_snapshot(speech_id, {
                name: times[name], name.replace("_seconds", "_source"): "provider",
            }))

    async def publish_snapshot(self, speech_id: str, values: dict[str, object]) -> None:
        item_id = self.items.get(speech_id)
        if self.closed or item_id is None:
            return
        await self.publish({
            "type": "turn_metrics",
            "speech_id": speech_id,
            "item_id": item_id,
            "turn_sequence": self.sequences[speech_id],
            "completed": True,
            **values,
        })

    async def publish_completed(self, handle: object) -> None:
        # Provider callbacks already queued by the SDK get one event-loop turn to run.
        await asyncio.sleep(0)
        speech_id = getattr(handle, "id", None)
        if self.closed or not isinstance(speech_id, str) or speech_id not in self.sequences:
            return
        assistant_item = next((item for item in reversed(getattr(handle, "chat_items", [])) if getattr(item, "role", None) == "assistant"), None)
        if getattr(handle, "interrupted", False):
            self.interrupted_finished.add(speech_id)
        await self.publish({
            "type": "speech_finished",
            "speech_id": speech_id,
            "turn_sequence": self.sequences[speech_id],
            "item_id": getattr(assistant_item, "id", None),
            "interrupted": getattr(handle, "interrupted", False),
        })
        if speech_id in self.interrupted_finished:
            await self.publish_barge_in(speech_id)
        if getattr(handle, "interrupted", True) or getattr(assistant_item, "interrupted", True):
            return
        try:
            if handle.exception() is not None:
                return
        except (AttributeError, asyncio.InvalidStateError):
            return
        item_id = getattr(assistant_item, "id", None)
        if not isinstance(item_id, str):
            return
        self.items[speech_id] = item_id
        self.completed.add(speech_id)
        values: dict[str, object] = dict(self.provider_times.get(speech_id, {}))
        for name in self.provider_times.get(speech_id, {}):
            values[name.replace("_seconds", "_source")] = "provider"
        values.update(self.user_metrics_by_speech.get(speech_id, {}))
        if speech_id in self.fallback_response_latency:
            values["response_latency_seconds"] = self.fallback_response_latency[speech_id]
            response_source = "worker_state_fallback"
        else:
            response_source = None
        native = getattr(assistant_item, "metrics", None)
        if isinstance(native, dict):
            request_ids = native.get("provider_request_ids")
            if isinstance(request_ids, list):
                values["provider_request_ids"] = [
                    request_id for request_id in request_ids[:8]
                    if isinstance(request_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", request_id)
                ]
            for source, target in (
                ("e2e_latency", "response_latency_seconds"),
                ("llm_node_ttft", "llm_first_token_seconds"),
                ("llm_node_ttfs", "first_speakable_text_seconds"),
                ("tts_node_ttfb", "tts_first_audio_seconds"),
                ("playback_latency", "audio_output_start_seconds"),
            ):
                value = valid_seconds(native.get(source))
                if value is not None:
                    values[target] = value
                    self.native_fields.setdefault(speech_id, set()).add(target)
                    if target in ("llm_first_token_seconds", "tts_first_audio_seconds"):
                        values[target.replace("_seconds", "_source")] = "native"
                    if target == "response_latency_seconds":
                        response_source = "native"
        if response_source is not None:
            values["response_latency_source"] = response_source
        await self.publish_snapshot(speech_id, values)
