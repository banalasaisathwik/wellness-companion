# Luna — Voice Companion

A real-time voice companion built with LiveKit Agents that adapts its response strategy using the user's conversational and acoustic state.

The project is not just an STT → LLM → TTS demo. It focuses on the engineering problems that make realtime voice systems difficult:

- turn detection and endpointing
- response latency attribution
- acoustic + textual state analysis
- strategy-conditioned responses
- interruption / barge-in
- transcript ownership
- late asynchronous metrics
- browser audio playback
- observability and debugging

---

## Why I built this

A basic voice agent is straightforward:

```text
Microphone
   ↓
STT
   ↓
LLM
   ↓
TTS
   ↓
Speaker
```

The harder problem is making that pipeline feel conversational.

A system can technically work while still feeling unusable if the user stops speaking and waits several seconds before hearing a response.

The main goal of this project became:

> Build a voice agent where I can measure exactly where every millisecond goes, understand why the delay exists, and improve the system without hiding the complexity behind framework abstractions.

---

## Current architecture

```text
Browser microphone
        ↓
      LiveKit
        ↓
AssemblyAI streaming STT
        ↓
Silero VAD + LiveKit TurnDetector
        ↓
Current-turn acoustic/text features
        ↓
JEV state classifier
        ↓
Deterministic strategy selection
        ↓
OpenRouter conversational LLM
        ↓
Cartesia TTS
        ↓
LiveKit audio output
        ↓
Browser playback
```

The key behavioral flow is:

```text
current user turn
      ↓
acoustic + textual state
      ↓
response strategy
      ↓
same-turn LLM response
```

State analysis is not only a UI visualization. It changes how the agent responds.

For example:

```text
User:
"I don't want advice. I just want to talk."

State:
low energy / stressed

Strategy:
LISTEN

Response:
supportive listening instead of immediately giving advice
```

---

## Source navigation

`backend/src/agent.py` remains the realtime entrypoint: prewarm VAD, construct
job-scoped providers, create the session, register callbacks, start RoomIO, handle
committed turns, then close the session and JEV client.

- `providers.py`: STT, VAD, turn detector, main LLM, TTS, and JEV-client construction.
- `acoustics.py`: the existing LiveKit audio-input adapter, forwarding the same PCM frames.
- `conversation/features.py`: acoustic/text accumulation and per-session baselines.
- `conversation/state.py`: JEV questions/request/parsing, state models, fusion, and merge.
- `conversation/strategy.py`: deterministic strategy selection and turn-scoped instructions.
- `metrics.py`: diagnostic sanitization, timings, and late metric ownership.
- `api.py`: health and session/token endpoints.

`frontend/src/App.tsx` remains the page coordinator: create a session, wire room
events, connect, start audio, wait for Luna to listen, then enable the microphone.
It retains transcript grouping, room/turn ownership, stale-event checks, and cleanup.

- `voice/session.ts`: session requests, readiness waits, listener removal, and session errors.
- `voice/audio.ts`: remote audio elements, track attachment, and playback status.
- `voice/types.ts`: shared startup and panel data shapes.
- `conversation.ts`: transcript updates and validation of backend state payloads.
- `reliability.ts`: metric parsing/formatting, ownership checks, and late metric merging.
- `components/ConversationPanel.tsx`: already-grouped conversation bubbles.
- `components/StatePanel.tsx`: backend state/confidence and selected strategy.
- `components/VoiceControls.tsx`: session buttons calling App callbacks.
- `components/DebugPanel.tsx`: diagnostics and timing presentation from App data.

## Engineering journey

### 1. First working version

The first working realtime pipeline used:

```text
AssemblyAI STT
      ↓
Silero VAD
      ↓
OpenRouter LLM
      ↓
Cartesia TTS
```

The pipeline worked, but normal voice-response latency was around:

```text
~7–8 seconds
```

Instead of immediately switching models or providers, I added per-turn measurements and treated latency as a critical-path problem.

A representative early trace looked like:

| Stage | Latency |
|---|---:|
| Turn detection | ~3000 ms |
| Turn processing | ~3000 ms |
| LLM first speakable text | ~1250–1500 ms |
| TTS first audio | ~140 ms |
| Voice response | ~7400–8000 ms |

This immediately showed that TTS was not the main problem.

Most of the latency happened before response generation even started.

---

### 2. Making the pipeline observable

The Debug UI was expanded to show real per-turn timings such as:

- Final transcript after speech
- Turn detection
- Turn processing
- LLM first token
- First speakable text
- TTS first audio
- Audio output start
- Voice response

