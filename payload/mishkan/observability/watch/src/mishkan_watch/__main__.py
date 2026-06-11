"""mishkan-watch CLI entry point.

UX contract: ``mishkan-watch`` is a single command. If the daemon isn't
already running we fork it as a child process, wait briefly for its
socket to appear, then launch the TUI. When this process forked the
daemon, quitting the TUI with ``q`` sends SIGTERM to that daemon — no
lingering processes. A daemon that was already running before the TUI
launched is left alive on quit (other clients may be using it).
``mishkan-watchd stop`` remains the explicit shutdown for pre-existing
daemons.

The dual-terminal flow (one for ``mishkan-watchd start``, one for the
TUI) still works for power users — pass ``--no-autostart`` and the
client refuses to manage the daemon.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket as _socket
import subprocess
import sys
import time
from pathlib import Path


DEFAULT_SOCKET = Path(os.path.expanduser("~/.claude/mishkan/run/watch.sock"))
WATCHD_BOOT_TIMEOUT_S = 8.0
WATCHD_BOOT_POLL_MS = 100


def _probe_socket(socket_path: Path) -> bool:
    """Return True if a daemon is actively *serving* on *socket_path*.

    Not a bare connect. A wedged daemon (process alive, socket still bound,
    but its accept/broadcast loop hung) still completes the kernel-level
    connect, so a connect-only probe would mis-read it as healthy — the TUI
    would then adopt it (not fork its own) and show stale data, leaving the
    wedged daemon running on quit. So we go one step further: a healthy watchd
    sends a ``{"type":"snapshot",...}`` NDJSON frame immediately on connect
    (server.py), so we read that first line and require valid JSON with a
    ``type`` field, all within the timeout. A wedged daemon emits nothing ->
    the read times out -> we report it dead, and the caller unlinks the stale
    socket and forks a fresh daemon. Client-side only; no daemon change.
    """
    s = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
    try:
        s.settimeout(0.5)
        s.connect(str(socket_path))
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(65536)
            if not chunk:
                return False  # daemon closed without speaking — dead/wedged
            buf += chunk
        frame = json.loads(buf.split(b"\n", 1)[0].decode("utf-8"))
        return isinstance(frame, dict) and "type" in frame
    except (OSError, ValueError, UnicodeDecodeError):
        # OSError: connect/recv failed or timed out (dead / wedged).
        # ValueError (incl. JSONDecodeError): not a real watchd on this socket.
        # UnicodeDecodeError: first frame isn't valid UTF-8 — not our daemon.
        return False
    finally:
        s.close()


def _ensure_daemon(
    socket_path: Path, *, allow_autostart: bool
) -> tuple[int, int | None]:
    """Return ``(rc, owned_pid)``.

    *rc* is 0 on success, 1 on failure. *owned_pid* is the PID of the
    daemon child this call forked, or ``None`` when we connected to an
    already-running daemon (the caller must not kill a daemon it didn't
    start).

    Liveness check: we attempt a real UNIX-socket connect rather than
    a plain ``exists()`` test. A dead daemon leaves a stale socket file
    on disk; ``exists()`` would return True and the TUI would then
    enter a reconnect loop against a dead socket. The probe catches that
    case: if the connect fails and the file exists, we unlink the stale
    file before forking a fresh daemon.
    """
    if _probe_socket(socket_path):
        # A daemon is already live — leave it alone.
        return 0, None

    # Socket file might still be present but dead — remove it so the
    # daemon we are about to fork can bind its own socket cleanly.
    socket_path.unlink(missing_ok=True)

    if not allow_autostart:
        print(
            "mishkan-watch: daemon socket not found and --no-autostart was "
            "passed.\n  Start the daemon manually:  mishkan-watchd start",
            file=sys.stderr,
        )
        return 1, None
    watchd = shutil.which("mishkan-watchd")
    if not watchd:
        print(
            "mishkan-watch: daemon socket not found and `mishkan-watchd` is "
            "not on PATH.\n  Install the observability stack:\n"
            "    npx mishkan-harness observability install",
            file=sys.stderr,
        )
        return 1, None
    print("mishkan-watch: starting daemon …", file=sys.stderr)
    # Detached child — survives this process. stdout/stderr go to /dev/null
    # so the TUI doesn't get polluted by daemon log lines.
    try:
        proc = subprocess.Popen(
            [watchd, "start"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
    except OSError as e:
        print(f"mishkan-watch: failed to fork daemon: {e}", file=sys.stderr)
        return 1, None
    owned_pid = proc.pid
    # Poll for socket. Bounded; the daemon binds the socket within the
    # first ~200 ms in normal conditions, but uv tool first runs and
    # cold imports can push it higher on slow disks.
    deadline = time.monotonic() + WATCHD_BOOT_TIMEOUT_S
    while time.monotonic() < deadline:
        if socket_path.exists():
            return 0, owned_pid
        time.sleep(WATCHD_BOOT_POLL_MS / 1000)
    print(
        f"mishkan-watch: daemon socket {socket_path} did not appear within "
        f"{WATCHD_BOOT_TIMEOUT_S:.0f} s.\n  Check daemon logs:  "
        "mishkan-watchd status",
        file=sys.stderr,
    )
    return 1, owned_pid


def cli(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="mishkan-watch",
        description="MISHKAN observability TUI. Auto-starts the daemon "
                    "if it isn't running.",
    )
    p.add_argument("--socket", type=Path, default=DEFAULT_SOCKET,
                   help=f"daemon UNIX socket (default: {DEFAULT_SOCKET})")
    p.add_argument("--no-autostart", action="store_true",
                   help="don't fork the daemon; refuse if socket missing")
    args = p.parse_args(argv)

    rc, owned_pid = _ensure_daemon(
        args.socket, allow_autostart=not args.no_autostart
    )
    if rc != 0:
        return rc

    # Importing the app lazily keeps CLI startup fast even when Textual is
    # heavy to import.
    from .app import run
    return run(socket_path=args.socket, owned_daemon_pid=owned_pid)


if __name__ == "__main__":
    sys.exit(cli())
