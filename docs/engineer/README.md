# Engineer Profile — canonical, replaceable

This directory holds the **single source of truth** for the engineer the harness
serves. It is meant to be edited or replaced by the engineer.

| File | Role |
|---|---|
| `profile.example.md` | Sanitized template committed to the repo. Copy this first. |
| `profile.md` | Canonical, agent-loadable profile. Gitignored. This is what ARES agents load as engineer context after install/sync to `~/.ares/profile.md`. |
| `profile-readable.md` | Optional local human-readable narrative companion. Gitignored. Reference only; not loaded by agents. |

## How it propagates

Your local `profile.md` is the source. Two layers consume it:

1. **Mechanical (a script):** `~/.ares/scripts/sync-profile.sh` copies `profile.md` →
   `~/.ares/profile.md` (the runtime path every reference points at) and
   audits the harness for stale references. Run it after any edit, or at install.

2. **Semantic (an agent):** **Seraiah** (Sefer org-layer) owns re-deriving the
   digests that were drawn *from* the profile when it materially changes — target
   runtime guidance (`CLAUDE.md` / `AGENTS.md`) and any engineering-identity docs.
   The script moves bytes; Seraiah keeps meaning in sync.

## Replacing the profile

Copy `profile.example.md` to `profile.md`, replace the placeholders, keep the section
structure — identity, how you think, stack, practice, AI-collaboration, strengths —
then run `~/.ares/scripts/sync-profile.sh`,
then ask Seraiah to re-derive the target runtime guidance. Nothing
else in the harness hardcodes the previous engineer.

## What references this profile

- `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md` / `~/.config/opencode/AGENTS.md` (user-level identity → non-negotiables digest)
- `~/.ares/agents/seraiah.md` and target-native copies (org-layer identity owner)
- runtime load path: `~/.ares/profile.md`

Run `~/.ares/scripts/sync-profile.sh --check` to list current references and flag drift.
