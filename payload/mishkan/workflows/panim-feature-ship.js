// panim-feature-ship — frontend feature shipped through an unskippable QA loop.
//
// A frontend feature/task goes in; Huram routes it to the owning specialist,
// who implements; then a 3-lens orthogonal QA panel evaluates, and the work
// LOOPS back to the implementer until QA returns zero blocker-severity findings
// — or escalates to the engineer at the cycle cap. The deterministic, unskippable
// form of the team-lead-craft §6.1 chain (the model cannot self-grade the loop).
//
// Pattern: route → (implement → QA panel → loop-until-no-blockers) → synthesise.
// Per ADR D-010 anti-pattern check:
//   - skill-in-workflow-clothing: NO — termination predicate (zero blockers) +
//     parallel multi-lens panel × bounded cycles.
//   - workflow-calling-workflow-without-contract: NO — no nesting.
//   - non-orthogonal panel: NO — a11y (Asaph) / design-system fit (Oholiab) /
//     functional+visual QA (Jahaziel) are distinct domains. The panel excludes
//     the implementer so no lens is a self-review.
//   - workflow-as-status-page: NO — produces a QA-clean artifact or a structured
//     escalation.

export const meta = {
  name: "panim-feature-ship",
  description: "Frontend feature run through implement → 3-lens QA panel (a11y / DS-fit / QA) → loop-until-no-blockers (cap 3) → escalate. The unskippable Lead→Specialist→QA chain.",
  whenToUse: "When Panim has a scoped frontend feature that must provably pass QA before it ships — not a design-token rollout (panim-ds-rollout).",
  phases: [{ title: "Route" }, { title: "Build" }, { title: "QA" }, { title: "Settle" }],
};

// The workflow runner may deliver `args` as a JSON string (observed in this
// runtime); normalize to an object so the `args?.x` reads work — and stay robust
// if a caller passes it already-parsed.
if (typeof args === "string") args = JSON.parse(args);

const feature = args?.feature_context;
const project = args?.project ?? ".";
const MAX_CYCLES = args?.max_cycles ?? 3;
if (!feature) throw new Error("args.feature_context is required (1-paragraph frontend task description)");

// Mirrors Jahaziel's agent-level finding shape (agents/jahaziel.md). The loop's
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
    implementer: { type: "string", enum: ["salma", "oholiab"] },
    scope: { type: "string" },
    out_of_scope: { type: "array", items: { type: "string" } },
  },
};

// Orthogonal QA lenses. The panel excludes the implementer at run time so a
// lens is never a self-review (e.g. if Oholiab implements, the DS lens drops).
const ALL_LENSES = [
  { key: "a11y",   agent: "asaph",    prompt: "Accessibility: WCAG 2.2 AA conformance, keyboard flow, focus order, ARIA correctness, contrast ratios. An AA violation is a blocker." },
  { key: "ds-fit", agent: "oholiab",  prompt: "Design-system fit: token/component reuse, no rogue one-off styles, responsive behaviour matches the DS. A divergence from the DS is a blocker." },
  { key: "qa",     agent: "jahaziel", prompt: "Functional + visual QA: states (default/hover/active/disabled/error), breakpoints, edge cases, Core Web Vitals budget, visual regression. A broken state or a CWV-budget breach is a blocker." },
];

phase("Route");
const route = await agent(
  `You are Huram, Panim lead. Route this frontend task — pick the owning implementer and state the scope. Do NOT implement. Task: ${feature}. Project: ${project}.`,
  { schema: ROUTE_SCHEMA, agentType: "huram", label: "route", phase: "Route" },
);
if (!route) throw new Error("Routing failed — Huram did not return an implementer/scope.");

const panel = ALL_LENSES.filter(L => L.agent !== route.implementer);
log(`Routed to ${route.implementer}. QA panel: ${panel.map(L => L.key).join(", ")} (implementer excluded from review).`);

let cycle = 0;
let outstanding = [];
let consolidated = [];
let lastBuild = null;

while (cycle < MAX_CYCLES) {
  cycle++;

  phase("Build");
  const buildPrompt = cycle === 1
    ? `Implement this frontend task. Feature: ${feature}. Scope (from your lead): ${route.scope}. Out of scope: ${JSON.stringify(route.out_of_scope ?? [])}. Project: ${project}. pnpm only; Tailwind; WCAG 2.2 AA; respect the design system. Return a concise summary of what you implemented and the files touched.`
    : `Revise your implementation. Feature: ${feature}. QA returned these BLOCKER findings from cycle ${cycle - 1} — fix EVERY one, do not expand scope: ${JSON.stringify(outstanding)}. Return a concise summary of the fixes and files touched.`;
  lastBuild = await agent(buildPrompt, { agentType: route.implementer, label: `build:${cycle}`, phase: "Build" });

  phase("QA");
  const lensResults = await parallel(panel.map(L => () =>
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
  qa_panel: panel.map(L => L.key),
  cycles_run: cycle,
  shipped,
  escalate_to_engineer: !shipped,
  outstanding_blockers: outstanding,
  all_findings: consolidated,
  last_build_summary: lastBuild,
  summary: shipped
    ? `Panim feature SHIPPED QA-clean after ${cycle} cycle(s). ${consolidated.length} non-blocking findings noted.`
    : `Panim feature ESCALATED to engineer after ${cycle} cycles — ${outstanding.length} blocker(s) unresolved. Human decision required; do not ship.`,
};
