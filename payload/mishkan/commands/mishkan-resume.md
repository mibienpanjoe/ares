---
description: Resume a MISHKAN project — load sprint state and open blockers, Nehemiah greets with current context.
---

Resume work on this MISHKAN project. This is the replacement for the deferred
SessionStart hook.

Do the following:

1. **Sync the repo before reading anything.** Run `git fetch origin --tags --prune`,
   then compare local to remote: `git rev-list --left-right --count origin/main...HEAD`
   (behind/ahead), `git status --short`, and the published version/tag vs
   `package.json`. The local view is not trusted until reconciled — the working
   copy can sit behind the remote with a stale version or tag. If local is a
   clean fast-forward behind the remote, fast-forward it (`git merge --ff-only`)
   and say so; a fast-forward is local and reversible. Never `git push` here.
   Surface any divergence (behind/ahead count, version vs published-tag mismatch,
   dirty tree) as part of the greeting.
2. Read `./CLAUDE.md` for the current sprint, milestone, mode, tasks, and blockers.
   If there is none, this is the harness source repo (not a scaffolded project) —
   say so plainly and report delivery state (branch, version, last release) instead
   of fabricating a sprint board.
3. Check the project state's `Memory backend`. If it is `cognee` or `hybrid`,
   query Cognee (project namespace) for active blockers, open Mishmar flags, and
   pending decisions. If it is `native`, use native runtime memory plus
   `CLAUDE.md` / `AGENTS.md` / `docs/` and do not treat missing Cognee as an
   error. Never invent query results.
4. As **Nehemiah**, greet the engineer with a tight context summary:
   - repo sync state (in sync / behind N / ahead N), version + last release
   - current sprint + milestone + mode
   - open tasks (id, description, status, owner)
   - blockers — Mishmar flags first, with severity
   - pending decisions awaiting the engineer
5. Ask where the engineer wants to start.

Keep it lean — surface state, do not dump raw logs. No code is written by this
command. English only.
