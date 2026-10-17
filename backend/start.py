"""Run the API and voice worker together in one Render service."""

import logging
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


logger = logging.getLogger("voice_companion.start")
BACKEND_DIRECTORY = Path(__file__).resolve().parent
SHUTDOWN_SECONDS = 20.0  # Leave headroom before Render's default 30-second SIGKILL.


def stop_processes(
    processes: list[tuple[str, subprocess.Popen]], shutdown_signal: int,
) -> None:
    # Let each service clean up its own children before forcing group cleanup.
    for name, process in processes:
        if process.poll() is None:
            logger.info("stopping %s signal=%s", name, signal.Signals(shutdown_signal).name)
            try:
                if os.name == "posix":
                    process.send_signal(shutdown_signal)
                else:
                    process.terminate()
            except ProcessLookupError:
                pass

    deadline = time.monotonic() + SHUTDOWN_SECONDS
    while any(process.poll() is None for _, process in processes):
        if time.monotonic() >= deadline:
            break
        time.sleep(0.1)

    for name, process in processes:
        if os.name == "posix":
            # The leader may have exited while SDK job/forkserver children remain.
            try:
                os.killpg(process.pid, signal.SIGKILL)
                logger.warning("forced remaining %s process group to stop", name)
            except ProcessLookupError:
                pass
        elif process.poll() is None:
            logger.warning("forcing %s to stop", name)
            process.kill()
        process.wait()


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    shutdown_signal = None

    def request_shutdown(signum: int, frame: object) -> None:
        nonlocal shutdown_signal
        if shutdown_signal is None:
            shutdown_signal = signum

    previous_handlers = {
        signum: signal.signal(signum, request_shutdown)
        for signum in (signal.SIGTERM, signal.SIGINT)
    }
    processes: list[tuple[str, subprocess.Popen]] = []
    commands = (
        ("FastAPI", [sys.executable, "-u", "-m", "uvicorn", "src.api:app",
                     "--host", "0.0.0.0", "--port", os.environ.get("PORT") or "10000"]),
        ("LiveKit agent", [sys.executable, "-u", "src/agent.py", "start"]),
    )
    exit_code = 1
    try:
        for name, command in commands:
            if shutdown_signal is not None:
                break
            logger.info("starting %s", name)
            process = subprocess.Popen(
                command, cwd=BACKEND_DIRECTORY, start_new_session=os.name == "posix",
            )
            processes.append((name, process))
            logger.info("launched %s pid=%s", name, process.pid)

        while shutdown_signal is None:
            for name, process in processes:
                return_code = process.poll()
                if return_code is not None:
                    logger.error("%s exited unexpectedly code=%s", name, return_code)
                    # The SDK can log a startup failure and still exit with zero.
                    if return_code < 0:
                        return 128 - return_code
                    return return_code or 1
            time.sleep(0.1)
        logger.info("launcher received %s", signal.Signals(shutdown_signal).name)
        exit_code = 0
    except OSError as error:
        logger.error("could not start %s: %s", name, error)
    finally:
        try:
            stop_processes(processes, shutdown_signal or signal.SIGTERM)
        finally:
            for signum, handler in previous_handlers.items():
                signal.signal(signum, handler)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
