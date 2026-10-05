# Voice Companion

A real-time conversational voice companion built with React, FastAPI, and LiveKit Agents. It offers general emotional support; it is not a therapist or medical system. This application does not persist conversations.

## Voice flow

```text
Browser microphone → LiveKit room → AgentSession (Silero VAD + TurnDetector)
  → AssemblyAI STT → committed user transcript
  → Jev state analysis → text/acoustic fusion → conversation state → response strategy
  → OpenRouter LLM → Cartesia TTS → LiveKit audio track → browser speakers
```

`AgentSession` owns turn detection, interruption, generation, transcription, and agent audio publication. Acoustic observations use the same `AgentSession` audio input and only support conservative state fusion. The frontend receives native LiveKit transcripts and a small, room-scoped data payload for state, strategy, timing, and errors.

## Configure

Copy `backend/.env.example` to `backend/.env.local` and set real values:

```dotenv
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
OPENROUTER_API_KEY=your-openrouter-api-key
LLM_MODEL=openai/gpt-4.1-mini
JEV_MODEL=typesafe/jev-1.13
```

`LLM_MODEL` is sent to OpenRouter. LiveKit Inference uses the existing LiveKit credentials for AssemblyAI STT and Cartesia TTS. Keep credentials in `backend/.env.local`; the browser receives only a room-scoped LiveKit token.

## Run locally

Start each process in a separate PowerShell terminal:

```powershell
Set-Location backend
uv sync
uv run uvicorn src.api:app --reload --host 127.0.0.1 --port 8001
```

```powershell
Set-Location backend
uv run python src/agent.py dev
```

```powershell
Set-Location frontend
npm.cmd install
npm.cmd run dev
```

Open the Vite URL, usually `http://localhost:5173`. Create a session, connect, and enable the microphone. If browser autoplay blocks remote audio, select **Enable audio**.

## What the UI shows

The main view shows connection and microphone controls, listening/thinking/speaking state, native transcripts, the current conversational state and chosen response strategy, and the latest measured response latency. The collapsible **Diagnostics** section contains endpointing delay, LLM time to first token, TTS time to first audio, conditional interruption stop timing, and a short turn timeline.

Response latency prefers LiveKit's `ChatMessage.metrics.e2e_latency`, measured from detected user speech end to the agent's first audio frame in the worker. If LiveKit omits that value, the UI labels an estimate from its user-speech-end and first-audio state events. Neither value measures when sound becomes audible in the browser. Endpointing is reported separately for its committed user item from `end_of_turn_delay`; it is not guessed from the response. LLM and TTS timings prefer the completed assistant item's native metrics; late provider first-token/first-audio callbacks are attached to that same assistant item. Full provider traces and usage belong in LiveKit Agent Insights.

The backend keeps `speech_id` and assistant item ownership so late events cannot replace a newer response. The frontend also rejects events from a prior room, retains detailed timings under their completed assistant item, and keeps the last valid response latency visible until a new measurement exists. Interruption stop timing is a worker-side interval shown only when LiveKit marks the response interrupted; it is not browser silence timing.

## Verify

```powershell
Set-Location backend
$env:PYTHONPATH='.'
uv run pytest -q

Set-Location ..\frontend
node --experimental-strip-types --test tests/reliability.test.mjs
npm.cmd run lint
npm.cmd run build
```

With the API, worker, and frontend running, speak one complete turn and confirm the transcript, state/strategy, response audio, response latency, and detailed timings. Then test multiple turns, a real interruption, rapid short turns, reconnect, and a provider or connection error. Confirm that late metrics stay with their original response and that a prior room cannot update the new view. These live checks require working credentials, a microphone, and a browser session.
