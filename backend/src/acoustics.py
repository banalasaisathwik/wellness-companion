"""Observe the existing LiveKit audio input without creating another reader."""

import logging

from livekit import rtc
from livekit.agents.voice.io import AudioInput

if __package__:
    from .conversation.features import TurnFeatures
else:
    from conversation.features import TurnFeatures


logger = logging.getLogger("voice_companion.acoustics")


class AcousticAudioInput(AudioInput, TurnFeatures):
    """Measure RoomIO's PCM frames while forwarding the same frames to AgentSession."""

    def __init__(self, source: AudioInput) -> None:
        AudioInput.__init__(self, label="Turn features", source=source)
        TurnFeatures.__init__(self)

    async def __anext__(self) -> rtc.AudioFrame:
        frame = await super().__anext__()
        if self.disabled:
            return frame
        try:
            if self.speaking:
                self.update_samples(frame.data)
        except Exception:
            self.disabled = True
            logger.exception("acoustic diagnostics disabled after frame analysis failure")
        return frame
