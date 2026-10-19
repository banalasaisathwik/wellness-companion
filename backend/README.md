# Backend deployment on one Render Free web service

## Current free-instance configuration

LiveKit Agents and the OpenAI/Silero plugins are locked to **1.8.6**. The launcher
sets `LIVEKIT_AGENTS_PRELOAD_LOCAL_INFERENCE=0` before starting either child.
This version honors the flag; 1.8.3 did not. Turn detection explicitly uses
cloud `v1` with `local_fallback=False`, so it cannot load the local mini model
when the gateway fails. This requires LiveKit Inference access.

The worker keeps **zero idle processes** and reports full load while one room
is active. The SDK also reserves pending assignments before launching jobs.
Silero still loads once in the room job. The worker's internal health endpoint
listens only on `127.0.0.1:8081`; FastAPI remains on Render's public `$PORT`.
In the combined launcher, `/session` checks that the worker is reachable and
returns 503 during startup or 409 while busy instead of returning a misleading
successful token response. `/health` remains API liveness only.

Every 30 seconds the launcher logs cgroup memory usage when available. Verify
the container stays below its 512 MB limit during startup, a call, and cleanup;
an idle successful deploy alone does not establish memory safety.

Vercel uses root directory `frontend`, build `npm run build`, output `dist`,
and production branch `master`, matching Render. `frontend/vercel.json` forwards
`/api/*` to this Render service. The browser permits 150 seconds for cold startup
and retries the worker's explicit starting response for up to 60 seconds.

Flow: browser → Vercel `/api/session` rewrite → Render API → LiveKit room token
and named dispatch → one cold worker job → `listening` event → microphone.
If the worker dies, the launcher stops both processes so Render restarts the
service. Do not replace `python start.py` with an API-only Uvicorn command.

The older initialization investigation below describes the previous 1.8.3
deployment and its unsuccessful one-idle-process configuration.