The important rule was:

> Do not optimize a stage until its actual latency is measured.

This prevented several wrong conclusions later.

---

### 3. Live acoustic feature extraction

The agent uses current-turn acoustic and text features to classify conversational state.

Cheap acoustic features are updated while the user is still speaking instead of processing the full recording after the turn ends.

Examples include:

```text
utterance duration
speech duration
pause ratio
speech ratio
average energy
peak energy
speech rate
```

Streaming STT partials are also used to maintain the current text state.

At turn completion, only a compact feature summary needs to be finalized before classification.

This keeps feature preparation effectively negligible.

---

### 4. Bottleneck: state processing looked like ~3 seconds

Early metrics showed:

```text
Turn processing       ~2993 ms
State analysis        ~2973 ms
```

At first this looked like the JEV classifier itself was too slow.

So the callback was split into smaller measurements:

```text
Feature finalization
JEV client setup
JEV classification
State parsing
State publication
Strategy selection
Other overhead
```

That revealed the real issue.

A representative breakdown:

| Stage | Latency |
|---|---:|
| Feature finalization | <1 ms |
| JEV client setup | **1472 ms** |
| JEV classification | **477 ms** |
| State parsing | 1 ms |
| State publication | 6 ms |
| Strategy selection | <1 ms |
| Total turn processing | 1981 ms |

The classifier was not actually the major problem.

The expensive part was repeatedly constructing the JEV/OpenRouter client inside the turn path.

---

### 5. Fix: reuse the JEV client

Before:

```text
Turn 1 → create client → classify
Turn 2 → create client → classify
Turn 3 → create client → classify
```

After:

```text
Room job starts
      ↓
create classifier once

Turn 1 → reuse client → classify
Turn 2 → reuse client → classify
Turn 3 → reuse client → classify
```

After this change:

```text
JEV client setup      removed from turn path
JEV classification    ~384 ms
Turn processing       ~389 ms
```

This removed roughly 1.5 seconds from some turns without changing the state → strategy → response architecture.

---

### 6. Bottleneck: ~3 second turn detection

Another repeated pattern appeared:

```text
Turn detection:
3007 ms
3005 ms
3012 ms
3000 ms
```

The consistency was the clue.

The system was repeatedly reaching approximately the configured maximum endpointing window.

Even when the transcript was already available, the voice pipeline could still wait several seconds before accepting the user turn.

Endpointing was then tuned and tested carefully instead of simply making it aggressively fast.

Turn detection moved from roughly:

```text
~3000 ms
```

toward:

```text
~1200–1500 ms
```

This reduced latency significantly while still preserving natural pauses.

---

### 7. STT finalization vs endpointing

One important lesson was that these metrics overlap:

```text
Final transcript after speech
Turn detection
```

Both start at speech end.

They must not be added together.

For example:

```text
Final transcript       640 ms
Turn detection        1203 ms
```

means the additional wait after the transcript became available was roughly:

```text
1203 - 640
= 563 ms
```

The Debug UI therefore also shows:

```text
Post-transcript turn wait
```

This helps answer:

> Is the delay coming from STT finalization or from LiveKit endpointing after the transcript is already ready?

That distinction prevented tuning the wrong component.

---

### 8. Dynamic endpointing experiments

The project tested:

```text
fixed endpointing
        ↓
dynamic endpointing
```

while preserving:

```text
min delay
max delay
turn detector
VAD
STT provider
```

The goal was not simply to minimize latency.

For a reflective companion, this matters:

```text
"I don't know..."
[pause]
"...maybe I'm just tired."
```

A voice agent that responds during that pause feels worse even if its benchmark latency is lower.

So every endpointing experiment was evaluated against both:

- latency
- natural pause behavior

---

### 9. Main LLM latency diagnosis

After the large architecture problems were removed, the main conversational LLM became one of the largest remaining stages.

Typical measurements:

```text
LLM request preparation     <1 ms
Pre-request overhead        ~20–50 ms
LLM first token             ~900–1150 ms
First speakable text        ~1150–1480 ms
```

The main LLM client was already reused once per room job.

The prompt/context was also relatively small:

```text
~350–450 input tokens
```

So the remaining first-token delay was mostly genuine model/provider latency rather than local application overhead.

---

### 10. GPT-4.1 Mini vs Nano

The conversational LLM was kept configurable through:

```text
LLM_MODEL
```

Two models were compared through the same OpenRouter path:

