---
name: mishkan-org-reference
description: Print the MISHKAN organisation reference — 45 agents across 8 groups (Orchestration, Research, Chosheb, Panim, Yasad, Mishmar, Migdal, Sefer) with their roles, sources, and one-line descriptions. Use when you've forgotten who does what, or want a quick recall of the team structure.
---

# /mishkan-org-reference

Print the MISHKAN organisation reference inline. Runs the harness CLI's
`org` subcommand to surface the full structure so it lands in the session
transcript and stays consultable as the conversation continues.

## What it does

Prints, per group:

- Group name + domain (e.g. *Yasad · Backend*).
- For each agent in the group: alias (capitalised), snake_case role,
  one-line description.

The data source is `~/.claude/mishkan/org/org.json`, generated from
`docs/design/MISHKAN_agent_aliases.md` at install time.

## How to run

Invoke the harness CLI:

```bash
npx mishkan-harness org show
```

For a structured JSON dump (e.g. to feed another tool):

```bash
npx mishkan-harness org show --json
```

Always present the printed reference back to the user verbatim — do not
summarise it. The whole point of this command is recall; truncation defeats
the purpose. If the CLI is not installed, surface the install hint
(`npx mishkan-harness install`) rather than guessing.

## When to suggest it

- The user asks "qui fait X ?" / "who is responsible for Y in the org?".
- The user names an agent by alias and you're unsure of the role
  (this is the recall use case — print, don't guess).
- The user wants to learn the org structure ("recall me everyone in Mishmar").

## When NOT to use it

- Routine in-session work where the agent identity is already established.
- Exploratory questions about the harness itself — those go through Nehemiah.

## See also

- Full agent roster with biblical source and meaning:
  `docs/design/MISHKAN_agent_aliases.md`
- The Org-Ref tab in `mishkan-watch` (TUI): same data, browsable visually.
