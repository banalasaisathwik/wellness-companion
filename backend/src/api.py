import os
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
import httpx
from livekit import api


load_dotenv(Path(__file__).resolve().parents[1] / ".env.local")


app = FastAPI()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/session")
async def create_session() -> dict[str, str]:
    server_url = os.getenv("LIVEKIT_URL")
    api_key = os.getenv("LIVEKIT_API_KEY")
    api_secret = os.getenv("LIVEKIT_API_SECRET")

    if not server_url or not api_key or not api_secret:
        raise HTTPException(status_code=503, detail="LiveKit is not configured.")

    if worker_url := os.getenv("VOICE_WORKER_HEALTH_URL"):
        try:
            async with httpx.AsyncClient(timeout=3.0, trust_env=False) as client:
                health = await client.get(worker_url)
                health.raise_for_status()
                worker = await client.get(f"{worker_url}/worker")
                worker.raise_for_status()
                active_jobs = worker.json().get("active_jobs", 0)
        except (httpx.HTTPError, ValueError):
            raise HTTPException(status_code=503, detail="Luna is still starting. Please try again shortly.") from None
        if active_jobs >= 1:
            raise HTTPException(status_code=409, detail="Luna is in another session. Please try again when it ends.")

    room_name = f"voice-companion-{uuid4().hex}"
    participant_identity = f"participant-{uuid4().hex}"
    token = (
        api.AccessToken(api_key, api_secret)
        .with_identity(participant_identity)
        .with_ttl(timedelta(minutes=30))
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room_name,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True,
                can_publish_sources=["microphone"],
            )
        )
        .with_room_config(
            api.RoomConfiguration(
                agents=[api.RoomAgentDispatch(agent_name="companion-agent")]
            )
        )
        .to_jwt()
    )

    return {
        "server_url": server_url,
        "token": token,
        "room_name": room_name,
        "participant_identity": participant_identity,
    }
