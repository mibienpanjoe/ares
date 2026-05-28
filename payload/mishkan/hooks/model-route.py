#!/usr/bin/env python3
"""MISHKAN PreToolUse hook — make config/model-routing.yaml authoritative.

Fires before the Task/Agent (subagent) tool runs. Reads the agent->tier map and
injects the resolved `model` into the tool input, so the YAML — not each agent's
frontmatter — is the single source of truth for which Claude tier a subagent
runs on. Frontmatter `model:` becomes the fallback used only when this hook is
absent.

Fail-open by contract: any parse/IO/format problem => emit nothing and exit 0,
so a broken config never blocks delegation. Only ever ADDS a `model` field.

stdin  : Claude Code PreToolUse JSON {tool_name, tool_input, ...}
stdout : {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                  "permissionDecision": "allow",
                                  "updatedInput": <tool_input + model>}}
"""
import json
import os
import sys

VALID = {"opus", "sonnet", "haiku"}
SUBAGENT_TOOLS = {"Task", "Agent"}
YAML = os.path.join(os.path.dirname(__file__), "..", "config", "model-routing.yaml")


def parse_routing(path):
    """Minimal YAML reader for this file's shape (no external deps).

    Captures `defaults.unlisted_agent` and the `agents:` name->tier map; strips
    inline `# comments`. Returns (agents_map, default_tier).
    """
    agents, default = {}, "sonnet"
    section = None
    with open(path, "r") as fh:
        for raw in fh:
            line = raw.split("#", 1)[0].rstrip()
            if not line.strip():
                continue
            if not line.startswith((" ", "\t")):           # top-level key
                section = line.strip().rstrip(":")
                continue
            key, _, val = line.strip().partition(":")
            key, val = key.strip(), val.strip()
            if not val:
                continue
            if section == "defaults" and key == "unlisted_agent" and val in VALID:
                default = val
            elif section == "agents" and val in VALID:
                agents[key] = val
    return agents, default


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return  # not parseable input -> do nothing

    tool = payload.get("tool_name", "")
    tin = payload.get("tool_input")
    if tool not in SUBAGENT_TOOLS or not isinstance(tin, dict):
        return

    subagent = tin.get("subagent_type")
    if not subagent:
        return  # generic/no-type agent call -> leave model to default mechanism

    try:
        agents, _default = parse_routing(YAML)
    except Exception:
        return  # missing/broken routing file -> fail open

    # Authoritative ONLY for agents the YAML explicitly lists (the MISHKAN fleet).
    # Foreign agents (e.g. aiobi-ops, Explore) keep their own frontmatter model —
    # never downgrade them via an unlisted fallback.
    if subagent not in agents:
        return
    model = agents[subagent]
    if model not in VALID:
        return

    updated = dict(tin)
    updated["model"] = model
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": f"MISHKAN model-routing: {subagent} -> {model}",
            "updatedInput": updated,
        }
    }))


if __name__ == "__main__":
    main()
