"""mishkan-watch CLI entry point."""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


DEFAULT_SOCKET = Path(os.path.expanduser("~/.claude/mishkan/run/watch.sock"))


def cli(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="mishkan-watch",
        description="MISHKAN observability TUI. Connects to mishkan-watchd.",
    )
    p.add_argument("--socket", type=Path, default=DEFAULT_SOCKET,
                   help=f"daemon UNIX socket (default: {DEFAULT_SOCKET})")
    args = p.parse_args(argv)

    # Importing the app lazily keeps CLI startup fast even when Textual is
    # heavy to import.
    from .app import run
    return run(socket_path=args.socket)


if __name__ == "__main__":
    sys.exit(cli())
