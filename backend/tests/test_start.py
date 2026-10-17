import os
import signal
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import start


@pytest.fixture
def launcher(monkeypatch):
    processes = [Mock(pid=101), Mock(pid=102)]
    for process in processes:
        process.poll.return_value = None
    popen = Mock(side_effect=processes)
    cleanup = Mock()
    handlers = {}

    def set_handler(signum, handler):
        previous = handlers.get(signum, signal.SIG_DFL)
        handlers[signum] = handler
        return previous

    monkeypatch.setattr(start.subprocess, "Popen", popen)
    monkeypatch.setattr(start, "stop_processes", cleanup)
    monkeypatch.setattr(start.signal, "signal", set_handler)
    return SimpleNamespace(processes=processes, popen=popen, cleanup=cleanup, handlers=handlers)


@pytest.mark.parametrize("signum", [signal.SIGTERM, signal.SIGINT])
def test_launcher_preserves_port_and_stops_both_services_on_signal(launcher, monkeypatch, signum):
    monkeypatch.setenv("PORT", "12345")
    monkeypatch.setattr(start.time, "sleep", lambda _: launcher.handlers[signum](signum, None))

    assert start.main() == 0

    api_command = launcher.popen.call_args_list[0].args[0]
    agent_command = launcher.popen.call_args_list[1].args[0]
    assert api_command[0] == agent_command[0] == start.sys.executable
    assert api_command[-2:] == ["--port", "12345"]
    assert agent_command[-2:] == ["src/agent.py", "start"]
    for call in launcher.popen.call_args_list:
        assert call.kwargs == {
            "cwd": start.BACKEND_DIRECTORY, "start_new_session": os.name == "posix",
        }
    launcher.cleanup.assert_called_once_with(
        [("FastAPI", launcher.processes[0]), ("LiveKit agent", launcher.processes[1])], signum,
    )
    assert launcher.handlers == {signal.SIGTERM: signal.SIG_DFL, signal.SIGINT: signal.SIG_DFL}


@pytest.mark.parametrize("service_index", [0, 1])
@pytest.mark.parametrize(("return_code", "expected"), [(0, 1), (7, 7), (-9, 137)])
def test_unexpected_service_exit_fails_launcher_and_cleans_up(launcher, service_index, return_code, expected):
    launcher.processes[service_index].poll.return_value = return_code

    assert start.main() == expected

    launcher.cleanup.assert_called_once_with(
        [("FastAPI", launcher.processes[0]), ("LiveKit agent", launcher.processes[1])], signal.SIGTERM,
    )


def test_second_spawn_failure_stops_first_service(launcher):
    launcher.popen.side_effect = [launcher.processes[0], OSError("spawn failed")]

    assert start.main() == 1

    launcher.cleanup.assert_called_once_with([("FastAPI", launcher.processes[0])], signal.SIGTERM)
    assert launcher.handlers == {signal.SIGTERM: signal.SIG_DFL, signal.SIGINT: signal.SIG_DFL}


@pytest.mark.parametrize("port", [None, ""])
def test_missing_or_empty_port_uses_render_default(launcher, monkeypatch, port):
    if port is None:
        monkeypatch.delenv("PORT", raising=False)
    else:
        monkeypatch.setenv("PORT", port)
    launcher.processes[0].poll.return_value = 1

    assert start.main() == 1

    assert launcher.popen.call_args_list[0].args[0][-2:] == ["--port", "10000"]


def test_signal_during_first_spawn_does_not_launch_second_service(launcher):
    def spawn(*args, **kwargs):
        launcher.handlers[signal.SIGTERM](signal.SIGTERM, None)
        return launcher.processes[0]

    launcher.popen.side_effect = spawn

    assert start.main() == 0

    assert launcher.popen.call_count == 1
    launcher.cleanup.assert_called_once_with([("FastAPI", launcher.processes[0])], signal.SIGTERM)


@pytest.mark.parametrize("signum", [signal.SIGTERM, signal.SIGINT])
def test_posix_shutdown_forwards_signal_and_cleans_groups_after_leaders_exit(monkeypatch, signum):
    processes = [Mock(pid=101), Mock(pid=102)]
    for process in processes:
        process.poll.side_effect = [None, 0]
    killpg = Mock(side_effect=[None, ProcessLookupError()])
    monkeypatch.setattr(start, "os", SimpleNamespace(name="posix", killpg=killpg))
    monkeypatch.setattr(start, "signal", SimpleNamespace(Signals=signal.Signals, SIGKILL=9))

    start.stop_processes(list(zip(["api", "agent"], processes)), signum)

    for process in processes:
        process.send_signal.assert_called_once_with(signum)
        process.wait.assert_called_once_with()
    assert killpg.call_args_list[0].args == (101, 9)
    assert killpg.call_args_list[1].args == (102, 9)


def test_posix_shutdown_kills_unresponsive_group_after_shared_deadline(monkeypatch):
    process = Mock(pid=101)
    process.poll.return_value = None
    killpg = Mock()
    monkeypatch.setattr(start, "os", SimpleNamespace(name="posix", killpg=killpg))
    monkeypatch.setattr(start, "signal", SimpleNamespace(Signals=signal.Signals, SIGKILL=9))
    monkeypatch.setattr(start.time, "monotonic", Mock(side_effect=[0, start.SHUTDOWN_SECONDS]))

    start.stop_processes([("agent", process)], signal.SIGTERM)

    killpg.assert_called_once_with(101, 9)
    process.wait.assert_called_once_with()


def test_shutdown_terminates_and_reaps_real_child():
    process = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)"],
        start_new_session=os.name == "posix",
    )
    try:
        start.stop_processes([("test child", process)], signal.SIGTERM)
        assert process.poll() is not None
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
