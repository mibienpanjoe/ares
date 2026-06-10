// yasad-data-migration-wave — per-table DB migration with 4-reviewer panel.
//
// A migration plan (one or more tables) goes in; each table is independently
// reviewed by 4 orthogonal lenses (contracts, perf, security, tests), then
// verified by running the migration in a worktree against a fresh snapshot.
//
// Pattern: pipeline (analyze → per-table review → verify) + judge panel.
// ADR D-010 check:
//   - parallelism: tables × 4 reviewers.
//   - panel orthogonality: Nathan (contracts), Zadok (perf/index),
//     Shallum (data security/PII), Uriah (tests) — distinct domains.
//   - synthesis: per-table go/no-go + rollback plan.

export const meta = {
  name: "yasad-data-migration-wave",
  description: "Wave of DB migrations, per-table reviewed by 4 orthogonal lenses (contracts/perf/security/tests).",
  whenToUse: "Before applying a migration that touches multiple tables or has invariant impact.",
  phases: [{ title: "Analyze" }, { title: "Review" }, { title: "Verify" }],
};

// The workflow runner may deliver `args` as a JSON string; normalize to an
// object so the `args?.x` reads work — and stay robust if passed already-parsed.
if (typeof args === "string") args = JSON.parse(args);

const migrationPlan = args?.migration_plan;
const project = args?.project ?? ".";
const verifyCmd = args?.verify_command;
if (!migrationPlan) throw new Error("args.migration_plan is required (array of {table, change, reason})");

const REVIEW_SCHEMA = {
  type: "object", required: ["safe", "rationale"],
  properties: { safe: {type:"boolean"}, rationale: {type:"string"}, blockers: {type:"array", items:{type:"string"}}, mitigations: {type:"array", items:{type:"string"}} },
};

phase("Analyze");
log(`Migration wave: ${migrationPlan.length} tables to review.`);

phase("Review");
const REVIEWERS = [
  { key: "contracts", agent: "nathan",  prompt: "API contracts: does this migration break any consumer of this table (endpoints, events, projections)?" },
  { key: "perf",      agent: "zadok",   prompt: "Performance: index implications, lock duration, table-scan risk, query plan changes for downstream queries." },
  { key: "security",  agent: "shallum", prompt: "Data security: PII handling, encryption-at-rest changes, RLS impact, audit trail." },
  { key: "tests",     agent: "uriah",   prompt: "Tests: what tests exist for this table, which break, which are missing. Test plan for the migration itself." },
];

const reviewed = await parallel(migrationPlan.map(M => () =>
  parallel(REVIEWERS.map(R => () =>
    agent(
      `Migration: table=${M.table}, change=${M.change}, reason=${M.reason}. Project: ${project}. Your lens: ${R.prompt} Default safe=false if uncertain.`,
      { schema: REVIEW_SCHEMA, label: `review:${R.key}:${M.table}`, agentType: R.agent, phase: "Review" },
    )
  )).then(verdicts => {
    const valid = verdicts.filter(Boolean);
    const safeCount = valid.filter(v => v.safe).length;
    const blockers = valid.flatMap(v => v.blockers ?? []);
    return { migration: M, lens_verdicts: valid, safe_count: safeCount, all_safe: safeCount === REVIEWERS.length, blockers };
  })
));

const allSafe = reviewed.filter(r => r.all_safe);
const blocked = reviewed.filter(r => !r.all_safe);
log(`${allSafe.length}/${migrationPlan.length} migrations cleared 4/4 lenses.`);

phase("Verify");
let verifyResult = null;
if (verifyCmd && allSafe.length === migrationPlan.length) {
  verifyResult = await agent(
    `Run \`${verifyCmd}\` to verify the migration applies cleanly against a fresh snapshot. Report stdout/stderr/exit code summary.`,
    { label: "verify-migration", agentType: "hizkiah", phase: "Verify" },
  );
}

return {
  migration_plan: migrationPlan,
  reviewed: reviewed.map(r => ({ table: r.migration.table, safe_count: r.safe_count, all_safe: r.all_safe, blockers: r.blockers })),
  blocked_tables: blocked.map(b => b.migration.table),
  verify_result: verifyResult,
  decision: blocked.length === 0 ? "ship" : "block",
  summary: blocked.length === 0
    ? `All ${allSafe.length} migrations cleared 4/4 lenses. Verify: ${verifyResult ? "ran" : "skipped"}.`
    : `${blocked.length} migrations BLOCKED. Address blockers per-table before re-running.`,
};
