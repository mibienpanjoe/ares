// migdal-infra-change — infra change validated by 5 orthogonal lenses.
//
// An infra change (Terraform module, Helm chart, K8s manifest, network rule)
// goes in; five lenses verify in parallel: design intent, systems/blast radius,
// devops/rollback path, observability impact, post-change health checks.
// Output is go/no-go with named blockers.
//
// Pattern: barrier `parallel()` per lens + synthesis.
// ADR D-010 check:
//   - panel orthogonality: design / systems / devops / observability / health
//     are distinct domains.
//   - synthesis: structured go/no-go with rollback path attached.

export const meta = {
  name: "migdal-infra-change",
  description: "Infra change validated by 5 orthogonal lenses (design / systems / devops / observability / health).",
  whenToUse: "Before applying any infra change with non-trivial blast radius (network, IAM, scaling, cross-service deps).",
  phases: [{ title: "Review" }, { title: "Decide" }],
};

const changeDescription = args?.change_description;
const changeFiles = args?.change_files ?? [];
const project = args?.project ?? ".";
if (!changeDescription) throw new Error("args.change_description is required");

const VERDICT_SCHEMA = {
  type: "object", required: ["safe", "rationale"],
  properties: { safe: {type:"boolean"}, rationale: {type:"string"}, blockers: {type:"array", items:{type:"string"}}, mitigations: {type:"array", items:{type:"string"}}, rollback_steps: {type:"array", items:{type:"string"}} },
};

phase("Review");
const LENSES = [
  { key: "design",   agent: "meshullam", prompt: "Infrastructure design: does this change cohere with existing infra patterns? Any redesign required upstream?" },
  { key: "systems",  agent: "palal",     prompt: "Systems / blast radius: network impact, OS-level changes, virt layer, dependent services. What goes down if this fails?" },
  { key: "devops",   agent: "meremoth",  prompt: "Devops / pipeline: deployment path, rollback procedure, CI/CD impact, secret rotations needed." },
  { key: "obs",      agent: "hanun",     prompt: "Observability: metrics/logs/traces impact, alert rules to add, dashboards to update, SLO implications." },
  { key: "health",   agent: "rehum",     prompt: "Post-change health: health checks to run after apply, probes to add, smoke tests, expected steady-state metrics." },
];

const verdicts = await parallel(LENSES.map(L => () =>
  agent(
    `Infra change: ${changeDescription}. Files: ${JSON.stringify(changeFiles)}. Project: ${project}. Your lens: ${L.prompt} Default safe=false if uncertain — infra changes are high-stakes.`,
    { schema: VERDICT_SCHEMA, label: `review:${L.key}`, agentType: L.agent, phase: "Review" },
  ).then(v => ({ lens: L.key, ...v }))
));

const valid = verdicts.filter(Boolean);
const safeCount = valid.filter(v => v.safe).length;
const allBlockers = valid.flatMap(v => v.blockers ?? []);
const allMitigations = valid.flatMap(v => v.mitigations ?? []);
const rollback = valid.flatMap(v => v.rollback_steps ?? []);

phase("Decide");
return {
  change: changeDescription,
  change_files: changeFiles,
  lens_verdicts: valid,
  safe_count: safeCount,
  all_safe: safeCount === LENSES.length,
  blockers: allBlockers,
  mitigations: allMitigations,
  rollback_plan: rollback,
  decision: safeCount === LENSES.length ? "go" : "no-go",
  summary: safeCount === LENSES.length
    ? `Infra change GO. ${safeCount}/5 lenses safe. Rollback path: ${rollback.length} steps documented.`
    : `Infra change NO-GO. ${LENSES.length - safeCount}/5 lenses flagged blockers. Address: ${allBlockers.slice(0,3).join(" | ")}`,
};
