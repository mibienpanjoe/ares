#!/usr/bin/env node
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const hooksDir = join(root, "payload", "mishkan", "hooks");
const tmp = `/tmp/ares-hooks-check-${process.pid}-${randomUUID()}`;
const logs = join(tmp, "logs");
const traces = join(tmp, "traces");
const env = {
  ...process.env,
  HOME: join(tmp, "home"),
  ARES_HOME: join(root, "payload", "mishkan"),
  ARES_LOG_DIR: logs,
  ARES_TRACE_DIR: traces,
  PYTHONDONTWRITEBYTECODE: "1",
};

function fail(message, result = null) {
  process.stderr.write(`check-hooks: ${message}\n`);
  if (result?.stdout) process.stderr.write(result.stdout);
  if (result?.stderr) process.stderr.write(result.stderr);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function runHook(name, payload) {
  const inputPath = join(tmp, "hook-input.json");
  writeFileSync(inputPath, JSON.stringify(payload));
  const inputFd = openSync(inputPath, "r");
  let result;
  try {
    result = spawnSync("bash", [join(hooksDir, name)], {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: [inputFd, "pipe", "pipe"],
      timeout: 5000,
    });
  } finally {
    closeSync(inputFd);
  }
  if (result.status !== 0) {
    fail(`${name} exited ${result.status} (signal=${result.signal || "none"}, error=${result.error?.message || "none"})`, result);
  }
  return result.stdout.trim();
}

function securityPayload(toolName, toolInput, session = "security-check") {
  return {
    session_id: session,
    cwd: root,
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: `${session}-call`,
  };
}

function assertDenied(output, label) {
  assert(output !== "", `${label} was not denied`);
  let parsed;
  try { parsed = JSON.parse(output); } catch { fail(`${label} returned invalid JSON: ${output}`); }
  assert(parsed.hookSpecificOutput?.hookEventName === "PreToolUse", `${label} returned the wrong hook envelope`);
  assert(parsed.hookSpecificOutput?.permissionDecision === "deny", `${label} did not return permissionDecision:deny`);
  assert(Boolean(parsed.hookSpecificOutput?.permissionDecisionReason), `${label} omitted the denial reason`);
}

if (spawnSync("jq", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.warn("check-hooks: jq not found; deterministic hooks are fail-open, payload tests skipped");
  process.exit(0);
}

rmSync(tmp, { recursive: true, force: true });
mkdirSync(logs, { recursive: true });
mkdirSync(traces, { recursive: true });
mkdirSync(env.HOME, { recursive: true });

try {
  const claudeSafe = runHook("pre-tool-security.sh", securityPayload("Write", {
    file_path: "src/config.js",
    content: "const apiKey = process.env.API_KEY;\n",
  }, "claude-safe"));
  assert(claudeSafe === "", "safe Claude Write produced a decision payload");

  const claudeDenied = runHook("pre-tool-security.sh", securityPayload("Write", {
    file_path: "src/config.js",
    content: 'const apiKey = "super-secret-token";\n',
  }, "claude-deny"));
  assertDenied(claudeDenied, "Claude hardcoded secret");

  const safePatch = `*** Begin Patch
*** Update File: src/config.js
@@
-const apiKey = "super-secret-token";
+const apiKey = process.env.API_KEY;
*** End Patch`;
  const codexSafe = runHook("pre-tool-security.sh", securityPayload("apply_patch", {
    command: safePatch,
  }, "codex-safe"));
  assert(codexSafe === "", "Codex patch removing a secret was falsely denied");

  const secretPatch = `*** Begin Patch
*** Add File: src/config.js
+const apiKey = "super-secret-token";
*** End Patch`;
  assertDenied(
    runHook("pre-tool-security.sh", securityPayload("apply_patch", { command: secretPatch }, "codex-secret")),
    "Codex hardcoded secret",
  );

  const multiFilePatch = `*** Begin Patch
*** Add File: src/risky.py
+result = eval(user_input)
*** Add File: README.md
+Safe documentation.
*** End Patch`;
  assertDenied(
    runHook("pre-tool-security.sh", securityPayload("apply_patch", { command: multiFilePatch }, "codex-eval")),
    "Codex multi-file eval",
  );

  const dockerPatch = `*** Begin Patch
*** Add File: compose.yaml
+services:
+  db:
+    image: postgres:latest
*** End Patch`;
  assertDenied(
    runHook("pre-tool-security.sh", securityPayload("apply_patch", { command: dockerPatch }, "codex-docker")),
    "Codex latest Docker tag",
  );

  const session = "codex-observe";
  const toolUseId = "call-apply-patch-1";
  const observedPatch = `*** Begin Patch
*** Update File: src/example.js
@@
-const oldValue = 1;
+const value = 2;
+const nextValue = 3;
*** End Patch`;
  const prePayload = {
    session_id: session,
    turn_id: "turn-1",
    cwd: "/tmp/ares-target-project",
    hook_event_name: "PreToolUse",
    model: "gpt-test",
    permission_mode: "workspace-write",
    tool_name: "apply_patch",
    tool_input: { command: observedPatch },
    tool_use_id: toolUseId,
  };
  assert(runHook("pre-tool-trace.sh", prePayload) === "", "Codex pre-tool trace wrote stdout");
  const tracePath = join(traces, `mishkan-trace-${session}.tmp`);
  assert(existsSync(tracePath), "Codex pre-tool trace file missing");
  assert(readFileSync(tracePath, "utf8").includes(toolUseId), "Codex pre-tool trace id missing");

  const postPayload = {
    ...prePayload,
    hook_event_name: "PostToolUse",
    tool_response: { content: "Done!" },
  };
  assert(runHook("post-tool-observe.sh", postPayload) === "", "Codex post-tool observer wrote stdout");
  const events = readFileSync(join(logs, `${session}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  const toolCall = events.find(event => event.type === "tool_call");
  assert(toolCall?.tool === "apply_patch", "Codex tool_call event missing");
  assert(toolCall?.project === "/tmp/ares-target-project", "Codex tool_call cwd was not preserved");
  const fileChange = events.find(event => event.type === "file_change");
  assert(fileChange?.payload?.path === "src/example.js", "Codex apply_patch file_change path missing");
  assert(fileChange?.payload?.op === "update", "Codex apply_patch operation missing");
  assert(fileChange?.payload?.lines_added === 2, "Codex apply_patch added-line count is wrong");
  assert(fileChange?.payload?.lines_removed === 1, "Codex apply_patch removed-line count is wrong");
  assert(!readFileSync(tracePath, "utf8").includes(toolUseId), "Codex post-tool observer did not consume trace id");

  console.log("check-hooks ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
