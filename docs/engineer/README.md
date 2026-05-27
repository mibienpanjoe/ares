# Engineer Profile — canonical, replaceable

This directory holds the **single source of truth** for the engineer the harness
serves. It is meant to be edited or replaced by the engineer.

| File | Role |
|---|---|
| `profile.md` | Canonical, agent-loadable profile. This is what MISHKAN agents load as engineer context (copied at install/sync to `~/.claude/mishkan/profile.md`). |
| `profile-readable.md` | Human-readable narrative companion. Reference, not loaded by agents. |

## How it propagates

`profile.md` is the source. Two layers consume it:

1. **Mechanical (a script):** `scripts/sync-profile.sh` copies `profile.md` →
   `~/.claude/mishkan/profile.md` (the runtime path every reference points at) and
   audits the harness for stale references. Run it after any edit, or at install.

2. **Semantic (an agent):** **Seraiah** (Sefer org-layer) owns re-deriving the
   digests that were drawn *from* the profile when it materially changes — the
   non-negotiables block in the user-level `CLAUDE.md` and any engineering-identity
   docs. The script moves bytes; Seraiah keeps meaning in sync.

## Replacing the profile (another engineer adopting MISHKAN)

Drop your own `profile.md` here (keep the section structure — identity, how you
think, stack, practice, AI-collaboration, strengths), run `scripts/sync-profile.sh`,
then ask Seraiah to re-derive the user-level `CLAUDE.md` non-negotiables. Nothing
else in the harness hardcodes the previous engineer.

## What references this profile

- `~/.claude/CLAUDE.md` (user-level identity → non-negotiables digest)
- `~/.claude/mishkan/agents/seraiah.md` (org-layer identity owner)
- runtime load path: `~/.claude/mishkan/profile.md`

Run `scripts/sync-profile.sh --check` to list current references and flag drift.
