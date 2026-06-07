"""mishkan-watch CLI entry point.

UX contract: ``mishkan-watch`` is a single command. If the daemon isn't
already running we fork it as a child process, wait briefly for its
socket to appear, then launch the TUI. On TUI exit we leave the daemon
alive so other clients (a second ``mishkan-watch`` window, the TUI on
another tmux pane) can use it. ``mishkan-watchd stop`` remains the
explicit shutdown.

The dual-terminal flow (one for ``mishkan-watchd start``, one for the
TUI) still works for power users — pass ``--no-autostart`` and the
client refuses to manage the daemon.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


DEFAULT_SOCKET = Path(os.path.expanduser("~/.claude/mishkan/run/watch.sock"))
WATCHD_BOOT_TIMEOUT_S = 8.0
WATCHD_BOOT_POLL_MS = 100


def _ensure_daemon(socket_path: Path, *, allow_autostart: bool) -> int:
    """Return 0 on success, 1 on failure.

    If the socket already exists we assume the daemon is up — this is
    the common case (daemon already running across sessions). Otherwise,
    when autostart is allowed and ``mishkan-watchd`` is on PATH, we
    fork it and poll for the socket up to WATCHD_BOOT_TIMEOUT_S.
    """
    if socket_path.exists():
        return 0
    if not allow_autostart:
        print(
            "mishkan-watch: daemon socket not found and --no-autostart was "
            "passed.\n  Start the daemon manually:  mishkan-watchd start",
            file=sys.stderr,
        )
        return 1
    watchd = shutil.which("mishkan-watchd")
    if not watchd:
        print(
            "mishkan-watch: daemon socket not found and `mishkan-watchd` is "
            "not on PATH.\n  Install the observability stack:\n"
            "    npx mishkan-harness observability",
            file=sys.stderr,
        )
        return 1
    print("mishkan-watch: starting daemon …", file=sys.stderr)
    # Detached child — survives this process. stdout/stderr go to /dev/null
    # so the TUI doesn't get polluted by daemon log lines.
    try:
        subprocess.Popen(
            [watchd, "start"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
    except OSError as e:
        print(f"mishkan-watch: failed to fork daemon: {e}", file=sys.stderr)
        return 1
    # Poll for socket. Bounded; the daemon binds the socket within the
    # first ~200 ms in normal conditions, but uv tool first runs and
    # cold imports can push it higher on slow disks.
    deadline = time.monotonic() + WATCHD_BOOT_TIMEOUT_S
    while time.monotonic() < deadline:
        if socket_path.exists():
            return 0
        time.sleep(WATCHD_BOOT_POLL_MS / 1000)
    print(
        f"mishkan-watch: daemon socket {socket_path} did not appear within "
        f"{WATCHD_BOOT_TIMEOUT_S:.0f} s.\n  Check daemon logs:  "
        "mishkan-watchd status",
        file=sys.stderr,
    )
    return 1


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

    rc = _ensure_daemon(args.socket, allow_autostart=not args.no_autostart)
    if rc != 0:
        return rc

    # Importing the app lazily keeps CLI startup fast even when Textual is
    # heavy to import.
    from .app import run
    return run(socket_path=args.socket)


if __name__ == "__main__":
    sys.exit(cli())
