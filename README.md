# Voice Companion

A work-in-progress real-time voice companion built with React, FastAPI, and
LiveKit. The current milestone proves the audio transport: a browser joins a
room, publishes its microphone, and a Python agent receives decoded PCM audio
and returns live diagnostic metrics.

It does **not** yet provide speech recognition, generated responses, text to
speech, therapy, medical advice, or crisis support.

## Current capabilities

- FastAPI creates an isolated LiveKit room and short-lived participant token.
- A LiveKit Agents worker named `companion-agent` is dispatched to that room.
- The React app connects with the returned token and publishes the user's real
  microphone after an explicit action.
- The worker reads microphone PCM frames and sends lightweight audio metrics to
  the browser over LiveKit's data channel.
- The UI shows actual room, microphone, connection, and metric-stream state;
  it does not simulate a connection or audio activity.

## Architecture

```text
React browser -- POST /api/session --> FastAPI
     |                                  |
     | <--- room URL and participant JWT|
     |                                  |-- dispatch companion-agent
     v                                  v
                   LiveKit room
                  /            \\
     microphone audio track     data messages: audio_metrics
               |                         ^
               v                         |
        Python LiveKit Agents worker -----
```

The microphone is an audio track. The return path contains only small JSON
diagnostics such as frame count and peak PCM level; raw audio is never sent
back to the frontend as telemetry.

## Repository layout

```text
voice-companion/
├── backend/
│   ├── .env.example       # Required LiveKit variable names
│   ├── pyproject.toml     # Python dependencies managed with uv
│   └── src/
│       ├── api.py         # GET /health and POST /session
│       └── agent.py       # companion-agent and PCM metrics reader
├── frontend/
│   ├── src/App.tsx        # Room lifecycle, microphone controls, diagnostics
│   ├── vite.config.ts     # /api proxy to FastAPI on port 8001
│   └── package.json       # React, TypeScript, Vite commands
└── README.md
```

## Prerequisites

- Python 3.13 or later and [uv](https://docs.astral.sh/uv/)
- Node.js and npm
- A LiveKit Cloud project (or compatible LiveKit server)
- A browser with microphone access

## Configure LiveKit

From the repository root, copy `backend/.env.example` to
`backend/.env.local`, then replace the placeholder values:

```dotenv
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
```

Keep `.env.local` private. The API key and secret stay in the backend; the
frontend receives only the LiveKit server URL and a room-scoped participant
token.

## Run locally

Start these services in separate PowerShell terminals.

### 1. API

```powershell
Set-Location backend
uv sync
uv run uvicorn src.api:app --reload --host 127.0.0.1 --port 8001
```

The health endpoint is available at `http://127.0.0.1:8001/health`.

### 2. LiveKit worker

```powershell
Set-Location backend
uv run python src/agent.py dev
```

The worker must be running before a session is created, because the backend
dispatches it as `companion-agent`.

### 3. Frontend

```powershell
Set-Location frontend
npm.cmd install
npm.cmd run dev
```

Open the Vite URL printed by the command (normally
`http://localhost:5173`). The frontend proxies `/api/*` to FastAPI on port
8001, so its health check calls `/api/health` and its session request calls
`/api/session`.

## Use the app

1. Wait for **Backend connected**.
2. Select **Create session**. This calls `POST /api/session`.
3. Select **Connect** to join the new LiveKit room.
4. Select **Enable mic** and allow browser microphone access.
5. Speak. The diagnostics panel should begin receiving real audio metrics.
6. Use **Mute**, **Unmute**, or **End** to change the actual LiveKit session.

## Request and event flow

1. `GET /health` returns `{"status":"ok"}` for the frontend health check.
2. `POST /session` validates the backend LiveKit configuration, generates a
   unique room and participant identity, creates a 30-minute token, and
   requests the `companion-agent` dispatch.
3. `App.tsx` connects a `Room` with the returned server URL and token.
4. `agent.py` accepts the dispatched job and joins that same room.
5. When the browser publishes a microphone track, the worker reads its decoded
   `AudioStream` frames.
6. About once per second the worker publishes an `audio_metrics` JSON message.
7. The frontend validates that message before displaying it. On disconnect it
   removes listeners, clears metrics, and closes the local room connection.

## Audio diagnostics

The current diagnostics are transport observability, not emotion analysis or
voice activity detection:

| Field | Meaning |
| --- | --- |
| Frames received | Cumulative decoded audio frames received by the worker |
| Sample rate | Sample rate of the latest received frame |
| Channels | Channel count of the latest received frame |
| Samples / channel | Samples per channel in the latest frame |
| Peak PCM | Largest absolute PCM sample in the most recent reporting interval |

## Verify changes

Run checks from their respective projects:

```powershell
Set-Location backend
uv run python -m compileall src

Set-Location ..\frontend
npm.cmd run lint
npm.cmd run build
```

For an end-to-end check, run all three services, create and connect a session,
enable the microphone, and confirm that worker logs and the frontend
diagnostics both show incoming frames. Also test a denied microphone permission
and confirm the UI reports the failure without claiming the microphone is live.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `Backend unavailable` | Confirm the API is running on port 8001 and open `/health`. |
| Session cannot be created | Verify all three `LIVEKIT_*` values exist in `backend/.env.local`; do not place them in frontend files. |
| Connection fails | Confirm the server URL is a valid LiveKit WebSocket URL and the worker is registered as `companion-agent`. |
| No metrics after enabling the mic | Confirm browser permission was granted, the microphone is publishing, and the worker terminal is running. |
| `uv` cache permission error | Use a writable, project-local `UV_CACHE_DIR` for the command; no application change is required. |

## Privacy and scope

This project is a supportive conversational application under development. It
is not a therapist, diagnostic system, medical device, or crisis-response
service. Sensitive conversation storage is not enabled by default. Future
speech, conversation, and safety features will be documented separately as
they are implemented.
