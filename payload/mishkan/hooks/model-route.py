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

VALID = {"opus", "sonnet", "haiku", "fable"}
SUBAGENT_TOOLS = {"Task", "Agent"}
YAML = os.path.join(os.path.dirname(__file__), "..", "config", "model-routing.yaml")
# D-017 — user overlay. Engineer overrides written by `ares model set/reset`.
# Preserved across `ares install`; entries here WIN over the shipped default.
# Absent by default -> behaves exactly as the single-file routing did.
LOCAL_YAML = os.path.join(os.path.dirname(__file__), "..", "config", "model-routing.local.yaml")

# Make the observability bus importable; fail-open if it isn't (older harness
# installs, missing payload, broken path). Never block delegation on a bus
# import error.
_BUS_DIR = os.path.join(os.path.dirname(__file__), "..", "observability")
if _BUS_DIR not in sys.path:
    sys.path.insert(0, _BUS_DIR)
try:
    from bus import emit as _bus_emit  # type: ignore
except Exception:
    def _bus_emit(*_args, **_kwargs):  # noqa: ANN001
        return None


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
    session = payload.get("session_id", "unknown")
    if tool not in SUBAGENT_TOOLS or not isinstance(tin, dict):
        return

    subagent = tin.get("subagent_type")
    if not subagent:
        return  # generic/no-type agent call -> leave model to default mechanism

    try:
        agents, _default = parse_routing(YAML)
    except Exception:
        return  # missing/broken routing file -> fail open

    # D-017 overlay: the engineer's local overrides win per-agent. Fail-open —
    # a missing or malformed overlay leaves the shipped default untouched.
    if os.path.exists(LOCAL_YAML):
        try:
            local_agents, _ = parse_routing(LOCAL_YAML)
            agents.update(local_agents)
        except Exception:
            pass

    # Authoritative ONLY for agents the YAML explicitly lists (the MISHKAN fleet).
    # Foreign agents (e.g. aiobi-ops, Explore) keep their own frontmatter model —
    # never downgrade them via an unlisted fallback.
    if subagent not in agents:
        _bus_emit(
            session,
            "hook_fire",
            tool=tool,
            outcome="completed",
            payload={
                "hook": "model-route",
                "decision": "ok",
                "reason": f"{subagent} not in routing map (foreign agent kept own model)",
            },
        )
        return
    model = agents[subagent]
    if model not in VALID:
        return

    updated = dict(tin)
    updated["model"] = model
    _bus_emit(
        session,
        "hook_fire",
        tool=tool,
        outcome="completed",
        agent=subagent,
        payload={"hook": "model-route", "decision": "allow", "reason": f"{subagent} -> {model}"},
    )
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
