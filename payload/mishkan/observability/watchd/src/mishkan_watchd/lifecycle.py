"""Daemon lifecycle helpers — systemd-user unit installer.

Manual start is always the default. The engineer can install a
systemd-user unit for autostart via:

    ares-watchd install-service
    systemctl --user enable --now ares-watchd.service
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


SYSTEMD_USER_DIR = Path(os.path.expanduser("~/.config/systemd/user"))


SYSTEMD_UNIT_TEMPLATE = """\
[Unit]
Description=ARES observability daemon
Documentation=file://%h/.ares/observability/README.md
After=default.target

[Service]
Type=simple
ExecStart={exe} start --socket {socket} --log-dir {log_dir} --projects-dir {projects_dir} --codex-sessions-dir {codex_sessions_dir} --opencode-sessions-dir {opencode_sessions_dir}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
"""


def install_systemd_user_unit(socket_path: Path, log_dir: Path,
                              projects_dir: Path,
                              codex_sessions_dir: Path | None = None,
                              opencode_sessions_dir: Path | None = None) -> Path:
    """Write the systemd-user unit and return its path. Does not enable it."""
    SYSTEMD_USER_DIR.mkdir(parents=True, exist_ok=True)
    unit_path = SYSTEMD_USER_DIR / "ares-watchd.service"
    # Resolve the absolute path to the installed watchd entry point.
    exe = _resolve_entrypoint()
    content = SYSTEMD_UNIT_TEMPLATE.format(
        exe=exe,
        socket=socket_path,
        log_dir=log_dir,
        projects_dir=projects_dir,
        codex_sessions_dir=codex_sessions_dir or Path(os.path.expanduser(os.environ.get("ARES_CODEX_SESSIONS_DIR") or os.environ.get("ARES_CODEX_THREADS_DIR") or "~/.codex/sessions")),
        opencode_sessions_dir=opencode_sessions_dir or Path(os.path.expanduser(os.environ.get("ARES_OPENCODE_SESSIONS_DIR") or os.environ.get("OPENCODE_DATA_DIR") or "~/.local/share/opencode")),
    )
    unit_path.write_text(content)
    return unit_path


def _resolve_entrypoint() -> str:
    """Locate the absolute path of the installed watchd script.

    uv tool installs land in ~/.local/bin/ (or the user-configured uv bin
    dir). When run from within a uv tool environment, sys.argv[0] is
    usually the wrapper script. Prefer the ARES name, but accept the legacy
    script so old installs keep working.
    """
    argv0 = sys.argv[0] or ""
    if argv0 and os.path.isabs(argv0) and "watchd" in argv0:
        return argv0
    # Try the conventional uv path.
    for name in ("ares-watchd", "mishkan-watchd"):
        candidate = os.path.expanduser(f"~/.local/bin/{name}")
        if os.path.exists(candidate):
            return candidate
    return "ares-watchd"  # PATH-resolved at unit execution time
