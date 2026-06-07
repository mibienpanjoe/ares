"""mishkan-watchd CLI entry point.

Commands:
    mishkan-watchd start              run in foreground
    mishkan-watchd stop               send SIGTERM to running daemon (PID file)
    mishkan-watchd status             print current daemon state
    mishkan-watchd install-service    write a systemd --user unit file
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
from .server import WatchdServer
from .state import HarnessState
from .sources import (bus_tail, cognee_poll, graphify_tail, mcp_probe,
                       session_discover, session_tail, subagent_tail,
                       worktree_poll)


HOME = Path(os.path.expanduser("~"))
DEFAULT_LOG_DIR = HOME / ".claude" / "mishkan" / "logs"
DEFAULT_PROJECTS_DIR = HOME / ".claude" / "projects"
DEFAULT_SOCKET = HOME / ".claude" / "mishkan" / "run" / "watch.sock"
DEFAULT_PID = HOME / ".claude" / "mishkan" / "run" / "watchd.pid"


async def _dispatcher(queue: asyncio.Queue, state: HarnessState, server: WatchdServer) -> None:
    """Pull events from the queue, apply to state, broadcast to clients."""
    while True:
        event = await queue.get()
        try:
            state.apply(event)
            await server.broadcast(event)
        except Exception:
            continue


def _active_sessions_provider(state: HarnessState):
    """Build a fresh active-session map from the current state."""
    def _provider() -> dict[str, Path]:
        out: dict[str, Path] = {}
        for sid, s in state.sessions.items():
            # The session_discover source attaches jsonl_path via session_start
            # payload but we don't keep it in SessionState; recover by globbing.
            for jsonl in DEFAULT_PROJECTS_DIR.glob(f"*/{sid}.jsonl"):
                out[sid] = jsonl
                break
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


async def _run(log_dir: Path, projects_dir: Path, socket_path: Path) -> None:
    state = HarnessState()
    queue: asyncio.Queue = asyncio.Queue()
    server = WatchdServer(socket_path, state)
    srv = await server.start()

    tasks = [
        asyncio.create_task(_dispatcher(queue, state, server), name="dispatch"),
        asyncio.create_task(bus_tail.run(queue, log_dir), name="bus_tail"),
        asyncio.create_task(session_discover.run(queue, projects_dir), name="session_discover"),
        asyncio.create_task(worktree_poll.run(queue, _project_paths_provider(state)),
                            name="worktree_poll"),
        asyncio.create_task(mcp_probe.run(queue, projects_dir), name="mcp_probe"),
        asyncio.create_task(cognee_poll.run(queue, projects_dir), name="cognee_poll"),
        asyncio.create_task(session_tail.run(queue, _active_sessions_provider(state)),
                            name="session_tail"),
        asyncio.create_task(graphify_tail.run(queue, _project_paths_provider(state)),
                            name="graphify_tail"),
        asyncio.create_task(subagent_tail.run(queue, _active_sessions_provider(state)),
                            name="subagent_tail"),
    ]

    stop = asyncio.Event()

    def _stop_handler(*_):
        stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _stop_handler)
        except NotImplementedError:
            pass

    print(f"mishkan-watchd: listening on {socket_path}", file=sys.stderr)
    try:
        await stop.wait()
    finally:
        print("mishkan-watchd: stopping…", file=sys.stderr)
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


def _cmd_start(args: argparse.Namespace) -> int:
    _write_pid()
    try:
        asyncio.run(_run(args.log_dir, args.projects_dir, args.socket))
    finally:
        _clear_pid()
    return 0


def _cmd_stop(_args: argparse.Namespace) -> int:
    try:
        pid = int(DEFAULT_PID.read_text().strip())
    except Exception:
        print("mishkan-watchd: no PID file (daemon not running?)", file=sys.stderr)
        return 1
    try:
        os.kill(pid, signal.SIGTERM)
        print(f"mishkan-watchd: sent SIGTERM to {pid}", file=sys.stderr)
    except ProcessLookupError:
        _clear_pid()
        print("mishkan-watchd: process not found, cleared stale PID", file=sys.stderr)
        return 1
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
                print("mishkan-watchd: empty response", file=sys.stderr)
                return 1
            obj = json.loads(line.decode("utf-8"))
            print(json.dumps(obj, indent=2))
            return 0
    except Exception as e:
        print(f"mishkan-watchd: cannot connect to {args.socket}: {e}", file=sys.stderr)
        return 1


def _cmd_install_service(args: argparse.Namespace) -> int:
    path = install_systemd_user_unit(
        socket_path=args.socket,
        log_dir=args.log_dir,
        projects_dir=args.projects_dir,
    )
    print(f"mishkan-watchd: wrote {path}", file=sys.stderr)
    print("Enable with: systemctl --user enable --now mishkan-watchd.service", file=sys.stderr)
    return 0


def cli(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="mishkan-watchd",
                                description="MISHKAN observability daemon.")
    p.add_argument("--socket", type=Path, default=DEFAULT_SOCKET,
                   help=f"UNIX socket path (default: {DEFAULT_SOCKET})")
    p.add_argument("--log-dir", type=Path, default=DEFAULT_LOG_DIR,
                   help=f"event bus log dir (default: {DEFAULT_LOG_DIR})")
    p.add_argument("--projects-dir", type=Path, default=DEFAULT_PROJECTS_DIR,
                   help=f"Claude Code projects dir (default: {DEFAULT_PROJECTS_DIR})")

    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("start", help="run the daemon in foreground")
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
