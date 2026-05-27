---
name: engineer-profile
description: Canonical engineer profile loaded as context by MISHKAN agents. THIS IS A SANITIZED EXAMPLE — copy to profile.md and fill with your own details. profile.md is gitignored; never commit real names, employers, hosts, IPs, or credentials.
type: developer_profile
version: 1.0
scope: agent-loadable
language: en
---

# Engineer Profile — EXAMPLE

> Copy this file to `profile.md` (same directory) and replace every placeholder
> with your own details, then run `scripts/sync-profile.sh`. `profile.md` is
> gitignored so your real profile never enters the public repo. Keep the section
> structure — agents rely on it.
>
> **Never put secrets, production IPs, internal hostnames, or other people's names
> in a profile that will be published.** Operational specifics belong in your local
> `profile.md`, not here.

## 0. Identity

```yaml
name: <your name>
handle: <your handle>
github: <username>
languages: [<spoken/working languages>]
title: <your title>
focus: <what you build — e.g. backend, infra, frontend, ML>
```

## 1. How you think about engineering

A few sentences on your engineering philosophy. Examples of the kind of thing
agents use: do you sequence design before code? verify before fixing? prefer
durable solutions over workarounds? hold tight scope? State it plainly with the
*why*, because agents apply principles they understand.

## 2. How you work with AI

```yaml
delegation:
  high:  [<work you delegate freely — e.g. UI, config, boilerplate>]
  zero:  [<work AI must never execute — e.g. git push, prod ssh, sudo, migrations>]
prompting_style: <terse/structured/exploratory…>
non_negotiables: [<your hard rules>]
```

## 3. Stack

```yaml
languages: [<languages you ship in>]
frontend:  [<frameworks/tools>]
backend:   [<frameworks/tools>]
data:      [<databases>]
infra:     [<containers, CI, cloud, IaC>]
security:  [<practices/tools>]
ai_ml:     [<if applicable>]
```

## 4. Engineering practice

- **Version control:** <commit conventions, branching>
- **Deployment:** <how you ship>
- **Documentation:** <who you write for, what depth>
- **Testing:** <your bar>

## 5. Strengths

- <evidence-anchored strengths — what you're genuinely good at>

## 6. Focus / growth areas

- <what you're deepening — skills, practices, tooling>

---

*Sanitized example. Real profile lives in `profile.md` (gitignored). See
`docs/engineer/README.md` for the propagation model.*
