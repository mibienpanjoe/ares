# ares-watch

ARES observability TUI. Textual client to `ares-watchd`, renders
the 5-tab dashboard described in §7 of
`docs/design/MISHKAN_observability.md`.

Opt-in install:

```bash
uv tool install --from <path-to-this-dir> ares-watch
```

The daemon must be running for the TUI to populate. Start it in another
tmux pane / systemd unit:

```bash
ares-watchd start
ares-watch
```

## What's in this release (Phase 3 core)

- Tab 1 **Live** — ACTIVE roster + FEED rolling stream + WORKTREES +
  KNOWLEDGE rollup, with per-event coloring per the §7.4 palette.
- Tab 5 **Activity** — unified event stream with regex filter and
  rhythm-breaking separator above error / blocked-permission events.
- Status bar — permanent across all tabs, shows session age, cumulative
  tokens in/out/cache, cost estimate $, active agents, active workflows,
  daemon connection status.
- Tabs 2 (Agents), 3 (Workflows), 4 (Knowledge) — stubs that activate
  in Phase 4 once the daemon's workflow journal-tail source and Cognee
  node-count poll source land.

## Keybindings

```
1-5     switch tab
q       quit
/       focus filter (Activity tab)
?       brief help in status bar
Enter   detail pane (future)
Esc     close detail / clear filter
```

## Theme

Dark by default. The `theme.tcss` color tokens (`$color-running`,
`$color-error`, etc.) are defined in CSS and used through Rich markup.
Light-mode inversion is set up in CSS but not yet wired to a CLI flag —
follow-up.

## Reconnect

If the daemon goes down the TUI keeps running, the status bar shows
`daemon offline: …`, and the client reconnects with exponential backoff
(capped at 30 s).

## Fail-safe

Every tab's `apply_snapshot` / `apply_event` is wrapped in try/except by
the dispatcher. A bug in one tab cannot crash the app. Errors are
silently swallowed and surface only in the daemon's event stream.
