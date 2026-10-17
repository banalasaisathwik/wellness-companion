"""Temporary console-only delivery tracing; never used as latency values."""

import json
import logging
import os
import time

logger = logging.getLogger("voice_companion.agent")

# One switch controls backend logs and the metadata that enables browser logs.
METRIC_TRACE = os.getenv("METRIC_TRACE", "0") == "1"
SELECTED_METRICS = {
    "llm_first_token_seconds": "llm_node_ttft",
    "first_speakable_text_seconds": "llm_node_ttfs",
    "tts_first_audio_seconds": "tts_node_ttfb",
    "response_latency_seconds": "e2e_latency",
}


def log_metric_trace(stage: str, trace: dict[str, object], **fields: object) -> None:
    if METRIC_TRACE:
        logger.info("[metric-trace] %s", json.dumps({"stage": stage, **trace, **fields}, separators=(",", ":")))


def stamp_metric_publish(message: dict[str, object], session_id: str) -> list[dict[str, object]]:
    traces = message.get("metric_trace", [])
    if not METRIC_TRACE or not isinstance(traces, list) or not traces:
        return []
    published_at = time.perf_counter()
    wall_ms = time.time() * 1000
    for trace in traces:
        trace.update(session_id=session_id, backend_publish_at=published_at, backend_publish_wall_ms=wall_ms)
        trace["backend_publish_delay_ms"] = (published_at - trace["native_received_at"]) * 1000
        log_metric_trace("publish", trace)
    return traces


def finish_metric_publish(traces: list[dict[str, object]], status: str) -> None:
    # Completion cannot be included in the packet already sent; match by trace_id.
    done_at = time.perf_counter()
    for trace in traces:
        log_metric_trace("publish_done", trace, backend_publish_done_at=done_at,
                         backend_publish_duration_ms=(done_at - trace["backend_publish_at"]) * 1000,
                         publish_status=status)
