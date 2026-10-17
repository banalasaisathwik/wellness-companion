import os
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from livekit import api


load_dotenv(Path(__file__).resolve().parents[1] / ".env.local")


app = FastAPI()

frontend_origins = [origin.strip() for origin in os.getenv('FRONTEND_ORIGIN', '').split(',') if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=frontend_origins,
    allow_methods=['POST', 'OPTIONS'],
    allow_headers=['Content-Type'],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/session")
def create_session() -> dict[str, str]:
    server_url = os.getenv("LIVEKIT_URL")
    api_key = os.getenv("LIVEKIT_API_KEY")
    api_secret = os.getenv("LIVEKIT_API_SECRET")

    if not server_url or not api_key or not api_secret:
        raise HTTPException(status_code=503, detail="LiveKit is not configured.")

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
