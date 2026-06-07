// migdal-dr-drill — disaster recovery drill orchestration.
//
// A DR scenario (region loss, DB corruption, secret leak, control-plane
// outage) is specified; the workflow orchestrates the drill: enumerate
// recovery steps, simulate per step, verify each via independent observer,
// measure RTO/RPO against target. Synthesises a drill report with gaps.
//
// Pattern: pipeline (enumerate → simulate → verify) + barrier + judge panel.
// ADR D-010 check:
//   - parallelism: simulation step × independent observer per step.
//   - panel orthogonality: Palal (systems-level recovery) + Hanun (operational
//     observability during drill) + Rehum (health/safety post-recovery).
//   - synthesis: RTO/RPO measurement + gap list.

export const meta = {
  name: "migdal-dr-drill",
  description: "Disaster recovery drill — enumerate steps, simulate, verify, measure RTO/RPO, report gaps.",
  whenToUse: "Quarterly DR exercise, or after any infra change that affects recovery topology.",
  phases: [{ title: "Plan" }, { title: "Simulate" }, { title: "Report" }],
};

const scenario = args?.scenario;
const rtoTarget = args?.rto_target_minutes ?? 30;
const rpoTarget = args?.rpo_target_minutes ?? 5;
const project = args?.project ?? ".";
if (!scenario) throw new Error("args.scenario is required (e.g. 'primary-region-loss' | 'db-corruption' | 'secret-leak')");

const PLAN_SCHEMA = {
  type: "object", required: ["steps"],
  properties: { steps: { type: "array", items: { type: "object", required: ["order", "action", "expected_outcome"], properties: { order:{type:"integer"}, action:{type:"string"}, expected_outcome:{type:"string"}, depends_on:{type:"array", items:{type:"integer"}} } } } },
};
const VERIFY_SCHEMA = {
  type: "object", required: ["verified", "rationale"],
  properties: { verified:{type:"boolean"}, rationale:{type:"string"}, gap:{type:"string"}, time_estimate_minutes:{type:"number"} },
};

phase("Plan");
const plan = await agent(
  `DR scenario: ${scenario}. Project: ${project}. RTO target: ${rtoTarget}min, RPO target: ${rpoTarget}min. Enumerate the recovery steps in order with dependencies. Return the schema.`,
  { schema: PLAN_SCHEMA, label: "plan-recovery", agentType: "palal" },
);

const steps = plan?.steps ?? [];
log(`DR plan: ${steps.length} recovery steps.`);

phase("Simulate");
const OBSERVERS = [
  { key: "systems", agent: "palal",  prompt: "Systems lens: does this step actually recover the targeted system? Hidden dependencies?" },
  { key: "ops",     agent: "hanun",  prompt: "Operations lens: are the runbooks ready, secrets accessible, on-call awake, monitoring live during this step?" },
  { key: "health",  agent: "rehum",  prompt: "Health lens: post-step health checks, data-integrity probes, success criteria. Is the system actually healthy after?" },
];

const simulated = await parallel(steps.map(S => () =>
  parallel(OBSERVERS.map(O => () =>
    agent(
      `DR scenario: ${scenario}. Step ${S.order}: ${S.action} (expected: ${S.expected_outcome}). Your lens: ${O.prompt} Default verified=false if uncertain.`,
      { schema: VERIFY_SCHEMA, label: `simulate:${O.key}:step${S.order}`, agentType: O.agent, phase: "Simulate" },
    )
  )).then(verdicts => {
    const valid = verdicts.filter(Boolean);
    const verifiedCount = valid.filter(v => v.verified).length;
    const times = valid.map(v => v.time_estimate_minutes ?? 0).filter(t => t > 0);
    const meanTime = times.length ? times.reduce((a,b)=>a+b, 0) / times.length : 0;
    return { step: S, verdicts: valid, verified_count: verifiedCount, all_verified: verifiedCount === OBSERVERS.length, gaps: valid.map(v => v.gap).filter(Boolean), time_minutes: meanTime };
  })
));

phase("Report");
const totalTime = simulated.reduce((a, s) => a + (s.time_minutes ?? 0), 0);
const allGaps = simulated.flatMap(s => s.gaps);
const failedSteps = simulated.filter(s => !s.all_verified);

const rtoMet = totalTime <= rtoTarget;
const passes = failedSteps.length === 0;

const report = await agent(
  `DR drill report. Scenario: ${scenario}. ${steps.length} steps, ${failedSteps.length} failed verification. Estimated RTO: ${totalTime.toFixed(1)}min vs target ${rtoTarget}min. Gaps: ${JSON.stringify(allGaps)}. Produce a markdown report: executive summary, per-step status, gap remediation list.`,
  { label: "produce-report", agentType: "rehum", phase: "Report" },
);

return {
  scenario,
  rto_target_minutes: rtoTarget,
  rto_estimate_minutes: totalTime,
  rto_met: rtoMet,
  steps_total: steps.length,
  steps_passed: simulated.filter(s => s.all_verified).length,
  gaps: allGaps,
  report,
  decision: passes && rtoMet ? "ready" : "not-ready",
  summary: passes && rtoMet
    ? `DR drill PASS. ${steps.length}/${steps.length} steps verified. RTO ${totalTime.toFixed(1)}min ≤ ${rtoTarget}min target.`
    : `DR drill FAIL. ${failedSteps.length} unverified steps${rtoMet ? "" : `, RTO ${totalTime.toFixed(1)}min > ${rtoTarget}min target`}. ${allGaps.length} gaps to address.`,
};
