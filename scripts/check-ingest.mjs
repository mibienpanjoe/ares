#!/usr/bin/env node
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const tmp = `/tmp/ares-ingest-check-${process.pid}`;
const project = join(tmp, "demo-project");
const docs = join(project, "docs");
const fakeBin = join(tmp, "bin");

function fail(message, result = null) {
  process.stderr.write(`check-ingest: ${message}\n`);
  if (result?.stdout) process.stderr.write(result.stdout);
  if (result?.stderr) process.stderr.write(result.stderr);
  process.exit(1);
}

function run(args) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: project,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH || ""}` },
    encoding: "utf8",
  });
  if (result.status !== 0) fail(`command failed (${result.status}): ${args.join(" ")}`, result);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

rmSync(tmp, { recursive: true, force: true });
mkdirSync(docs, { recursive: true });
mkdirSync(fakeBin, { recursive: true });

writeFileSync(join(docs, "ares.md"), "---\nares: ingest\n---\n\n# ARES\n");
writeFileSync(join(docs, "legacy.md"), "---\nmishkan: ingest\n---\n\n# Legacy\n");
writeFileSync(join(docs, "untagged.md"), "# Untagged\n");

const docker = join(fakeBin, "docker");
writeFileSync(docker, `#!/usr/bin/env bash
if [[ "\${1:-}" == "ps" ]]; then
  printf '%s\\n' 'ares-work-demo-project'
fi
exit 0
`);
chmodSync(docker, 0o755);

try {
  const script = join(root, "payload", "mishkan", "scripts", "mishkan-ingest.sh");
  const tagged = run(["bash", script, "--tagged-only"]);
  assert(tagged.includes("ingesting 2 file(s)"), "tagged-only did not select exactly ARES + legacy tags");
  assert(tagged.includes("ares.md"), "ares: ingest document was not selected");
  assert(tagged.includes("legacy.md"), "legacy mishkan: ingest document was not selected");
  assert(!tagged.includes("untagged.md"), "untagged document was selected in tagged-only mode");

  const explicit = run(["bash", script, "docs/untagged.md"]);
  assert(explicit.includes("ingesting 1 file(s)"), "explicit-path ingest did not select one document");
  assert(explicit.includes("untagged.md"), "explicit untagged document was not selected");

  console.log("check-ingest ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
