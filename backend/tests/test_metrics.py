import asyncio
from types import SimpleNamespace

from src.metrics import TurnMetrics


class Events:
    def on(self, name: str, callback: object) -> None:
        pass

    def off(self, name: str, callback: object) -> None:
        pass


class Handle:
    def __init__(self, speech_id: str, item: object) -> None:
        self.id = speech_id
        self.chat_items = [item]
        self.interrupted = False

    def add_done_callback(self, callback: object) -> None:
        self.callback = callback

    def exception(self) -> None:
        return None


def test_native_metrics_and_late_provider_updates_keep_turn_ownership() -> None:
    async def run() -> None:
        messages: list[dict[str, object]] = []

        async def publish(message: dict[str, object]) -> None:
            messages.append(message)

        events = Events()
        metrics = TurnMetrics(events, events, events, publish)
        metrics.start()
        first = SimpleNamespace(id="item-1", role="assistant", interrupted=False, metrics={
            "e2e_latency": 0.7, "llm_node_ttft": 0.2,
        })
        second = SimpleNamespace(id="item-2", role="assistant", interrupted=False, metrics={
            "e2e_latency": 0.5, "llm_node_ttft": 0.1, "tts_node_ttfb": 0.15,
        })
        metrics.user_speech_ended(10.0)
        for speech_id, item, endpointing in (("speech-1", first, 0.3), ("speech-2", second, 0.25)):
            handle = Handle(speech_id, item)
            metrics.on_speech_created(SimpleNamespace(speech_handle=handle, source="generate_reply"))
            if speech_id == "speech-1":
                metrics.agent_speech_started(11.0)
            metrics.user_item_added(SimpleNamespace(id=f"user-{speech_id}", metrics={"end_of_turn_delay": endpointing}))
            await metrics.publish_completed(handle)

        # A late first-audio callback belongs to the first item, while native
        # first-token timing must not be replaced by a provider callback.
        metrics.record_provider_time(SimpleNamespace(speech_id="speech-1", ttfb=0.12, cancelled=False), "tts_first_audio_seconds", "ttfb")
        metrics.record_provider_time(SimpleNamespace(speech_id="speech-1", ttft=0.9, cancelled=False), "llm_first_token_seconds", "ttft")
        await asyncio.sleep(0)

        snapshots = [message for message in messages if message["type"] == "turn_metrics"]
        assert snapshots[0]["item_id"] == "item-1"
        assert snapshots[0]["response_latency_seconds"] == 0.7
        assert snapshots[0]["response_latency_source"] == "native"
        assert snapshots[1]["item_id"] == "item-2"
        endpointing_events = [message for message in messages if message["type"] == "endpointing"]
        assert [(message["item_id"], message["endpointing_seconds"]) for message in endpointing_events] == [
            ("user-speech-1", 0.3), ("user-speech-2", 0.25),
        ]
        assert snapshots[2]["item_id"] == "item-1"
        assert snapshots[2]["tts_first_audio_seconds"] == 0.12
        assert len(snapshots) == 3
        metrics.close()

    asyncio.run(run())


def test_first_audio_state_estimates_response_when_native_e2e_is_missing() -> None:
    async def run() -> None:
        messages: list[dict[str, object]] = []

        async def publish(message: dict[str, object]) -> None:
            messages.append(message)

        events = Events()
        metrics = TurnMetrics(events, events, events, publish)
        metrics.user_speech_ended(10.0)
        item = SimpleNamespace(id="item", role="assistant", interrupted=False, metrics={})
        handle = Handle("speech", item)
        metrics.on_speech_created(SimpleNamespace(speech_handle=handle))
        metrics.agent_speech_started(10.8)
        await metrics.publish_completed(handle)
        snapshot = next(message for message in messages if message["type"] == "turn_metrics")
        assert abs(snapshot["response_latency_seconds"] - 0.8) < 0.0001
        assert snapshot["response_latency_source"] == "worker_state_fallback"

    asyncio.run(run())


