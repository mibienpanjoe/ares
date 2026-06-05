"""Daemon lifecycle helpers — systemd-user unit installer.

Manual start is always the default. The engineer can install a
systemd-user unit for autostart via:

    mishkan-watchd install-service
    systemctl --user enable --now mishkan-watchd.service
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


SYSTEMD_USER_DIR = Path(os.path.expanduser("~/.config/systemd/user"))


SYSTEMD_UNIT_TEMPLATE = """\
[Unit]
Description=MISHKAN observability daemon
Documentation=file://%h/.claude/mishkan/observability/README.md
After=default.target

[Service]
Type=simple
ExecStart={exe} start --socket {socket} --log-dir {log_dir} --projects-dir {projects_dir}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
"""


def install_systemd_user_unit(socket_path: Path, log_dir: Path,
                              projects_dir: Path) -> Path:
    """Write the systemd-user unit and return its path. Does not enable it."""
    SYSTEMD_USER_DIR.mkdir(parents=True, exist_ok=True)
    unit_path = SYSTEMD_USER_DIR / "mishkan-watchd.service"
    # Resolve the absolute path to the installed mishkan-watchd entry point.
    exe = _resolve_entrypoint()
    content = SYSTEMD_UNIT_TEMPLATE.format(
        exe=exe,
        socket=socket_path,
        log_dir=log_dir,
        projects_dir=projects_dir,
    )
    unit_path.write_text(content)
    return unit_path


def _resolve_entrypoint() -> str:
    """Locate the absolute path of the installed mishkan-watchd script.

    uv tool installs land in ~/.local/bin/ (or the user-configured uv bin
    dir). When run from within a uv tool environment, sys.argv[0] is
    usually the wrapper script — fallback to "mishkan-watchd" via PATH
    if we can't resolve.
    """
    argv0 = sys.argv[0] or ""
    if argv0 and os.path.isabs(argv0) and "mishkan-watchd" in argv0:
        return argv0
    # Try the conventional uv path.
    candidate = os.path.expanduser("~/.local/bin/mishkan-watchd")
    if os.path.exists(candidate):
        return candidate
    return "mishkan-watchd"  # PATH-resolved at unit execution time
