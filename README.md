# Voice Companion

An in-progress real-time voice companion built with React, FastAPI, and
LiveKit. Phase 1C provides a complete browser microphone to LiveKit Inference
AssemblyAI STT to OpenRouter LLM to LiveKit Inference Cartesia TTS conversation loop.

It is a general supportive conversation experience, not a therapist,
diagnostic system, medical device, or crisis-response service. Conversations
are not persisted by this application.

## Architecture

```text
React browser -- POST /api/session --> FastAPI
     |                                  |
     | <--- room URL and participant JWT|
     |                                  |-- dispatch companion-agent
     v                                  v
                       LiveKit room
     microphone --> RoomIO / AgentSession --> LiveKit Inference STT
                                                  |
                                            OpenRouter LLM
                                                  |
                                            LiveKit Inference TTS
                                                  |
     browser speakers <--- LiveKit agent audio track
```

`AgentSession` owns microphone input, VAD turn handling, conversation history,
LLM orchestration, native transcriptions, and agent audio publication. The
frontend uses that same room for remote agent audio and native transcription
events. The custom data channel carries only session state, committed-item
latency, usage summaries, and sanitized errors.

## Configure

Copy `backend/.env.example` to `backend/.env.local`, then set real values:

```dotenv
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
OPENROUTER_API_KEY=your-openrouter-api-key
LLM_MODEL=openai/gpt-4.1-mini
```

`LLM_MODEL` is passed directly to OpenRouter. The worker does not configure
automatic routing or a fallback model. LiveKit Inference uses the existing
`LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`, so no AssemblyAI, Cartesia, or
Deepgram credential is required. TTS uses LiveKit's documented Cartesia
Jacqueline voice (`9626c31c-bec5-4cca-baa8-f8ba9e84c8bc`). Keep backend
credentials in `backend/.env.local`; React receives only a room-scoped LiveKit token.

## Run locally

Start each process in a separate PowerShell terminal.

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

Open the Vite URL (normally `http://localhost:5173`), create and connect a
session, enable the microphone, and—if the browser asks—select **Enable audio**
before expecting the agent's voice.

## What the UI reports

- Native interim/final user transcripts and speech-synchronized agent text.
- Committed user and assistant conversation items.
- User and agent session state, including agent thinking and speaking.
- The configured OpenRouter model.
- Latest completed-turn latency, in milliseconds:
  - **LLM first token** is `ChatMessage.metrics.llm_node_ttft`.
  - **LLM generation** is the sum of non-cancelled OpenRouter plugin request durations for the response.
  - **TTS first audio chunk** is `ChatMessage.metrics.tts_node_ttfb`.
  - **TTS generation** is the sum of non-cancelled Cartesia plugin durations across streamed response segments.
  - **Speech end → agent audio (server)** is `ChatMessage.metrics.e2e_latency`, from the SDK's detected end of user speech until RoomIO starts the agent's first audio frame.
- Session usage summaries, provider errors, and a chronological event timeline.

These are server-side processing and RoomIO measurements. In particular,
**Speech end → agent audio (server)** is not verified audible browser playback;
browser buffering, network delivery, output routing, and autoplay permission
remain outside that clock. The remote audio track stays attached across turns,
so its `playing` event cannot reliably measure per-response audible latency.

The earlier independent backend PCM reader, its `AudioStream` task lifecycle,
and `peak_pcm` diagnostics were removed. The UI keeps microphone publication,
AgentSession user-state indicators, and one local Web Audio input-level sample.
It does not poll device settings or RTP sender statistics.

## Checks

```powershell
Set-Location backend
uv run python -m compileall src

Set-Location ..\frontend
npm.cmd run lint
npm.cmd run build
```

For a live check, verify a complete spoken turn, follow-up context, mute and
unmute, disconnect during generation, reconnect, and that old-session events
do not update the new view. Without valid LiveKit project and OpenRouter
credentials, the worker reports the missing configuration in the room rather
than claiming speech generation is available.