```text
openai/gpt-4.1-mini
openai/gpt-4.1-nano
```

Example measurements:

```text
GPT-4.1-mini TTFT:
~1070–1130 ms

GPT-4.1-nano TTFT:
~890–1020 ms
```

Nano was somewhat faster, but the improvement was not large enough to automatically justify a quality trade-off.

The project therefore keeps model selection configurable rather than hardcoding the lowest-latency option.

---

### 11. TTS was never the main bottleneck

Cartesia consistently produced first audio around:

```text
~130–200 ms
```

and worker audio output typically began almost immediately afterward.

That meant swapping TTS providers would have been optimization in the wrong place.

The measurements made this obvious.

---

## Representative latency

A recent representative turn:

| Stage | Latency |
|---|---:|
| Final transcript | 640 ms |
| Turn detection | 1203 ms |
| Turn processing | 591 ms |
| LLM first token | 1152 ms |
| First speakable text | 1482 ms |
| TTS first audio | 138 ms |
| **Voice response** | **3438 ms** |

Other turns reached approximately:

```text
~3.1 seconds
```

compared with the original:

```text
~7–8 seconds
```

The goal is not to claim one artificially perfect latency number.

Latency varies with:

- user speech pattern
- STT finalization
- provider/model latency
- network conditions
- endpointing behavior
- interruptions

The important result is that the critical path is now observable and explainable.

---

## Interruption and barge-in

Realtime voice introduces another issue: asynchronous events do not always arrive in conversational order.

Conceptually:

```text
Luna speaking
      ↓
user starts speaking
      ↓
native LiveKit interruption
      ↓
assistant speech stops
      ↓
new user turn begins
```

The project relies on LiveKit's native interruption ownership instead of building a custom audio cancellation queue.

---

### Turn ownership

Late metrics from an old response must never overwrite the newest response.

Each turn keeps ownership information such as:

```text
session_id
speech_id
assistant item_id
local turn sequence
```

Late metrics merge back into the turn that produced them.

This became especially important during barge-in and interrupted responses.

---

## Missing metrics are sometimes correct

Not every response produces every metric.

For example:

```text
Interrupted           true
Speech ID             present
Assistant item ID     —
LLM first token       —
TTS first audio       —
```

This can be valid.

If the assistant is interrupted before those stages are reached, there is no real metric to display.

The Debug UI therefore uses:

```text
—
```

for unavailable measurements instead of fabricating:

```text
0 ms
```

---

## Transcript grouping

Streaming STT produces many intermediate transcript updates.

The UI does not create a new message for every partial update.

Instead:

```text
partial
partial
partial
final
```

all update the same user turn.

After the agent responds, the next user speech starts a new turn.

A barge-in also starts a new user turn.

---

## Debug philosophy

The project evolved around one simple rule:

> Measure the stage before optimizing the stage.

Examples:

```text
"JEV takes 3 seconds"
```

turned out to be:

```text
JEV client setup       ~1.5 s
actual classification  ~0.5 s
```

and:

```text
"STT is slow"
```

sometimes turned out to be:

```text
STT ready quickly
endpointing still waiting
```

Without stage-level instrumentation, both problems would have looked like generic "voice latency."

---

## Important long-term metrics

The main Debug view keeps only the metrics that are useful for understanding the critical path.

| Metric | Meaning |
|---|---|
| Voice response | user speech end → agent response begins |
| Final transcript | speech end → final STT transcript |
| Turn detection | speech end → user turn accepted |
| Turn processing | state analysis + strategy callback |
| LLM first token | generation start → first token |
| First speakable text | generation start → first TTS-ready text |
| TTS first audio | TTS input → first returned audio |

Advanced Debug can additionally expose:

```text
JEV classification
post-transcript turn wait
token → speakable gap
input/output tokens
interruption ownership
session state
provider/model details
```

The normal Luna UI remains intentionally clean.

---

## Why I stopped optimizing around ~3 seconds

The current latency could probably be reduced further using:

```text
preemptive generation
speculative generation
parallel state analysis
more aggressive endpointing
different providers
direct-provider routing
```

But the next improvements have larger trade-offs.

The current-turn response depends on:

```text
current acoustic/text state
      ↓
JEV
      ↓
strategy
      ↓
LLM response
```

Starting the main LLM too early could produce:

```text
generate speculative response
      ↓
JEV finishes
      ↓
strategy changes context
      ↓
discard response
      ↓
generate again
```

That may improve perceived latency in some situations but also introduces:

