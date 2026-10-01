# Voice Companion

An in-progress real-time voice companion built with React, FastAPI, and
LiveKit. Phase 2A keeps the Phase 1C browser microphone to LiveKit Inference
AssemblyAI STT to OpenRouter LLM to LiveKit Inference Cartesia TTS conversation
loop and adds turn-detection and endpointing visibility.

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

`AgentSession` owns microphone input, Silero VAD and LiveKit TurnDetector turn
handling, conversation history,
LLM orchestration, native transcriptions, and agent audio publication. The
frontend uses that same room for remote agent audio and native transcription
events. The custom data channel carries only session state, turn timing and
configuration, committed-item latency, usage summaries, and sanitized errors.

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
- Timestamped VAD speech-start/speech-end, committed user-item, agent-thinking,
  and agent-speaking lifecycle events.
- Current-turn speech span, end-of-turn decision delay, final-transcript delay,
  and committed-item-to-agent-thinking delay.
- The active Silero VAD, LiveKit TurnDetector model, and endpointing configuration,
  including which values are configured versus inherited defaults.
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

Phase 2A Experiment 1 keeps Silero's `0.55` second minimum silence duration,
sets turn detection to `inference.TurnDetector()`, and explicitly configures
fixed endpointing with a `0.5` second minimum and `3.0` second maximum. It also
keeps preemptive generation disabled. LiveKit Agents 1.8.3 uses tighter
`0.3`/`2.5` second endpoint defaults for a streaming detector when delays are
omitted; both delays and the fixed mode are explicitly supplied here. Silero
remains required by TurnDetector and its existing silence duration exceeds the
SDK's `0.25` second minimum.

The UI's Phase 2A test area contains three manual scenarios. For Test A, record
end-of-turn delay, speech end → agent audio, and LLM TTFT. For Test B, pause
approximately one second between the phrases and check whether USER_TURN_COMMITTED
or AGENT_THINKING occurs during the pause, or whether both phrases stay in one
user turn. For Test C, record end-of-turn delay and the commit time after the
long silence.

### Manual comparison

Record results from the same environment and providers for each configuration.
Do not replace the earlier baseline sample with Experiment 1 results.

| Configuration | EOT delay | Speech→audio | Hesitation result |
| --- | --- | --- | --- |
| VAD + fixed | baseline/manual | baseline/manual | baseline/manual |
| TurnDetector + fixed | to test | to test | to test |

## Checks

Phase 2B explicitly requests LiveKit's adaptive interruption mode. The SDK
still owns interruption, speech pause/resume, and cancellation. Its defaults
remain enabled, 0.5 s minimum speech, 0 minimum words, a 2.0 s false
interruption timeout, automatic false interruption resume, and a 1.0 s
backchannel boundary at each end of agent speech. The streaming AssemblyAI
STT and Silero VAD meet the SDK's adaptive path requirements. With the
configured LiveKit credentials, the detector can use LiveKit Inference; the
SDK falls back to VAD if detector creation or inference fails. The UI labels
the configured mode and shows native overlap events when the adaptive detector
actually makes a decision. A live microphone run is needed to verify that
remote inference is available and to compare "OK" with the earlier baseline.

During interruption, AgentSession decides whether to interrupt its current
SpeechHandle, stops or pauses RoomIO audio output, and marks any forwarded
assistant ChatMessage as interrupted. The React diagnostics display that
native item flag, overlap verdict and detector timings, plus a local worker
elapsed time from user speech start to the agent leaving `speaking`. That
worker elapsed time does not measure when the browser speaker becomes silent.
The five Checkpoint 2B acoustic scenarios are listed in the UI and require
manual observation; no result is presumed.

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
