#!/usr/bin/env bash
# MISHKAN PreToolUse security hook — Ira (Mishmar).
# Inspects Write/Edit/MultiEdit content before it lands.
# Blocks: hardcoded secrets, eval of untrusted input, SQL string concatenation,
# :latest Docker tags. Returns a PreToolUse deny decision on violation.
#
# Fail-open by design: if the payload cannot be parsed (e.g. jq missing), the
# hook allows the operation and notes it on stderr rather than bricking all
# writes. Positive detections always block.
set -uo pipefail

INPUT="$(cat)"

# Need jq to inspect structured payload. Fail open if absent.
if ! command -v jq >/dev/null 2>&1; then
  echo "mishkan/pre-tool-security: jq not found — skipping inspection" >&2
  exit 0
fi

# Source observability bus (fail-open if missing).
MISHKAN_HOME_RES="${MISHKAN_HOME:-$HOME/.claude/mishkan}"
# shellcheck disable=SC1091
source "${MISHKAN_HOME_RES}/observability/bus.sh" 2>/dev/null || true

tool_name="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)"
file_path="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
session_id="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null)"

# Gather the content being written, across Write/Edit/MultiEdit shapes.
content="$(printf '%s' "$INPUT" | jq -r '
  [ .tool_input.content?,
    .tool_input.new_string?,
    ( .tool_input.edits? // [] | .[].new_string? )
  ] | map(select(. != null)) | join("\n")
' 2>/dev/null)"

# Nothing to inspect.
[ -z "$content" ] && exit 0

deny() {
  # PreToolUse deny via structured output.
  if command -v bus_emit >/dev/null 2>&1; then
    bus_emit "$session_id" "hook_fire" "$tool_name" "blocked" \
      "$(jq -cn --arg r "$1" '{hook:"ira", decision:"deny", reason:$r}')"
  fi
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

lc_path="$(printf '%s' "$file_path" | tr '[:upper:]' '[:lower:]')"

# 1. Hardcoded secrets — assignment of a non-env, non-placeholder literal.
if printf '%s' "$content" | grep -Eiq \
  '(password|passwd|secret|api[_-]?key|access[_-]?key|token|client[_-]?secret)[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']{6,}["'"'"']'; then
  # Allow obvious placeholders / env reads.
  if ! printf '%s' "$content" | grep -Eiq '(CHANGEME|<[^>]+>|\$\{?[A-Z_]+\}?|os\.environ|process\.env|getenv|settings\.|pydantic|vault|sops)'; then
    deny "Mishmar/Ira: hardcoded secret literal detected. Use SOPS/age + env injection, never literals in source. (rules/common/security.md)"
  fi
fi

# 2. Key material, private keys, and known provider token formats.
if printf '%s' "$content" | grep -Eq '(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'; then
  deny "Mishmar/Ira: key material detected in source. Move to SOPS-managed secrets. (rules/common/security.md)"
fi
if printf '%s' "$content" | grep -Eq '(gh[posu]_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_(live|test)_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]+|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|dckr_pat_[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,})'; then
  deny "Mishmar/Ira: a provider access token (GitHub/GitLab/Slack/Stripe/Google/SendGrid/Docker/npm) is hardcoded. Revoke it and move to SOPS/age + env. (rules/common/security.md)"
fi

# 2b. Connection strings with embedded credentials.
if printf '%s' "$content" | grep -Eiq '(postgres|postgresql|mysql|mongodb|mongodb\+srv|redis|amqp|amqps)://[^:@/[:space:]]+:[^@/[:space:]]+@'; then
  if ! printf '%s' "$content" | grep -Eiq '(<[^>]+>|\$\{?[A-Za-z_]+\}?|CHANGEME|:password@|:pass@|user:pass|env|getenv|os\.environ)'; then
    deny "Mishmar/Ira: connection string with an embedded credential. Inject the password from SOPS/env, not the URL literal. (rules/common/security.md)"
  fi
fi

# 3. Dynamic code execution / unsafe deserialization (py/js/ts).
case "$lc_path" in
  *.py|*.js|*.ts|*.tsx|*.jsx|*.mjs|*.cjs)
    if printf '%s' "$content" | grep -Eq '(^|[^a-zA-Z0-9_.])eval[[:space:]]*\(' \
       && ! printf '%s' "$content" | grep -Eiq '(ast\.literal_eval|# *safe-eval|json\.parse)'; then
      deny "Mishmar/Ira: eval() on dynamic input is forbidden. (rules/common/security.md)"
    fi
    # new Function(...) constructor (JS/TS code-from-string)
    if printf '%s' "$content" | grep -Eq 'new[[:space:]]+Function[[:space:]]*\('; then
      deny "Mishmar/Ira: new Function() builds code from a string. Forbidden. (rules/common/security.md)"
    fi
    ;;