- extra complexity
- wasted tokens
- more cancellation behavior
- harder debugging
- less predictable turn ownership

For this project, the latency work was stopped once the system became substantially faster, observable, understandable, and stable.

---

## What I learned

Realtime Voice AI latency is not simply:

```text
STT latency + LLM latency + TTS latency
```

A production-style realtime path also contains:

```text
speech endpointing
transcript finalization
turn acceptance
application callbacks
state classification
strategy selection
LLM scheduling
sentence buffering
TTS generation
audio forwarding
browser playback
```

Any one of those stages can dominate the experience.

The biggest improvement did not come from choosing the fastest model.

It came from having enough observability to identify the actual bottleneck.

---

## Key result

> Reduced measured voice-response latency from roughly **7–8 seconds** to around **3–3.5 seconds** by instrumenting the realtime critical path, removing repeated classifier-client initialization, tuning turn handling, and preserving same-turn state-aware response generation.

---

## Current stack

### Backend

- Python
- LiveKit Agents 1.8.3
- FastAPI
- asyncio

### Voice pipeline

- AssemblyAI Universal Streaming — STT
- Silero — VAD
- LiveKit TurnDetector
- JEV via OpenRouter — conversational state classifier
- OpenRouter — conversational LLM
- Cartesia Sonic — TTS

### Frontend

- React
- Vite
- TypeScript
- LiveKit browser client

---

## Requirements

- Windows with PowerShell
- Python 3.13 or later and [uv](https://docs.astral.sh/uv/)
- Node.js and npm
- A LiveKit project configured for the providers used by LiveKit Inference (AssemblyAI STT and Cartesia TTS)
- An OpenRouter API key with access to the selected language and JEV models

Keep service credentials in the backend. The browser receives a short-lived, room-scoped LiveKit token from the API.

## Configuration

From the repository root, create the local backend environment file:

```powershell
Copy-Item backend/.env.example backend/.env.local
```

Set these values in `backend/.env.local`:

| Variable | Purpose |
| --- | --- |
| `LIVEKIT_URL` | LiveKit server URL, such as `wss://your-project.livekit.cloud` |
| `LIVEKIT_API_KEY` | Server-side LiveKit API key |
| `LIVEKIT_API_SECRET` | Server-side LiveKit API secret |
| `OPENROUTER_API_KEY` | OpenRouter key used by state analysis and response generation |
| `LLM_MODEL` | OpenRouter model for conversation responses, for example `openai/gpt-4.1-mini` |
| `JEV_MODEL` | Optional state-analysis model; defaults to `typesafe/jev-1.13` |

Do not put credentials in frontend files or commit `backend/.env.local`.

## Local development

Start the API, worker, and frontend in separate PowerShell terminals from the repository root.

### Backend API

```powershell
Set-Location backend
uv sync
uv run uvicorn src.api:app --reload --host 127.0.0.1 --port 8001
```

### Voice worker

```powershell
Set-Location backend
uv run python src/agent.py dev
```

### Frontend

```powershell
Set-Location frontend
npm.cmd ci
npm.cmd run dev
```

Open the Vite URL printed in the terminal (usually `http://localhost:5173`), create a session, connect, and enable the microphone. Vite forwards `/api` requests to the API on port `8001`. If browser autoplay blocks remote audio, use the **Enable audio** control.

The API serves `/health` and creates a LiveKit room token at `/session`. The worker registers as `companion-agent` and handles rooms dispatched by the API.

---

## Verification

The project has been tested across areas including:

- voice-session creation
- microphone publishing
- STT transcription
- current-turn state classification
- strategy selection
- LLM generation
- TTS playback
- transcript grouping
- turn ownership
- interruption handling
- late metric merging
- latency instrumentation
- frontend debug visualization

Backend and frontend tests, linting, build checks, and manual live voice testing were used throughout the optimization process.

To rerun the local automated checks:

```powershell
# Backend (from backend)
uv run python -m pytest -q

# Frontend (from frontend)
npm.cmd run lint
npm.cmd run build
node --experimental-strip-types --test tests/*.test.mjs
```

Automated checks do not prove provider access, microphone capture, interruptions, or browser audio playback. Those require a live browser session with working credentials.

---

## Project philosophy

The goal was not to hide everything behind a voice-agent framework.

The goal was to understand the flow:

```text
audio
  ↓
turn
  ↓
state
  ↓
strategy
  ↓
response
  ↓
speech
```

and to know where the time goes when that flow becomes slow.

That is the main engineering lesson behind Luna.
