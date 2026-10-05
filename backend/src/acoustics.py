import logging
import math
import re
import time
from collections import deque
from statistics import median

from livekit import rtc
from livekit.agents.voice.io import AudioInput


logger = logging.getLogger("voice_companion.acoustics")


MIN_RATE_DURATION_MS = 1000
MIN_BASELINE_WORDS = 4
MIN_BASELINE_VOICED_MS = 1500
BASELINE_WARMUP_TURNS = 3
BASELINE_WINDOW_TURNS = 5


class AcousticAudioInput(AudioInput):
    """Measure RoomIO's PCM frames while forwarding the same frames to AgentSession."""

    def __init__(self, source: AudioInput) -> None:
        super().__init__(label="Turn features", source=source)
        self.speaking = False
        self.turn_started_at: float | None = None
        self.voiced_started_at: float | None = None
        self.last_voiced_ended_at: float | None = None
        self.voiced_duration_ms = 0.0
        self.turn_sum_of_squares = 0
        self.turn_sample_count = 0
        self.peak_frame_rms = 0.0
        self.frame_count = 0
        self.partial_transcript = ""
        self.baseline: deque[dict[str, float]] = deque(maxlen=BASELINE_WINDOW_TURNS)
        self.disabled = False

    def speech_started(self) -> None:
        if self.disabled:
            return
        now = time.monotonic()
        if self.turn_started_at is None:
            self.turn_started_at = now
            self.partial_transcript = ""
        self.voiced_started_at = now
        self.last_voiced_ended_at = None
        self.speaking = True

    def speech_ended(self) -> None:
        if self.disabled or not self.speaking:
            return
        now = time.monotonic()
        if self.voiced_started_at is not None:
            self.voiced_duration_ms += max((now - self.voiced_started_at) * 1000, 0.0)
        self.voiced_started_at = None
        self.last_voiced_ended_at = now
        self.speaking = False

    def update_transcript(self, transcript: str, is_final: bool) -> None:
        if not self.disabled and not is_final and self.turn_started_at is not None:
            # Interim STT revisions replace one another; they are not new words.
            self.partial_transcript = transcript

    def finish_turn(self, transcript: str) -> dict[str, object] | None:
        """Finalize the current transcript before classification and update the session baseline."""
        if self.disabled or self.turn_started_at is None:
            return None
        if self.speaking:
            self.speech_ended()
        end = self.last_voiced_ended_at
        if end is None:
            return None

        turn_duration_ms = max((end - self.turn_started_at) * 1000, 0.0)
        voiced_duration_ms = self.voiced_duration_ms
        total_pause_ms = max(turn_duration_ms - voiced_duration_ms, 0.0)
        word_count = len(re.findall(r"\b[\w]+(?:['’][\w]+)*\b", transcript, re.UNICODE))
        pause_ratio = total_pause_ms / turn_duration_ms if turn_duration_ms > 0 else None
        speaking_rate_wpm = (
            word_count * 60000 / turn_duration_ms
            if word_count and turn_duration_ms >= MIN_RATE_DURATION_MS else None
        )
        speech_rate_wpm = (
            word_count * 60000 / voiced_duration_ms
            if word_count and voiced_duration_ms >= MIN_RATE_DURATION_MS else None
        )
        turn_rms = (
            math.sqrt(self.turn_sum_of_squares / self.turn_sample_count) / 32768
            if self.turn_sample_count else 0.0
        )
        comparison_ready = len(self.baseline) >= BASELINE_WARMUP_TURNS
        baseline_values = {
            name: median(turn[name] for turn in self.baseline)
            for name in ("speaking_rate_wpm", "pause_ratio", "turn_rms")
        } if comparison_ready else {}

        def delta(name: str, value: float | None) -> float | None:
            baseline = baseline_values.get(name)
            return (value - baseline) / baseline if value is not None and baseline is not None and baseline > 0 else None

        eligible = (
            word_count >= MIN_BASELINE_WORDS
            and voiced_duration_ms >= MIN_BASELINE_VOICED_MS
            and speaking_rate_wpm is not None
            and pause_ratio is not None
            and self.turn_sample_count > 0
        )
        result: dict[str, object] = {
            "utterance_seconds": turn_duration_ms / 1000,
            "speech_seconds": voiced_duration_ms / 1000,
            "silence_seconds": total_pause_ms / 1000,
            "speech_ratio": min(voiced_duration_ms / turn_duration_ms, 1.0) if turn_duration_ms > 0 else None,
            "pause_ratio": pause_ratio,
            "final_word_count": word_count,
            "final_character_count": len(transcript),
            "speech_rate_wpm": speech_rate_wpm,
            "average_energy": turn_rms if self.turn_sample_count else None,
            "peak_energy": self.peak_frame_rms if self.frame_count else None,
            "baseline_eligible": eligible,
            "speech_rate_delta": delta("speaking_rate_wpm", speaking_rate_wpm),
            "pause_ratio_delta": delta("pause_ratio", pause_ratio),
            "rms_delta": delta("turn_rms", turn_rms) if self.turn_sample_count else None,
        }
        if eligible:
            self.baseline.append({"speaking_rate_wpm": speaking_rate_wpm, "pause_ratio": pause_ratio, "turn_rms": turn_rms})
        result["baseline_status"] = "READY" if len(self.baseline) >= BASELINE_WARMUP_TURNS else "CALIBRATING"
        self.turn_started_at = None
        self.voiced_started_at = None
        self.last_voiced_ended_at = None
        self.voiced_duration_ms = 0.0
        self.turn_sum_of_squares = 0
        self.turn_sample_count = 0
        self.peak_frame_rms = 0.0
        self.frame_count = 0
        self.partial_transcript = ""
        return result

    async def __anext__(self) -> rtc.AudioFrame:
        frame = await super().__anext__()
        if self.disabled:
            return frame
        try:
            if self.speaking:
                samples = frame.data  # LiveKit AudioFrame.data is interleaved signed int16.
                if not samples:
                    return frame
                frame_sum_of_squares = sum(sample * sample for sample in samples)
                self.turn_sum_of_squares += frame_sum_of_squares
                self.turn_sample_count += len(samples)
                self.peak_frame_rms = max(
                    self.peak_frame_rms,
                    math.sqrt(frame_sum_of_squares / len(samples)) / 32768,
                )
                self.frame_count += 1
        except Exception:
            self.disabled = True
            logger.exception("acoustic diagnostics disabled after frame analysis failure")
        return frame
