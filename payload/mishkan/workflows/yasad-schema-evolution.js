// yasad-schema-evolution — zero-downtime multi-release schema change orchestration.
//
// A schema change that requires phased rollout (dual-write, backfill,
// switch-read, drop-old) goes in; the workflow plans the phases, validates
// each phase against zero-downtime invariants, and produces a per-phase
// runbook with rollback for each step.
//
// Pattern: pipeline (plan → per-phase validate) + barrier + judge panel.
// Differs from yasad-data-migration-wave: this is a SINGLE schema change
// across MULTIPLE releases, not multiple migrations in one wave.

export const meta = {
  name: "yasad-schema-evolution",
  description: "Phase a single schema change across multiple releases with zero-downtime invariants and per-phase rollback.",
  whenToUse: "Schema change that can't ship atomically — needs dual-write / backfill / switch / drop sequence.",
  phases: [{ title: "Plan" }, { title: "Validate" }, { title: "Runbook" }],
};

const change = args?.change;
const project = args?.project ?? ".";
if (!change) throw new Error("args.change is required (e.g. {from: 'users.email_text', to: 'users.email_normalized', rationale: '...'})");

const PLAN_SCHEMA = {
  type: "object", required: ["phases"],
  properties: { phases: { type: "array", items: { type: "object", required: ["name", "actions", "invariants"], properties: { name: {type:"string"}, actions: {type:"array", items:{type:"string"}}, invariants: {type:"array", items:{type:"string"}}, rollback: {type:"array", items:{type:"string"}}, release: {type:"string"} } } } },
};
const VALIDATE_SCHEMA = {
  type: "object", required: ["safe", "rationale"],
  properties: { safe: {type:"boolean"}, rationale: {type:"string"}, risks: {type:"array", items:{type:"string"}} },
};

phase("Plan");
const plan = await agent(
  `Schema change: ${JSON.stringify(change)}. Project: ${project}. Plan the phased rollout (typically: add-new-column → dual-write → backfill → switch-read → drop-old). Each phase: actions, invariants that MUST hold during the phase, rollback steps, target release. Return the schema.`,
  { schema: PLAN_SCHEMA, label: "plan-phases", agentType: "shallum" },
);

const phases = plan?.phases ?? [];
log(`Plan: ${phases.length} phases.`);

phase("Validate");
const REVIEWERS = [
  { key: "consumer-safety", agent: "nathan",  prompt: "Consumer safety: at every phase boundary, can every existing consumer keep working without code change? Identify breakage windows." },
  { key: "data-integrity",  agent: "shallum", prompt: "Data integrity: backfill correctness, dual-write consistency, race conditions, idempotency." },
  { key: "rollback",        agent: "zadok",   prompt: "Rollback: from each phase, is there a clean rollback that doesn't lose data? Identify points of no return." },
];

const validations = await parallel(phases.map((ph, i) => () =>
  parallel(REVIEWERS.map(R => () =>
    agent(
      `Schema change overall: ${JSON.stringify(change)}. Phase ${i+1}/${phases.length}: ${JSON.stringify(ph)}. Your lens: ${R.prompt} Default safe=false if uncertain.`,
      { schema: VALIDATE_SCHEMA, label: `validate:${R.key}:${ph.name}`, agentType: R.agent, phase: "Validate" },
    )
  )).then(verdicts => {
    const valid = verdicts.filter(Boolean);
    const safeCount = valid.filter(v => v.safe).length;
    return { phase: ph, verdicts: valid, all_safe: safeCount === REVIEWERS.length, risks: valid.flatMap(v => v.risks ?? []) };
  })
));

phase("Runbook");
const runbook = await agent(
  `Schema change: ${JSON.stringify(change)}. Validated phases: ${JSON.stringify(validations.map(v => ({phase: v.phase.name, safe: v.all_safe, risks: v.risks})))}. Produce a per-phase runbook: pre-checks, exact commands, post-checks, rollback. Markdown.`,
  { label: "produce-runbook", agentType: "shallum", phase: "Runbook" },
);

const blocked = validations.filter(v => !v.all_safe);
return {
  change,
  phases: validations.map(v => ({ name: v.phase.name, release: v.phase.release, all_safe: v.all_safe, risks: v.risks })),
  runbook,
  decision: blocked.length === 0 ? "ship" : "block",
  summary: blocked.length === 0
    ? `Schema evolution validated across ${phases.length} phases by 3/3 reviewers. Runbook produced.`
    : `${blocked.length}/${phases.length} phases BLOCKED. Address risks before next release.`,
};
