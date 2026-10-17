"""Small, turn-owned timing snapshots from LiveKit's native events."""

import asyncio
import logging
import math
import re
import time
from collections.abc import Awaitable, Callable
from contextvars import ContextVar

if __package__:
    from .metric_trace import METRIC_TRACE, SELECTED_METRICS, log_metric_trace
else:
    from metric_trace import METRIC_TRACE, SELECTED_METRICS, log_metric_trace

logger = logging.getLogger("voice_companion.agent")


def sanitize_diagnostic_message(message: str) -> str:
    return re.sub(
        r"(?i)(api[_ -]?key|authorization|token)\s*[=:]\s*\S+",
        r"\1=[redacted]",
        message,
    )[:300]


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

    def __init__(self, session: object, llm: object, tts: object, publish: Callable[[dict[str, object]], Awaitable[None]], *, session_id: str | None = None) -> None:
        self.session = session
        self.llm = llm
        self.tts = tts
        self.publish = publish
        self.session_id = session_id
        self.trace_sequence = 0
        self.trace_update_sequence = 0
        self.metric_traces: dict[tuple[str, str, str], dict[str, object]] = {}
        self.item_traces: dict[str, list[dict[str, object]]] = {}
        self.handles: dict[str, object] = {}
        self.sequences: dict[str, int] = {}
        self.items: dict[str, str] = {}
        self.completed: set[str] = set()
        self.provider_times: dict[str, dict[str, float]] = {}
        self.user_speech_end_at: float | None = None
        self.user_speech_end_by_speech: dict[str, float] = {}
        self.user_message_speech_end_by_speech: dict[str, float] = {}
        self.fallback_response_latency: dict[str, float] = {}
        self.barge_in_seconds: dict[str, float] = {}
        self.interrupted_finished: set[str] = set()
        self.barge_in_published: set[str] = set()
        self.native_fields: dict[str, set[str]] = {}
        self.user_native_fields: dict[str, set[str]] = {}
        self.user_metrics_by_speech: dict[str, dict[str, object]] = {}
        self.llm_preparation_by_user: dict[str, tuple[float, float]] = {}
        # LiveKit emits speech_created in the same task after the user-turn hook.
        self.agent_logic_user_item: ContextVar[str | None] = ContextVar(
            "agent_logic_user_item", default=None,
        )
        self.llm_request_user_item: ContextVar[str | None] = ContextVar(
            "llm_request_user_item", default=None,
        )
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
        self.user_message_speech_end_by_speech.clear()
        self.fallback_response_latency.clear()
        self.native_fields.clear()
        self.user_native_fields.clear()
        self.user_metrics_by_speech.clear()
        self.llm_preparation_by_user.clear()
        self.barge_in_seconds.clear()
        self.interrupted_finished.clear()
        self.barge_in_published.clear()
        self.metric_traces.clear()
        self.item_traces.clear()

    def trace_received(self, name: str, value: float, source: str, received_at: float,
                       speech_id: str | None = None, item_id: str | None = None) -> dict[str, object]:
        self.trace_sequence += 1
        trace = {
            "observation_id": self.trace_sequence, "session_id": self.session_id,
            "turn_seq": self.sequences.get(speech_id), "speech_id": speech_id,
            "assistant_item_id": item_id or self.items.get(speech_id),
            "metric_name": name, "metric_value_ms": value * 1000, "source": source,
            "native_received_at": received_at,
            "availability_event": "provider_metrics_collected" if source == "provider" else
                                  "assistant_item_metrics" if source == "native" else "fallback_computed",
            "ownership_wait_ms": 0.0,
        }
        log_metric_trace("received", trace)
        if trace["assistant_item_id"] is None or speech_id is None:
            trace["ownership_missing_at"] = received_at
            log_metric_trace("ownership_missing", trace)
        if speech_id is not None:
            key = (speech_id, name, source)
            if source == "provider":
                # TTS uses its first provider timing; subsequent chunks do not replace it.
                self.metric_traces.setdefault(key, trace)
            else:
                self.metric_traces[key] = trace
        return trace

    def trace_assistant_item(self, item: object, received_at: float) -> None:
        """Observe native availability before the SDK attaches the item to its handle."""
        if not METRIC_TRACE or self.closed:
            return
        item_id = getattr(item, "id", None)
        native = getattr(item, "metrics", None)
        if not isinstance(item_id, str) or not isinstance(native, dict):
            return
        traces = self.item_traces.setdefault(item_id, [])
        for name, field in SELECTED_METRICS.items():
            value = valid_seconds(native.get(field))
            if value is not None:
                traces.append(self.trace_received(name, value, "native", received_at,
                                                  self.speech_owner(item), item_id))

    def trace_item_owner(self, item: object, speech_id: str | None) -> None:
        if not METRIC_TRACE or speech_id is None:
            return
        for trace in self.item_traces.pop(getattr(item, "id", None), []):
            trace.update(speech_id=speech_id, turn_seq=self.sequences.get(speech_id))
            self.trace_resolved(trace)
            self.metric_traces[(speech_id, trace["metric_name"], "native")] = trace
        for (owner, _, source), trace in self.metric_traces.items():
            if owner == speech_id and source != "native":
                trace.update(assistant_item_id=getattr(item, "id", None), turn_seq=self.sequences.get(speech_id))
                self.trace_resolved(trace)

    def trace_resolved(self, trace: dict[str, object]) -> None:
        missing_at = trace.pop("ownership_missing_at", None)
        if missing_at is not None:
            trace["ownership_wait_ms"] = (time.perf_counter() - missing_at) * 1000
            log_metric_trace("ownership_resolved", trace)
        else:
            trace.setdefault("ownership_wait_ms", 0.0)

    def speech_owner(self, item: object) -> str | None:
        return find_speech_owner(item, self.handles)

    def user_speech_ended(self, event_time: object) -> None:
        self.user_speech_end_at = valid_seconds(event_time)

    def agent_speech_started(self, event_time: object) -> None:
        received_at = time.perf_counter()
        speech_id = next(reversed(self.handles), None)
        started_at = valid_seconds(event_time)
        ended_at = self.user_speech_end_by_speech.get(speech_id) if speech_id else None
        if speech_id and started_at is not None and ended_at is not None and started_at >= ended_at:
            self.fallback_response_latency[speech_id] = started_at - ended_at
            if METRIC_TRACE:
                self.trace_received("response_latency_seconds", started_at - ended_at,
                                    "worker_state_fallback", received_at, speech_id)
        if METRIC_TRACE and speech_id:
            log_metric_trace("agent_speaking", {"session_id": self.session_id,
                             "speech_id": speech_id, "turn_seq": self.sequences.get(speech_id),
                             "assistant_item_id": self.items.get(speech_id), "observed_at": received_at})

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
        if isinstance(item_id, str) and isinstance(metrics, dict):
            speech_id = next((
                speech_id for speech_id, values in self.user_metrics_by_speech.items()
                if values.get("user_item_id") == item_id
            ), None)
            if speech_id is not None:
                values = self.user_metrics_by_speech[speech_id]
                for source, target in (
                    ("transcription_delay", "final_transcript_seconds"),
                    ("end_of_turn_delay", "turn_detection_seconds"),
                    ("on_user_turn_completed_delay", "turn_processing_seconds"),
                ):
                    value = valid_seconds(metrics.get(source))
                    if value is not None and (value > 0 or source == "on_user_turn_completed_delay"):
                        values[target] = value
                        self.user_native_fields.setdefault(speech_id, set()).add(target)
                stopped_at = valid_seconds(metrics.get("stopped_speaking_at"))
                if stopped_at is not None:
                    self.user_speech_end_by_speech[speech_id] = stopped_at
                    self.user_message_speech_end_by_speech[speech_id] = stopped_at
                if speech_id in self.completed:
                    assistant_item = next((
                        candidate for candidate in reversed(getattr(self.handles[speech_id], "chat_items", []))
                        if getattr(candidate, "id", None) == self.items.get(speech_id)
                    ), None)
                    assistant_metrics = getattr(assistant_item, "metrics", None)
                    if isinstance(assistant_metrics, dict) and valid_seconds(assistant_metrics.get("e2e_latency")) is None:
                        started_at = valid_seconds(assistant_metrics.get("started_speaking_at"))
                        if started_at is not None and stopped_at is not None and started_at >= stopped_at:
                            values["response_latency_seconds"] = started_at - stopped_at
                            values["response_latency_source"] = "message_timestamps"
                    asyncio.create_task(self.publish_snapshot(speech_id, values))
        if endpointing is not None and isinstance(item_id, str):
            asyncio.create_task(self.publish({
                "type": "endpointing",
                "item_id": item_id,
                "user_turn_sequence": self.next_user_sequence,
                "endpointing_seconds": endpointing,
            }))

    def record_agent_logic(self, item_id: str) -> None:
        self.agent_logic_user_item.set(item_id)

    def record_llm_preparation(self, item_id: str, strategy_ready_at: float, seconds: float) -> None:
        self.llm_preparation_by_user[item_id] = (strategy_ready_at, seconds)

    def record_llm_node_entry(self, chat_ctx: object) -> None:
        messages = chat_ctx.messages()
        user_item_id = next((message.id for message in reversed(messages) if message.role == "user"), None)
        if self.closed or user_item_id is None:
            return
        speech_id = next((
            speech_id for speech_id, values in self.user_metrics_by_speech.items()
            if values.get("user_item_id") == user_item_id
        ), None)
        if speech_id is None:
            return
        values = self.user_metrics_by_speech[speech_id]
        values["llm_message_count"] = len(messages)
        values["llm_previous_message_count"] = sum(
            message.role in ("user", "assistant") and message.id != user_item_id
            for message in messages
        )
        values["llm_instruction_chars"] = sum(
            len(message.raw_text_content or "") for message in messages if message.role == "system"
        )
        values["llm_context_chars"] = sum(len(message.raw_text_content or "") for message in messages)
        values["llm_current_user_chars"] = next((
            len(message.raw_text_content or "") for message in reversed(messages)
            if message.id == user_item_id
        ), 0)
        self.llm_request_user_item.set(user_item_id)

    async def on_llm_http_request(self, _request: object) -> None:
        # The installed OpenAI SDK calls this immediately before transport send.
        user_item_id = self.llm_request_user_item.get()
        if self.closed or user_item_id is None:
            return
        speech_id = next((
            speech_id for speech_id, values in self.user_metrics_by_speech.items()
            if values.get("user_item_id") == user_item_id
        ), None)
        if speech_id is None:
            return
        values = self.user_metrics_by_speech[speech_id]
        if "llm_pre_request_overhead_seconds" in values:
            return
        logger.info("TURN %s main LLM HTTP request started", self.sequences[speech_id])
        request_started = time.perf_counter()
        preparation = self.llm_preparation_by_user.pop(user_item_id, None)
        if preparation is not None and request_started >= preparation[0]:
            values["llm_request_preparation_seconds"] = preparation[1]
            values["llm_pre_request_overhead_seconds"] = request_started - preparation[0]
        if speech_id in self.completed:
            asyncio.create_task(self.publish_snapshot(speech_id, values.copy()))

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
            # The SDK reports 0.0 when no speech end was detected. Do not
            # replace a real ChatMessage timing with that placeholder.
            if (value is not None and (value > 0 or source == "on_user_turn_completed_delay")
                    and target not in self.user_native_fields.get(speech_id, set())):
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
        if getattr(event, "source", None) == "generate_reply":
            user_item_id = self.agent_logic_user_item.get()
            if user_item_id is not None:
                values = self.user_metrics_by_speech.setdefault(speech_id, {})
                values["user_item_id"] = user_item_id
                preparation = self.llm_preparation_by_user.get(user_item_id)
                if preparation is not None:
                    values["llm_request_preparation_seconds"] = preparation[1]
                self.agent_logic_user_item.set(None)
        if self.user_speech_end_at is not None:
            self.user_speech_end_by_speech[speech_id] = self.user_speech_end_at
            self.user_speech_end_at = None
        asyncio.create_task(self.publish({"type": "speech_created", "speech_id": speech_id, "turn_sequence": self.next_sequence}))
        handle.add_done_callback(lambda completed: asyncio.create_task(self.publish_completed(completed)))

    def on_llm_metrics(self, metrics: object) -> None:
        received_at = time.perf_counter()
        trace = self.trace_provider_received(metrics, "llm_first_token_seconds", "ttft", received_at)
        asyncio.get_running_loop().call_soon(self.record_provider_time, metrics, "llm_first_token_seconds", "ttft", trace)

    def on_tts_metrics(self, metrics: object) -> None:
        received_at = time.perf_counter()
        trace = self.trace_provider_received(metrics, "tts_first_audio_seconds", "ttfb", received_at)
        asyncio.get_running_loop().call_soon(self.record_provider_time, metrics, "tts_first_audio_seconds", "ttfb", trace)

    def trace_provider_received(self, metrics: object, name: str, source: str, received_at: float) -> dict[str, object] | None:
        value = valid_seconds(getattr(metrics, source, None))
        if not METRIC_TRACE or self.closed or value is None or getattr(metrics, "cancelled", False):
            return None
        speech_id = getattr(metrics, "speech_id", None)
        return self.trace_received(name, value, "provider", received_at,
                                   speech_id if isinstance(speech_id, str) else None)

    def record_provider_time(self, metrics: object, name: str, source: str, trace: dict[str, object] | None = None) -> None:
        speech_id = getattr(metrics, "speech_id", None)
        value = valid_seconds(getattr(metrics, source, None))
        if self.closed or getattr(metrics, "cancelled", False) or not isinstance(speech_id, str) or value is None:
            return
        if speech_id not in self.sequences:
            if trace is not None:
                log_metric_trace("discarded", trace, reason="unknown_speech_owner_existing_behavior")
            return
        if METRIC_TRACE:
            if trace is None:
                trace = self.trace_provider_received(metrics, name, source, time.perf_counter())
            if trace is not None:
                trace.update(speech_id=speech_id, turn_seq=self.sequences[speech_id],
                             assistant_item_id=self.items.get(speech_id))
                self.metric_traces.setdefault((speech_id, name, "provider"), trace)
                if speech_id in self.items:
                    self.trace_resolved(trace)
                log_metric_trace("provider_handled", trace,
                                 callback_queue_delay_ms=(time.perf_counter() - trace["native_received_at"]) * 1000,
                                 disposition="tokens_only_timing_not_published" if name == "llm_first_token_seconds" else
                                 "native_timing_preferred" if name in self.native_fields.get(speech_id, set()) else
                                 "late_update" if speech_id in self.completed else "buffered_until_completion")
        times = self.provider_times.setdefault(speech_id, {})
        if name != "llm_first_token_seconds":
            times.setdefault(name, value)
        if name == "llm_first_token_seconds":
            values = self.user_metrics_by_speech.setdefault(speech_id, {})
            received_tokens = False
            for source, target in (("prompt_tokens", "llm_input_tokens"), ("completion_tokens", "llm_output_tokens")):
                count = getattr(metrics, source, None)
                if isinstance(count, int) and not isinstance(count, bool) and count > 0:
                    values[target] = count
                    received_tokens = True
            if speech_id in self.completed and received_tokens:
                asyncio.create_task(self.publish_snapshot(speech_id, {
                    target: values[target] for target in ("llm_input_tokens", "llm_output_tokens") if target in values
                }))
        if (name != "llm_first_token_seconds" and speech_id in self.completed
                and name not in self.native_fields.get(speech_id, set())):
            asyncio.create_task(self.publish_snapshot(speech_id, {
                name: times[name], name.replace("_seconds", "_source"): "provider",
            }))

    async def publish_snapshot(self, speech_id: str, values: dict[str, object], *, update_kind: str = "late") -> None:
        item_id = self.items.get(speech_id)
        if self.closed or item_id is None:
            return
        trace_metadata = []
        if METRIC_TRACE:
            self.trace_update_sequence += 1
            for name in SELECTED_METRICS:
                value = valid_seconds(values.get(name))
                if value is None:
                    continue
                source = values.get(name.replace("_seconds", "_source"), "native")
                trace = self.metric_traces.get((speech_id, name, source))
                if trace is None or trace["metric_value_ms"] != value * 1000:
                    # A fallback was computed here, rather than delivered by a native metric event.
                    trace = self.trace_received(name, value, str(source), time.perf_counter(), speech_id, item_id)
                trace_metadata.append({**trace, "assistant_item_id": item_id,
                                       "turn_seq": self.sequences[speech_id], "update_kind": update_kind,
                                       "trace_id": f"{trace['observation_id']}:{self.trace_update_sequence}"})
        await self.publish({
            "type": "turn_metrics",
            "speech_id": speech_id,
            "item_id": item_id,
            "turn_sequence": self.sequences[speech_id],
            "completed": True,
            **values,
            **({"metric_trace": trace_metadata} if trace_metadata else {}),
        })

    async def publish_completed(self, handle: object) -> None:
        completed_at = time.perf_counter()
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
        if METRIC_TRACE:
            if item_id not in self.item_traces and not any(
                key[0] == speech_id and key[2] == "native" for key in self.metric_traces
            ):
                self.trace_assistant_item(assistant_item, completed_at)
            self.trace_item_owner(assistant_item, speech_id)
        self.items[speech_id] = item_id
        self.completed.add(speech_id)
        if METRIC_TRACE:
            for (owner, _, _), trace in self.metric_traces.items():
                if owner == speech_id:
                    trace.update(assistant_item_id=item_id, turn_seq=self.sequences[speech_id])
                    self.trace_resolved(trace)
                    log_metric_trace("completion_ready", trace, observed_at=time.perf_counter())
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
            if response_source != "native":
                started_at = valid_seconds(native.get("started_speaking_at"))
                ended_at = self.user_message_speech_end_by_speech.get(speech_id)
                if started_at is not None and ended_at is not None and started_at >= ended_at:
                    values["response_latency_seconds"] = started_at - ended_at
                    response_source = "message_timestamps"
        if response_source is not None:
            values["response_latency_source"] = response_source
        first_token = values.get("llm_first_token_seconds")
        first_speakable = values.get("first_speakable_text_seconds")
        if (values.get("llm_first_token_source") == "native"
                and isinstance(first_token, float) and isinstance(first_speakable, float)):
            logger.info(
                "TURN %s native TTFT: %.1f ms; first speakable: %.1f ms; token to speakable: %.1f ms",
                self.sequences[speech_id], first_token * 1000, first_speakable * 1000,
                (first_speakable - first_token) * 1000,
            )
        await self.publish_snapshot(speech_id, values, update_kind="initial")
