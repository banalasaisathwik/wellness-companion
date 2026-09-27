import asyncio
import json
import logging
from pathlib import Path

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import AgentServer, JobContext, cli


load_dotenv(Path(__file__).resolve().parents[1] / ".env.local")

logger = logging.getLogger("voice_companion.agent")
server = AgentServer()


@server.rtc_session(agent_name="companion-agent")
async def companion_agent(ctx: JobContext) -> None:
    room_name = ctx.room.name
    logger.info("agent assigned to room %s", room_name)

    browser_disconnected = asyncio.Event()
    audio_reader_task: asyncio.Task[None] | None = None

    async def read_microphone_audio(
        track: rtc.RemoteAudioTrack, participant_identity: str, track_sid: str
    ) -> None:
        nonlocal audio_reader_task

        audio_stream: rtc.AudioStream | None = None
        received_frame_count = 0
        peak_signal_level = 0
        last_metrics_at = asyncio.get_running_loop().time()

        try:
            audio_stream = rtc.AudioStream.from_track(track=track)

            async for audio_event in audio_stream:
                frame = audio_event.frame
                received_frame_count += 1
                peak_signal_level = max(
                    peak_signal_level,
                    max((abs(sample) for sample in frame.data), default=0),
                )

                if received_frame_count == 1:
                    logger.info(
                        "microphone audio started participant=%s track_sid=%s",
                        participant_identity,
                        track_sid,
                    )

                now = asyncio.get_running_loop().time()
                if now - last_metrics_at >= 1:
                    logger.info(
                        "microphone audio frames participant=%s track_sid=%s frames=%d "
                        "sample_rate=%d channels=%d samples_per_channel=%d peak_pcm=%d",
                        participant_identity,
                        track_sid,
                        received_frame_count,
                        frame.sample_rate,
                        frame.num_channels,
                        frame.samples_per_channel,
                        peak_signal_level,
                    )
                    try:
                        await ctx.room.local_participant.publish_data(
                            json.dumps(
                                {
                                    "type": "audio_metrics",
                                    "participant_identity": participant_identity,
                                    "track_sid": track_sid,
                                    "frame_count": received_frame_count,
                                    "sample_rate": frame.sample_rate,
                                    "channels": frame.num_channels,
                                    "samples_per_channel": frame.samples_per_channel,
                                    "peak_pcm": peak_signal_level,
                                },
                                separators=(",", ":"),
                            ),
                            reliable=False,
                            topic="audio_metrics",
                        )
                    except Exception:
                        logger.exception(
                            "microphone audio metrics publish failed participant=%s track_sid=%s",
                            participant_identity,
                            track_sid,
                        )
                    last_metrics_at = now
                    peak_signal_level = 0
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(
                "microphone audio reader failed participant=%s track_sid=%s",
                participant_identity,
                track_sid,
            )
        finally:
            try:
                if audio_stream is not None:
                    await audio_stream.aclose()
            except Exception:
                logger.exception(
                    "microphone audio stream close failed participant=%s track_sid=%s",
                    participant_identity,
                    track_sid,
                )
            finally:
                if audio_reader_task is asyncio.current_task():
                    audio_reader_task = None

    def start_microphone_reader(
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        nonlocal audio_reader_task

        if (
            not isinstance(track, rtc.RemoteAudioTrack)
            or publication.source != rtc.TrackSource.SOURCE_MICROPHONE
            or audio_reader_task is not None
        ):
            return

        track_sid = track.sid
        audio_reader_task = asyncio.create_task(
            read_microphone_audio(track, participant.identity, track_sid),
            name=f"microphone-audio-{track_sid}",
        )

    def stop_microphone_reader(track_sid: str) -> None:
        if (
            audio_reader_task is not None
            and audio_reader_task.get_name() == f"microphone-audio-{track_sid}"
        ):
            audio_reader_task.cancel()

    async def stop_microphone_reader_task() -> None:
        task = audio_reader_task
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    @ctx.room.on("participant_disconnected")
    def on_participant_disconnected(_: object) -> None:
        browser_disconnected.set()

    @ctx.room.on("track_subscribed")
    def on_track_subscribed(
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        start_microphone_reader(track, publication, participant)

    @ctx.room.on("track_unsubscribed")
    def on_track_unsubscribed(
        _: rtc.Track | None,
        publication: rtc.RemoteTrackPublication,
        __: rtc.RemoteParticipant,
    ) -> None:
        stop_microphone_reader(publication.sid)

    await ctx.connect()
    logger.info("agent connected to room %s", room_name)

    for participant in ctx.room.remote_participants.values():
        for publication in participant.track_publications.values():
            if publication.track is not None:
                start_microphone_reader(publication.track, publication, participant)

    if not ctx.room.remote_participants:
        browser_disconnected.set()

    try:
        await browser_disconnected.wait()
        logger.info("browser disconnected from room %s", room_name)
        ctx.shutdown(reason="browser disconnected")
    finally:
        await stop_microphone_reader_task()


if __name__ == "__main__":
    cli.run_app(server)