Use Render's Python runtime with **Root Directory: `backend`**. Keep Python
3.13 (the existing `.python-version` selects it for uv). If Render has a
`PYTHON_VERSION` override, it must be a fully qualified 3.13 patch release;
check the build log rather than relying on Render's default Python version.
See [Render's Python version settings](https://render.com/docs/python-version).

## Build and start commands

Build command (paste as one line):

```sh
env -u VIRTUAL_ENV UV_PROJECT_ENVIRONMENT=.venv uv sync --locked --no-dev && env -u VIRTUAL_ENV UV_PROJECT_ENVIRONMENT=.venv uv run --no-sync python -m livekit.agents download-files
```

Start command:

```sh
env -u VIRTUAL_ENV UV_PROJECT_ENVIRONMENT=.venv uv run --no-sync python start.py
```

Health check path: `/health`. This checks FastAPI only; it does **not** confirm
that the LiveKit worker has registered or can accept a voice session.

Keep the existing `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
`OPENROUTER_API_KEY`, `LLM_MODEL` and optional `JEV_MODEL` in Render's backend
environment settings. Do not put their values in commands, logs or frontend
configuration. STT, turn detection and Cartesia TTS continue to use LiveKit
inference; no additional provider clients are created during prewarm.

`uv sync --locked` installs exactly the committed lock and fails if it needs an
update. Both commands explicitly select the same `backend/.venv`. `env -u
VIRTUAL_ENV` removes Render's inherited active-environment marker for this
command, avoiding the mismatch with uv's project environment. It does not delete
an environment or select Render's unrelated activated environment. The warning
is normally about environment selection, not a LiveKit initialization error.
See [uv project environments](https://docs.astral.sh/uv/concepts/projects/config/).

The build runs the installed SDK's plugin asset downloader. In the locked
Silero 1.8.3 plugin, `silero_vad.onnx` is already bundled in the package;
`VAD.load()` opens that local file and initializes ONNX Runtime. The Silero
download hook has no extra download. OpenRouter and LiveKit inference run
remotely and do not need local STT/LLM/TTS model downloads. Normal startup does
not run package synchronization or a model download command. Loading the local
VAD into memory is still required for every new job process.

## Initialization investigation

`uv.lock` and the inspected local installation both use LiveKit Agents **1.8.3**.
Its `AgentServer` constructor supports `num_idle_processes` and
`initialize_process_timeout`; no compatibility wrapper or SDK upgrade is needed.

The installed SDK's relevant flow is:

1. `AgentServer` defaults its production idle target to
   `ceil(get_cpu_monitor().cpu_count())` and its process initialization deadline
   to **10 seconds**. With correct cgroup v2 detection, a 0.1 CPU quota already
   rounds up to one. If detection falls back to host cores, it can request a
   larger pool. There is no Render CPU-detection log proving which happened here.
2. On Linux, it uses job **processes** and `forkserver`. Plugin and framework
   imports/preloads, IPC bootstrap and the synchronous setup callback must all
   finish before a child is usable. The process initialization wait covers the
   child's response; the pool's initial readiness wait also covers scheduling
   and spawning and expires after `initialize_process_timeout + 2` seconds.
3. The pool logs `timed out waiting for idle processes to initialize` if its
   target is not warm by that deadline. This warning does not itself prove that
   Silero failed. Check adjacent `error initializing process`,
   `process initialization timed out`, child exceptions or platform OOM logs.
   The SDK can continue after the pool warning and retry failed children.
4. Our `prewarm()` only loads Silero. In the Linux job process this happens
   before its async event loop starts. The plugin already uses one ONNX intra-op
   and inter-op thread and disables thread spinning. Moving this work into the
   session loop or inventing new thread settings would not address this path.

The change fixes the idle target at **one** and gives process initialization a
bounded **60-second** deadline (pool startup wait: 62 seconds). This reduces
avoidable parallel warmup and allows slow cold imports/bootstrap to finish
instead of being killed after 10 seconds. The 60-second budget is conservative
headroom, not a measured Render optimum. One local SDK import took 12.734 seconds,
while a direct Silero load took 0.396 seconds. A separate actual subprocess
prewarm took 0.093 seconds. These are Windows measurements, not Render results
or a reproduction of the original failure.

The event-loop warnings describe delayed loop scheduling. CPU starvation can
cause this even without a long synchronous application callback. SDK/native
initialization or synchronous work elsewhere can also contribute. The supplied
565/786 ms warnings alone do not identify a stack or prove an application bug.
No session pipeline, provider construction order or latency measurement was
changed based on those warnings.

Use the new PID and duration logs to distinguish these cases on Render:

- Long delay before `Silero VAD prewarm started`: investigate imports, framework
  preload, process bootstrap, scheduling and memory pressure.
- Long prewarm duration: local ONNX/model initialization is taking the time.
- `Silero VAD prewarm failed`: inspect its traceback for a concrete model error.
- Prewarm completion followed by a timeout: investigate IPC/parent scheduling
  and other children before increasing the deadline again.

## Launcher flow and shutdown

`uv run` selects the project interpreter -> `start.py` starts Uvicorn and the
existing `src/agent.py start` worker using that same `sys.executable` -> the SDK
warms its idle child -> the worker connects to LiveKit -> normal room dispatch
and the existing voice pipeline continue.

`main()` returns an exit status. It polls the two child processes and exits with
a failure if either ends unexpectedly, including an unexpected zero exit (the
SDK CLI can log `worker failed` and still exit zero). A spawn error also fails
the launcher and stops any sibling already running. Child stdout/stderr are
inherited, so their failure reasons remain in Render logs.

`SIGTERM` and `SIGINT` request shutdown without doing blocking work in the signal
handler. `stop_processes(processes, shutdown_signal)` forwards the signal to each
live service leader, gives both a shared 20-second cleanup budget, then kills
remaining Linux process groups, including descendants of exited leaders, and
waits for direct children. Each service has its own process group. This avoids
the old shell command's unmanaged sibling and descendant processes. No process
manager dependency is added. Windows uses direct termination for local checks;
the descendant group cleanup targets Render/Linux.

The launcher is synchronous and separate from both services. Async room
connection, STT, analysis, responses and audio remain in their existing SDK/job
event loops. On redeploy or termination, a conversation exceeding the shutdown
budget can be cut off; Render's default shutdown delay is 30 seconds. See
[Render shutdown behavior](https://render.com/docs/deploys#graceful-shutdown).

## Startup logs and verification

Look for all of these message bodies (PIDs, timings and addresses vary; API and
worker logs may interleave):

```text
starting FastAPI
launched FastAPI pid=...
starting LiveKit agent
launched LiveKit agent pid=...
Application startup complete.
Uvicorn running on http://0.0.0.0:<PORT> (Press CTRL+C to quit)
starting worker
Silero VAD prewarm started pid=...
Silero VAD prewarm completed pid=... duration_seconds=...
process initialized
agent worker started idle_processes=1 initialize_timeout_seconds=60
registered worker
LiveKit worker registered agent_name=companion-agent
```

`LiveKit worker registered` is emitted by the SDK's real `worker_registered`
event, not by spawning the process. Registration alone does not prove a warm
child or a working voice session: require prewarm completion and process
initialization as well. `launched` only confirms process creation. A later
`agent assigned to room ...` confirms dispatch, not successful provider calls.

Local PowerShell checks, from the repository root:

```powershell
Set-Location backend
uv run python -m pytest -q
uv run --no-sync python -m livekit.agents download-files
# Starts both services; use a staging LiveKit project for a connected check.
uv run --no-sync python start.py
# In another terminal:
Invoke-RestMethod http://127.0.0.1:10000/health
```

Meaningful failure test: in a staging Render service, temporarily set
`LIVEKIT_URL` to an empty value and redeploy. Expect the SDK's missing-URL error,
the launcher's `LiveKit agent exited unexpectedly code=...`, sibling shutdown
and a nonzero service exit. Restore the value afterward. Also send a Render
restart while idle and check shutdown logs for both services without lingering
job processes. A health response must never be taken as worker readiness.

## Render Free limitations and evidence boundary

One idle process is **not** a maximum of one process or one active session.
The SDK can maintain an idle replacement while jobs run. FastAPI, the agent
parent, SDK helper processes and active jobs all share the service's RAM/CPU.
512 MB and 0.1 CPU can still lead to OOM kills, throttling and poor realtime
performance. A longer initialization deadline cannot fix those conditions.

Render Free can spin down after 15 minutes without inbound service traffic and
can restart at any time. The worker's outbound LiveKit connection and browser
audio flowing directly to LiveKit do not themselves provide inbound traffic to
this web service. See [Render Free limitations](https://render.com/docs/free).

Local checks cover automated regressions, actual child-process startup/prewarm,
and an API health response. They do not establish Linux forkserver behavior,
real Render CPU/RAM usage, successful LiveKit registration or live voice quality.
Collect a fresh Render startup trace and complete a microphone conversation
before calling the deployment issue resolved. The STT -> JEV -> OpenRouter LLM
-> Cartesia TTS pipeline, frontend event contracts, fusion/strategy,
interruptions and latency metric logic are unchanged.

Executed locally for this change on Windows/Python 3.13:

- Backend: **65 tests passed**, including 16 launcher cases. Linux signal/group
  branches are mocked; terminating and reaping a real child was also exercised.
- Frontend: **15 tests passed** and production build passed (existing bundle-size
  warning).
- Lock validation: `uv lock --check --offline` passed; plugin `download-files`
  command completed successfully.
- Offline worker smoke check: explicitly selected the SDK's process executor on
  Windows, successfully prewarmed a real child and closed it; no LiveKit
  registration or room was requested.
- HTTP smoke check: Uvicorn returned `{"status":"ok"}` from `/health`.
- Actual `uv run --no-sync python start.py` failure smoke check with a deliberately
  empty `LIVEKIT_URL`: both service processes launched, the worker failure
  produced launcher exit code 1, and both direct children were reaped.
