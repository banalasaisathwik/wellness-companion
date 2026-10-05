import asyncio
import math
from array import array
from unittest.mock import patch

from livekit import rtc
from livekit.agents.voice.io import AudioInput

from src import acoustics
from src.acoustics import AcousticAudioInput


class FrameSource(AudioInput):
    def __init__(self, frames: list[rtc.AudioFrame]) -> None:
        super().__init__(label="test source")
        self.frames = iter(frames)

    async def __anext__(self) -> rtc.AudioFrame:
        return next(self.frames)


def test_weighted_turn_rms_and_frame_passthrough() -> None:
    frames = [
        rtc.AudioFrame(array("h", [1234]).tobytes(), 1000, 1, 1),
        rtc.AudioFrame(array("h", [16384, -16384]).tobytes(), 1000, 1, 2),
        rtc.AudioFrame(array("h", [8192] * 6).tobytes(), 1000, 1, 6),
    ]
    acoustic_input = AcousticAudioInput(FrameSource(frames))
    clock = [1.0]

    async def read_frames() -> None:
        assert await acoustic_input.__anext__() is frames[0]
        acoustic_input.speech_started()
        assert await acoustic_input.__anext__() is frames[1]
        assert await acoustic_input.__anext__() is frames[2]
        clock[0] = 3.0
        acoustic_input.speech_ended()
        assert math.isclose(
            math.sqrt(acoustic_input.turn_sum_of_squares / acoustic_input.turn_sample_count) / 32768,
            math.sqrt((2 * 0.5**2 + 6 * 0.25**2) / 8),
        )
        summary = acoustic_input.finish_turn("four normal spoken words")
        assert summary is not None
        assert summary["final_word_count"] == 4
        assert summary["final_character_count"] == 24
        assert summary["speech_rate_wpm"] == 120
        assert summary["speech_ratio"] == 1
        assert summary["pause_ratio"] == 0
        assert math.isclose(summary["average_energy"], math.sqrt((2 * 0.5**2 + 6 * 0.25**2) / 8))
        assert summary["peak_energy"] == 0.5
        assert acoustic_input.finish_turn("four normal spoken words") is None

    with patch.object(acoustics.time, "monotonic", side_effect=lambda: clock[0]):
        asyncio.run(read_frames())


def test_partial_revisions_are_replaced_and_final_rate_uses_final_words() -> None:
    frames = [rtc.AudioFrame(array("h", [4096]).tobytes(), 1000, 1, 1)]
    acoustic_input = AcousticAudioInput(FrameSource(frames))
    clock = [0.0]

    async def read_turn() -> None:
        acoustic_input.speech_started()
        await acoustic_input.__anext__()
        acoustic_input.update_transcript("I have", False)
        acoustic_input.update_transcript("I have been", False)
        assert acoustic_input.partial_transcript == "I have been"
        clock[0] = 2.0
        acoustic_input.speech_ended()
        summary = acoustic_input.finish_turn("I am tired")
        assert summary is not None
        assert summary["final_word_count"] == 3
        assert summary["speech_rate_wpm"] == 90
        assert acoustic_input.partial_transcript == ""

    with patch.object(acoustics.time, "monotonic", side_effect=lambda: clock[0]):
        asyncio.run(read_turn())


def test_short_silence_between_speech_segments_counts_inside_turn() -> None:
    acoustic_input = AcousticAudioInput(FrameSource([]))
    clock = [0.0]

    with patch.object(acoustics.time, "monotonic", side_effect=lambda: clock[0]):
        acoustic_input.speech_started()
        clock[0] = 1.0
        acoustic_input.speech_ended()
        clock[0] = 1.1
        acoustic_input.speech_started()
        clock[0] = 2.1
        acoustic_input.speech_ended()
        clock[0] = 5.0  # End-of-turn wait is outside the utterance.
        summary = acoustic_input.finish_turn("I need a moment")

    assert summary is not None
    assert math.isclose(summary["silence_seconds"], 0.1)
    assert math.isclose(summary["pause_ratio"], 0.1 / 2.1)
    assert math.isclose(summary["speech_ratio"], 2 / 2.1)


def test_internal_pause_changes_speaking_rate_but_not_articulation_rate() -> None:
    frames = [rtc.AudioFrame(array("h", [4096]).tobytes(), 1000, 1, 1) for _ in range(3)]
    acoustic_input = AcousticAudioInput(FrameSource(frames))
    clock = [0.0]

    async def read_frames() -> None:
        acoustic_input.speech_started()
        await acoustic_input.__anext__()
        clock[0] = 1.0
        acoustic_input.speech_ended()
        clock[0] = 2.0
        acoustic_input.speech_started()
        await acoustic_input.__anext__()
        clock[0] = 3.0
        acoustic_input.speech_ended()
        clock[0] = 4.0  # endpointing wait must not enter the turn
        paused = acoustic_input.finish_turn("I know what matters")
        assert paused is not None
        assert acoustic_input.baseline[-1]["speaking_rate_wpm"] == 80
        assert math.isclose(acoustic_input.baseline[-1]["pause_ratio"], 1 / 3)

        clock[0] = 5.0
        acoustic_input.speech_started()
        await acoustic_input.__anext__()
        clock[0] = 7.0
        acoustic_input.speech_ended()
        continuous = acoustic_input.finish_turn("I know what matters")
        assert continuous is not None
        assert acoustic_input.baseline[-1]["pause_ratio"] == 0
        assert acoustic_input.baseline[-1]["speaking_rate_wpm"] == 120

    with patch.object(acoustics.time, "monotonic", side_effect=lambda: clock[0]):
        asyncio.run(read_frames())


def test_baseline_warms_up_excludes_short_reply_and_compares_before_update() -> None:
    frames = [rtc.AudioFrame(array("h", [4096]).tobytes(), 1000, 1, 1) for _ in range(5)]
    acoustic_input = AcousticAudioInput(FrameSource(frames))
    clock = [1.0]

    async def read_frames() -> None:
        for index, (start, duration) in enumerate(((1.0, 2.0), (4.0, 2.0), (7.0, 4.0))):
            clock[0] = start
            acoustic_input.speech_started()
            await acoustic_input.__anext__()
            clock[0] += duration
            acoustic_input.speech_ended()
            result = acoustic_input.finish_turn("four normal spoken words")
            assert result is not None
            assert len(acoustic_input.baseline) == index + 1
            assert result["baseline_status"] == ("READY" if index == 2 else "CALIBRATING")
            assert result["speech_rate_delta"] is None

        clock[0] = 12.0
        acoustic_input.speech_started()
        await acoustic_input.__anext__()
        clock[0] = 13.0
        acoustic_input.speech_ended()
        short = acoustic_input.finish_turn("yes")
        assert short is not None
        assert short["baseline_eligible"] is False
        assert len(acoustic_input.baseline) == 3

        clock[0] = 14.0
        acoustic_input.speech_started()
        await acoustic_input.__anext__()
        clock[0] = 18.0
        acoustic_input.speech_ended()
        slow = acoustic_input.finish_turn("four normal spoken words")
        assert slow is not None
        assert slow["speech_rate_delta"] == -0.5
        assert len(acoustic_input.baseline) == 4

    with patch.object(acoustics.time, "monotonic", side_effect=lambda: clock[0]):
        asyncio.run(read_frames())
