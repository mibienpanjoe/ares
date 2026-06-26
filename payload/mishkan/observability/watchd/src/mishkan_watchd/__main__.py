"""ares-watchd CLI entry point.

Commands:
    ares-watchd start              run in foreground
    ares-watchd stop               send SIGTERM to running daemon (PID file)
    ares-watchd status             print current daemon state
    ares-watchd install-service    write a systemd --user unit file
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import socket
import sys
from pathlib import Path

from .lifecycle import install_systemd_user_unit
from .server import DAEMON_IDLE_SHUTDOWN_S, WatchdServer
from .state import HarnessState
from .sources import (bus_tail, cognee_poll, graphify_tail, mcp_probe,
                       opencode_storage, session_discover, session_tail, subagent_tail,
                       worktree_poll)


HOME = Path(os.path.expanduser("~"))
DEFAULT_PROJECTS_DIR = HOME / ".claude" / "projects"
CODEX_HOME = Path(os.path.expanduser(os.environ.get("CODEX_HOME", str(HOME / ".codex"))))
DEFAULT_CODEX_SESSIONS_DIR = Path(os.path.expanduser(
    os.environ.get("ARES_CODEX_SESSIONS_DIR")
    or os.environ.get("ARES_CODEX_THREADS_DIR")
    or str(CODEX_HOME / "sessions")
))
DEFAULT_OPENCODE_SESSIONS_DIR = Path(os.path.expanduser(
    os.environ.get("ARES_OPENCODE_SESSIONS_DIR")
    or os.environ.get("OPENCODE_DATA_DIR")
    or str(HOME / ".local" / "share" / "opencode")
))


def _runtime_home() -> Path:
    if os.environ.get("ARES_HOME"):
        return Path(os.path.expanduser(os.environ["ARES_HOME"]))
    if os.environ.get("MISHKAN_HOME"):
        return Path(os.path.expanduser(os.environ["MISHKAN_HOME"]))
    ares = HOME / ".ares"
    legacy = HOME / ".claude" / "mishkan"
    if ares.exists() or not legacy.exists():
        return ares
    return legacy


RUNTIME_HOME = _runtime_home()
DEFAULT_LOG_DIR = Path(os.path.expanduser(os.environ.get("ARES_LOG_DIR") or os.environ.get("MISHKAN_LOG_DIR") or str(RUNTIME_HOME / "logs")))
DEFAULT_SOCKET = RUNTIME_HOME / "run" / "watch.sock"
DEFAULT_PID = RUNTIME_HOME / "run" / "watchd.pid"


async def _dispatcher(queue: asyncio.Queue, state: HarnessState, server: WatchdServer) -> None:
    """Pull events from the queue, apply to state, broadcast to clients."""
    while True:
        event = await queue.get()
        try:
            state.apply(event)
            await server.broadcast(event)
        except Exception:
            continue


def _jsonl_sessions_provider(state: HarnessState):
    """Build a fresh active-session map from the current state."""
    def _provider() -> dict[str, Path]:
        out: dict[str, Path] = {}
        for sid, s in state.sessions.items():
            if s.jsonl_path:
                p = Path(s.jsonl_path)
                if p.exists() and p.suffix == ".jsonl":
                    out[sid] = p
        return out
    return _provider


def _decode_project(p: str) -> str:
    """Decode Claude Code's encoded project dir form (-home-ogu-...) to absolute.

    session_discover sets sess.project to jsonl.parent.name which is the
    Claude Code encoded form. Downstream consumers that open the path on
    disk (worktree_poll, graphify_tail) must decode or they silently skip
    every project. Idempotent on already-absolute paths.
    """
    if not p or p in ("", "unknown", "?"):
        return p
    if p.startswith("/"):
        return p
    if p.startswith("-"):
        return p.replace("-", "/")
    return p


def _project_paths_provider(state: HarnessState):
    """Return distinct project paths from active sessions, plus $PWD.

    Decodes Claude Code's encoded project form so downstream sources can
    actually open the project on disk.
    """
    def _provider() -> list[Path]:
        seen: set[str] = set()
        out: list[Path] = []
        for s in state.sessions.values():
            if not s.project or s.project in ("unknown", ""):
                continue
            decoded = _decode_project(s.project)
            if decoded in seen:
                continue
            seen.add(decoded)
            p = Path(decoded)
            if p.is_dir():
                out.append(p)
        try:
            cwd = os.getcwd()
            if cwd not in seen:
                out.append(Path(cwd))
        except Exception:
            pass
        return out
    return _provider


async def _run(
    log_dir: Path,
    projects_dir: Path,
    codex_sessions_dir: Path,
    opencode_sessions_dir: Path,
    socket_path: Path,
    idle_timeout_s: float = DAEMON_IDLE_SHUTDOWN_S,
) -> None:
    state = HarnessState()
    queue: asyncio.Queue = asyncio.Queue()
    stop = asyncio.Event()
    server = WatchdServer(
        socket_path,
        state,
        idle_timeout_s=idle_timeout_s,
        shutdown_cb=stop.set,
    )
    srv = await server.start()

    tasks = [
        asyncio.create_task(_dispatcher(queue, state, server), name="dispatch"),
        asyncio.create_task(bus_tail.run(queue, log_dir), name="bus_tail"),
        asyncio.create_task(session_discover.run(queue, projects_dir, runtime="claude"),
                            name="session_discover_claude"),
        asyncio.create_task(session_discover.run(queue, codex_sessions_dir, runtime="codex", recursive=True),
                            name="session_discover_codex"),
        asyncio.create_task(opencode_storage.run(queue, opencode_sessions_dir),
                            name="opencode_storage"),
        asyncio.create_task(worktree_poll.run(queue, _project_paths_provider(state)),
                            name="worktree_poll"),
        asyncio.create_task(mcp_probe.run(queue, projects_dir), name="mcp_probe"),
        asyncio.create_task(cognee_poll.run(queue, projects_dir), name="cognee_poll"),
        asyncio.create_task(session_tail.run(queue, _jsonl_sessions_provider(state)),
                            name="session_tail"),
        asyncio.create_task(graphify_tail.run(queue, _project_paths_provider(state)),
                            name="graphify_tail"),
        asyncio.create_task(subagent_tail.run(queue, _jsonl_sessions_provider(state)),
                            name="subagent_tail"),
    ]

    def _stop_handler(*_):
        stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _stop_handler)
        except NotImplementedError:
            pass

    print(f"ares-watchd: listening on {socket_path}", file=sys.stderr)
    try:
        await stop.wait()
    finally:
        print("ares-watchd: stopping…", file=sys.stderr)
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await server.stop()
        srv.close()
        try:
            await srv.wait_closed()
        except Exception:
            pass


def _write_pid() -> None:
    DEFAULT_PID.parent.mkdir(parents=True, exist_ok=True)
    DEFAULT_PID.write_text(str(os.getpid()))


def _clear_pid() -> None:
    try:
        DEFAULT_PID.unlink()
    except FileNotFoundError:
        pass


def _socket_is_live(socket_path: Path) -> bool:
    """Return True if a daemon is already listening on socket_path."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            s.connect(str(socket_path))
        return True
    except (OSError, socket.timeout):
        return False


