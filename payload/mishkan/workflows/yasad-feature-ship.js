// yasad-feature-ship — backend feature shipped through an unskippable QA loop.
//
// A backend feature/task goes in; Zerubbabel routes it to the owning
// specialist, who implements; then a 3-lens orthogonal QA panel evaluates,
// and the work LOOPS back to the implementer until QA returns zero blocker-
// severity findings — or escalates to the engineer at the cycle cap. This is
// the deterministic, unskippable form of the team-lead-craft §6.1 chain: the
// model cannot self-grade or shortcut the loop because the control flow owns it.
//
// Pattern: route → (implement → QA panel → loop-until-no-blockers) → synthesise.
// Per ADR D-010 anti-pattern check:
//   - skill-in-workflow-clothing: NO — has a termination predicate (zero
//     blockers) AND a parallel 3-lens panel × bounded cycles (≥6 agents).
//   - workflow-calling-workflow-without-contract: NO — no nesting.
//   - non-orthogonal panel: NO — contract-conformance (Zadok) / test-execution
//     (Uriah) / data-layer-safety (Shallum) are distinct evaluation domains,
//     <70% criteria overlap.
//   - workflow-as-status-page: NO — the loop produces a QA-clean artifact or a
//     structured escalation; the synthesis is the reason it exists.

export const meta = {
  name: "yasad-feature-ship",
  description: "Backend feature run through implement → 3-lens QA panel → loop-until-no-blockers (cap 3) → escalate. The unskippable Lead→Specialist→QA chain.",
  whenToUse: "When Yasad has a scoped backend feature/fix that must provably pass QA before it ships — not a migration (yasad-data-migration-wave) or schema change (yasad-schema-evolution).",
  phases: [{ title: "Route" }, { title: "Build" }, { title: "QA" }, { title: "Settle" }],
};

// The workflow runner may deliver `args` as a JSON string (observed in this
// runtime); normalize to an object so the `args?.x` reads work — and stay robust
// if a caller passes it already-parsed.
if (typeof args === "string") args = JSON.parse(args);

const feature = args?.feature_context;
const project = args?.project ?? ".";
const contractRef = args?.contract_ref ?? "(the project OpenAPI 3.1 contract + CONTRACT.md invariants)";
const MAX_CYCLES = args?.max_cycles ?? 3;
if (!feature) throw new Error("args.feature_context is required (1-paragraph backend task description)");

// Mirrors Uriah's agent-level finding shape (agents/uriah.md). The loop's
// termination predicate keys off severity === "blocker".
const FINDINGS_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["location", "severity", "rule_violated"],
        properties: {
          location: { type: "string" },
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          rule_violated: { type: "string" },
          suggested_remediation: { type: "string" },
        },
      },
    },
  },
};

const ROUTE_SCHEMA = {
  type: "object",
  required: ["implementer", "scope"],
  properties: {
    implementer: { type: "string", enum: ["hizkiah", "zadok", "shallum", "nathan"] },
    scope: { type: "string" },
    out_of_scope: { type: "array", items: { type: "string" } },
  },
};

// Three ORTHOGONAL QA lenses — distinct agents, distinct evaluation domains.
const QA_LENSES = [
  { key: "contract", agent: "zadok",  prompt: `Contract conformance: does the implementation match ${contractRef}? Check request/response shapes, status codes, error model, and every CONTRACT invariant. A contract deviation is a blocker.` },
  { key: "tests",    agent: "uriah",  prompt: "Test execution & quality: run the test suite (pytest), check business-logic coverage, parameterised-query usage, repository pattern, input validation. A failing test or an untested business rule is a blocker." },
  { key: "data",     agent: "shallum", prompt: "Data-layer safety: parameterised queries (no string-built SQL), migration safety, indexing for the access pattern, transaction boundaries, no data-integrity regressions. An injection vector or unsafe migration is a blocker." },
];

phase("Route");
const route = await agent(
  `You are Zerubbabel, Yasad lead. Route this backend task — pick the owning implementer and state the scope. Do NOT implement. Task: ${feature}. Project: ${project}.`,
  { schema: ROUTE_SCHEMA, agentType: "zerubbabel", label: "route", phase: "Route" },
);
if (!route) throw new Error("Routing failed — Zerubbabel did not return an implementer/scope.");
log(`Routed to ${route.implementer}. Scope: ${route.scope}`);

let cycle = 0;
let outstanding = [];
let consolidated = [];
let lastBuild = null;

while (cycle < MAX_CYCLES) {
  cycle++;

  phase("Build");
  const buildPrompt = cycle === 1
    ? `Implement this backend task. Feature: ${feature}. Scope (from your lead): ${route.scope}. Out of scope: ${JSON.stringify(route.out_of_scope ?? [])}. Project: ${project}. Follow the OpenAPI 3.1 contract and MISHKAN backend rules. Return a concise summary of what you implemented and the files touched.`
    : `Revise your implementation. Feature: ${feature}. QA returned these BLOCKER findings from cycle ${cycle - 1} — fix EVERY one, do not expand scope: ${JSON.stringify(outstanding)}. Return a concise summary of the fixes and files touched.`;
  lastBuild = await agent(buildPrompt, { agentType: route.implementer, label: `build:${cycle}`, phase: "Build" });

  phase("QA");
  const lensResults = await parallel(QA_LENSES.map(L => () =>
    agent(
      `Feature: ${feature}. Project: ${project}. Implementation summary: ${lastBuild}. Your QA lens: ${L.prompt} Return strictly the findings schema; emit a finding if uncertain — this is a gate.`,
      { schema: FINDINGS_SCHEMA, agentType: L.agent, label: `qa:${L.key}:${cycle}`, phase: "QA" },
    ).then(r => ({ lens: L.key, findings: r?.findings ?? [] }))
  ));

  consolidated = lensResults.filter(Boolean).flatMap(r => r.findings.map(f => ({ ...f, lens: r.lens })));
  outstanding = consolidated.filter(f => f.severity === "blocker");
  log(`Cycle ${cycle}/${MAX_CYCLES}: ${consolidated.length} findings, ${outstanding.length} blockers.`);

  if (outstanding.length === 0) break;
}

phase("Settle");
const shipped = outstanding.length === 0;
return {
  feature_context: feature,
  implementer: route.implementer,
  scope: route.scope,
  cycles_run: cycle,
  shipped,
  escalate_to_engineer: !shipped,
  outstanding_blockers: outstanding,
  all_findings: consolidated,
  last_build_summary: lastBuild,
  summary: shipped
    ? `Yasad feature SHIPPED QA-clean after ${cycle} cycle(s). ${consolidated.length} non-blocking findings noted.`
    : `Yasad feature ESCALATED to engineer after ${cycle} cycles — ${outstanding.length} blocker(s) unresolved. Human decision required; do not ship.`,
};
