"""Construct voice providers; agent.py owns their job/session lifetime."""

import httpx
from livekit.agents import inference
from livekit.plugins import openai, silero

if __package__:
    from .conversation.state import JEV_TIMEOUT_SECONDS
else:
    from conversation.state import JEV_TIMEOUT_SECONDS


VAD_MIN_SILENCE_SECONDS = 0.55


def create_vad():
    return silero.VAD.load(min_silence_duration=VAD_MIN_SILENCE_SECONDS)


def create_llm(model: str):
    return openai.LLM.with_openrouter(model=model)


def create_tts():
    return inference.TTS(
        model="cartesia/sonic-3",
        voice="9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
        language="en",
    )


def create_turn_detector():
    return inference.TurnDetector()


def create_stt():
    return inference.STT(
        model="assemblyai/universal-streaming",
        language="en",
        extra_kwargs={"max_turn_silence": 1000},
    )


def create_classifier() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=JEV_TIMEOUT_SECONDS)