esac
case "$lc_path" in
  *.py|*.pyi)
    # exec() on dynamic input
    if printf '%s' "$content" | grep -Eq '(^|[^a-zA-Z0-9_.])exec[[:space:]]*\(' \
       && ! printf '%s' "$content" | grep -Eiq '# *safe-exec'; then
      deny "Mishmar/Ira: exec() executes dynamic code. Forbidden. (rules/common/security.md)"
    fi
    # unsafe deserialization
    if printf '%s' "$content" | grep -Eq '(pickle\.loads?|cloudpickle\.loads?|marshal\.loads)[[:space:]]*\('; then
      deny "Mishmar/Ira: pickle/marshal deserialization of untrusted data is an RCE vector. Use a safe format (JSON). (rules/common/security.md)"
    fi
    # yaml.load without a safe loader
    if printf '%s' "$content" | grep -Eq 'yaml\.load[[:space:]]*\(' \
       && ! printf '%s' "$content" | grep -Eq '(SafeLoader|safe_load|Loader[[:space:]]*=[[:space:]]*yaml\.Safe)'; then
      deny "Mishmar/Ira: yaml.load() without SafeLoader can execute arbitrary objects. Use yaml.safe_load(). (rules/common/security.md)"
    fi
    # shell command injection vectors
    if printf '%s' "$content" | grep -Eq 'os\.system[[:space:]]*\('; then
      deny "Mishmar/Ira: os.system() invites command injection. Use subprocess with an argument list and no shell. (rules/common/security.md)"
    fi
    if printf '%s' "$content" | grep -Eq 'subprocess\.[A-Za-z_]+\(.*shell[[:space:]]*=[[:space:]]*True'; then
      deny "Mishmar/Ira: subprocess with shell=True is a command-injection risk. Pass an argument list, shell=False. (rules/common/security.md)"
    fi
    ;;
esac
case "$lc_path" in
  *.js|*.ts|*.tsx|*.jsx|*.mjs|*.cjs)
    # child_process exec with interpolation
    if printf '%s' "$content" | grep -Eq '(child_process|require\(.child_process.\))' \
       && printf '%s' "$content" | grep -Eq 'exec(Sync)?[[:space:]]*\(.*(\$\{|`.*\$|"[[:space:]]*\+)'; then
      deny "Mishmar/Ira: child_process exec with string interpolation is a command-injection risk. Use execFile with an args array. (rules/common/security.md)"
    fi
    ;;
esac

# 4. SQL string concatenation / f-string interpolation.
if printf '%s' "$content" | grep -Eiq '(select|insert|update|delete)[[:space:]].*("[[:space:]]*\+|\+[[:space:]]*"|f"[^"]*\{|%[[:space:]]*\()'; then
  deny "Mishmar/Ira: SQL built by string concatenation/interpolation. Use parameterised queries (asyncpg params / ORM bindings). (rules/common/security.md)"
fi

# 5. :latest Docker tags (and untagged FROM).
case "$lc_path" in
  *dockerfile*|*docker-compose*|*compose*|*.yaml|*.yml)
    if printf '%s' "$content" | grep -Eiq '(image:[[:space:]]*[^[:space:]]+:latest|^[[:space:]]*FROM[[:space:]]+[^[:space:]]+:latest)'; then
      deny "Mishmar/Ira: ':latest' tag detected. Pin all image versions. (rules/infrastructure/migdal.md, y4nn-standards)"
    fi
    ;;
esac

# 6. TLS/certificate verification disabled.
if printf '%s' "$content" | grep -Eiq '(verify[[:space:]]*=[[:space:]]*False|rejectUnauthorized[[:space:]]*:[[:space:]]*false|InsecureSkipVerify[[:space:]]*:[[:space:]]*true|NODE_TLS_REJECT_UNAUTHORIZED[[:space:]]*=[[:space:]]*.?0|curl_setopt.*CURLOPT_SSL_VERIFYPEER.*false|ssl[._]?verify[[:space:]]*=[[:space:]]*false)'; then
  deny "Mishmar/Ira: TLS/certificate verification is being disabled. This breaks transport security. (rules/common/security.md)"
fi

# 7. Weak hashing used on a password/secret.
if printf '%s' "$content" | grep -Eiq '(md5|sha1)[[:space:]]*\([^)]*(pass|pwd|secret|token|credential)'; then
  deny "Mishmar/Ira: weak hash (MD5/SHA1) applied to a credential. Use bcrypt/argon2/scrypt for passwords. (rules/common/security.md)"
fi

# 8. CORS wildcard combined with credentials (same write).
if printf '%s' "$content" | grep -Eiq 'access-control-allow-origin["'"'"'[:space:]]*[:=][[:space:]]*["'"'"']?\*' \
   && printf '%s' "$content" | grep -Eiq 'access-control-allow-credentials["'"'"'[:space:]]*[:=][[:space:]]*["'"'"']?true'; then
  deny "Mishmar/Ira: CORS '*' origin together with credentials:true is forbidden by the CORS spec and leaks credentials. Pin explicit origins. (rules/common/security.md, OWASP API Top 10)"
fi

# Reached the end with no deny: emit allow hook_fire telemetry.
if command -v bus_emit >/dev/null 2>&1; then
  bus_emit "$session_id" "hook_fire" "$tool_name" "completed" \
    '{"hook":"ira","decision":"allow"}'
fi

exit 0