def test_native_latency_stages_and_late_eou_keep_speech_ownership() -> None:
    async def run() -> None:
        messages: list[dict[str, object]] = []

        async def publish(message: dict[str, object]) -> None:
            messages.append(message)

        events = Events()
        metrics = TurnMetrics(events, events, events, publish)
        metrics.start()
        first = SimpleNamespace(id="assistant-1", role="assistant", interrupted=False, metrics={
            "e2e_latency": 0.742, "llm_node_ttft": 0.238,
            "llm_node_ttfs": 0.381, "tts_node_ttfb": 0.171, "playback_latency": 0.008,
            "provider_request_ids": ["req_123", "https://unsafe.example"],
        })
        second = SimpleNamespace(id="assistant-2", role="assistant", interrupted=False, metrics={
            "e2e_latency": 0.6, "llm_node_ttft": 0.15,
        })
        metrics.record_agent_logic("user-1", 0.074, 0.004)
        first_handle = Handle("speech-1", first)
        metrics.on_speech_created(SimpleNamespace(speech_handle=first_handle, source="generate_reply"))
        metrics.on_session_metrics(SimpleNamespace(metrics=SimpleNamespace(
            type="eou_metrics", speech_id="speech-1", transcription_delay=0.092,
            end_of_utterance_delay=0.18, on_user_turn_completed_delay=0.076,
        )))
        await metrics.publish_completed(first_handle)

        second_handle = Handle("speech-2", second)
        metrics.on_speech_created(SimpleNamespace(speech_handle=second_handle, source="generate_reply"))
        await metrics.publish_completed(second_handle)
        metrics.on_session_metrics(SimpleNamespace(metrics=SimpleNamespace(
            type="eou_metrics", speech_id="speech-1", transcription_delay=0.093,
            end_of_utterance_delay=0.18, on_user_turn_completed_delay=0.076,
        )))
        await asyncio.sleep(0)

        snapshots = [message for message in messages if message["type"] == "turn_metrics"]
        assert snapshots[0]["speech_id"] == "speech-1"
        assert snapshots[0]["user_item_id"] == "user-1"
        assert snapshots[0]["final_transcript_seconds"] == 0.092
        assert snapshots[0]["turn_detection_seconds"] == 0.18
        assert snapshots[0]["turn_processing_seconds"] == 0.076
        assert snapshots[0]["state_analysis_seconds"] == 0.074
        assert snapshots[0]["strategy_selection_seconds"] == 0.004
        assert snapshots[0]["first_speakable_text_seconds"] == 0.381
        assert snapshots[0]["audio_output_start_seconds"] == 0.008
        assert snapshots[0]["llm_first_token_source"] == "native"
        assert snapshots[0]["tts_first_audio_source"] == "native"
        assert snapshots[0]["provider_request_ids"] == ["req_123"]
        assert snapshots[1]["item_id"] == "assistant-2"
        assert snapshots[2]["item_id"] == "assistant-1"
        assert snapshots[2]["final_transcript_seconds"] == 0.093
        metrics.close()

    asyncio.run(run())


def test_barge_in_timing_requires_an_interrupted_speech() -> None:
    async def run() -> None:
        messages: list[dict[str, object]] = []

        async def publish(message: dict[str, object]) -> None:
            messages.append(message)

        events = Events()
        metrics = TurnMetrics(events, events, events, publish)
        metrics.start()
        item = SimpleNamespace(id="item", role="assistant", interrupted=True, metrics={})
        handle = Handle("speech", item)
        metrics.on_speech_created(SimpleNamespace(speech_handle=handle, source="generate_reply"))
        metrics.barge_in_seconds["speech"] = 0.164
        await metrics.publish_completed(handle)
        assert not any(message["type"] == "barge_in" for message in messages)

        handle.interrupted = True
        await metrics.publish_completed(handle)
        assert [(message["speech_id"], message["barge_in_seconds"]) for message in messages if message["type"] == "barge_in"] == [("speech", 0.164)]

        late = Handle("late", item)
        late.interrupted = True
        metrics.on_speech_created(SimpleNamespace(speech_handle=late, source="generate_reply"))
        await metrics.publish_completed(late)
        metrics.record_barge_in("late", 0.2)
        await asyncio.sleep(0)
        assert [message["barge_in_seconds"] for message in messages if message["type"] == "barge_in"] == [0.164, 0.2]
        metrics.close()

    asyncio.run(run())