def _cmd_start(args: argparse.Namespace) -> int:
    # Check for a live daemon before writing the PID file or binding.
    # The server.start() also performs this check, but the early exit here
    # avoids overwriting a valid PID file with our own PID.
    if args.socket.exists() and _socket_is_live(args.socket):
        print("ares-watchd: daemon already running, nothing to do", file=sys.stderr)
        return 0
    _write_pid()
    try:
        asyncio.run(_run(args.log_dir, args.projects_dir, args.codex_sessions_dir,
                         args.opencode_sessions_dir, args.socket, args.idle_timeout))
    except RuntimeError as e:
        # server.start() raises RuntimeError when a live daemon is detected
        # after the PID file was written (narrow race). Clean up and exit 0
        # — another daemon is running, which is the desired state.
        _clear_pid()
        print(f"ares-watchd: {e}", file=sys.stderr)
        return 0
    finally:
        _clear_pid()
    return 0


def _cmd_stop(_args: argparse.Namespace) -> int:
    try:
        pid_text = DEFAULT_PID.read_text().strip()
    except FileNotFoundError:
        print("ares-watchd: no PID file (daemon not running?)", file=sys.stderr)
        return 0
    except Exception as e:
        print(f"ares-watchd: cannot read PID file: {e}", file=sys.stderr)
        return 1

    try:
        pid = int(pid_text)
    except ValueError:
        print("ares-watchd: malformed PID file, clearing", file=sys.stderr)
        _clear_pid()
        return 1

    # Verify the PID is actually a live watchd process before killing.
    try:
        # os.kill with signal 0 checks existence without sending a signal.
        os.kill(pid, 0)
    except ProcessLookupError:
        _clear_pid()
        print("ares-watchd: process not found, cleared stale PID", file=sys.stderr)
        return 0
    except PermissionError:
        # Process exists but is owned by another user — not ours to kill.
        print(f"ares-watchd: PID {pid} exists but is not owned by this user", file=sys.stderr)
        _clear_pid()
        return 1

    try:
        os.kill(pid, signal.SIGTERM)
        print(f"ares-watchd: sent SIGTERM to {pid}", file=sys.stderr)
    except ProcessLookupError:
        _clear_pid()
        print("ares-watchd: process vanished before SIGTERM, cleared PID", file=sys.stderr)
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    """Connect to the socket and print the snapshot frame."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(2.0)
            s.connect(str(args.socket))
            buf = b""
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
                if b"\n" in buf:
                    break
            line, _, _ = buf.partition(b"\n")
            if not line:
                print("ares-watchd: empty response", file=sys.stderr)
                return 1
            obj = json.loads(line.decode("utf-8"))
            print(json.dumps(obj, indent=2))
            return 0
    except Exception as e:
        print(f"ares-watchd: cannot connect to {args.socket}: {e}", file=sys.stderr)
        return 1


def _cmd_install_service(args: argparse.Namespace) -> int:
    path = install_systemd_user_unit(
        socket_path=args.socket,
        log_dir=args.log_dir,
        projects_dir=args.projects_dir,
        codex_sessions_dir=args.codex_sessions_dir,
        opencode_sessions_dir=args.opencode_sessions_dir,
    )
    print(f"ares-watchd: wrote {path}", file=sys.stderr)
    print("Enable with: systemctl --user enable --now ares-watchd.service", file=sys.stderr)
    return 0


def cli(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog=Path(sys.argv[0]).name or "ares-watchd",
                                description="ARES observability daemon.")
    p.add_argument("--socket", type=Path, default=DEFAULT_SOCKET,
                   help=f"UNIX socket path (default: {DEFAULT_SOCKET})")
    p.add_argument("--log-dir", type=Path, default=DEFAULT_LOG_DIR,
                   help=f"event bus log dir (default: {DEFAULT_LOG_DIR})")
    p.add_argument("--projects-dir", type=Path, default=DEFAULT_PROJECTS_DIR,
                   help=f"Claude Code projects dir (default: {DEFAULT_PROJECTS_DIR})")
    p.add_argument("--codex-sessions-dir", "--codex-threads-dir", type=Path,
                   default=DEFAULT_CODEX_SESSIONS_DIR, dest="codex_sessions_dir",
                   help=f"Codex sessions dir (default: {DEFAULT_CODEX_SESSIONS_DIR}; env: ARES_CODEX_SESSIONS_DIR, legacy ARES_CODEX_THREADS_DIR, or CODEX_HOME)")
    p.add_argument("--opencode-sessions-dir", type=Path, default=DEFAULT_OPENCODE_SESSIONS_DIR,
                   help=f"OpenCode sessions/data dir (default: {DEFAULT_OPENCODE_SESSIONS_DIR}; env: ARES_OPENCODE_SESSIONS_DIR or OPENCODE_DATA_DIR)")

    # Idle-shutdown default: CLI arg > env var > compiled constant.
    _env_idle = os.environ.get("ARES_WATCHD_IDLE_TIMEOUT") or os.environ.get("MISHKAN_WATCHD_IDLE_TIMEOUT", "")
    try:
        _default_idle: float = float(_env_idle) if _env_idle else DAEMON_IDLE_SHUTDOWN_S
    except ValueError:
        _default_idle = DAEMON_IDLE_SHUTDOWN_S

    sub = p.add_subparsers(dest="cmd", required=True)
    start_p = sub.add_parser("start", help="run the daemon in foreground")
    start_p.add_argument(
        "--idle-timeout",
        type=float,
        default=_default_idle,
        metavar="SECONDS",
        dest="idle_timeout",
        help=(
            f"exit after SECONDS with no connected client "
            f"(default: {_default_idle}; 0 or negative disables; "
            f"env: ARES_WATCHD_IDLE_TIMEOUT or MISHKAN_WATCHD_IDLE_TIMEOUT)"
        ),
    )
    sub.add_parser("stop", help="send SIGTERM to running daemon")
    sub.add_parser("status", help="connect and print snapshot")
    sub.add_parser("install-service", help="write a systemd --user unit")

    args = p.parse_args(argv)
    if args.cmd == "start":
        return _cmd_start(args)
    if args.cmd == "stop":
        return _cmd_stop(args)
    if args.cmd == "status":
        return _cmd_status(args)
    if args.cmd == "install-service":
        return _cmd_install_service(args)
    p.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(cli())
