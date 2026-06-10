// mishkan-standards-rollout — propagate a new standard across the 6 teams.
//
// When y4nn-standards.md gains a new rule (security, infra, doc convention,
// language standard), the rule needs to land in each Team's path-scoped rules
// + each Team Lead needs to verify their team's agents align + Bezalel
// ratifies the final state. Today this is manual and drifts — different
// teams adopt at different velocities and the harness silently diverges.
//
// Pattern: pipeline (propose → translate per team → verify per team → ratify)
// + barrier (all 6 Team Leads must verify before Bezalel can ratify)
// + judge panel (Bezalel + Phinehas + Jehoshaphat ratify).
//
// Per PM+CTO portfolio review (2026-06-07):
//  - Bezalel's #1 pick: rules drift is the highest-cost silent failure
//    mode in MISHKAN. A workflow gate is the only durable fix.
//  - Nehemiah aligned: cross-team coordination of standards is recurrent
//    each time a new rule lands.
//
// Args:
//   { rule_text: "...the new standard text, in prose...",
//     rule_id: "RULE-2026-06-007",
//     scope_hint: "security" | "infra" | "doc" | "code" | "process" }

export const meta = {
  name: "mishkan-standards-rollout",
  description: "Propagate a new standard across the 6 teams with per-team translation, verification, and CTO ratification.",
  whenToUse: "When y4nn-standards.md or a team rule gains a new rule that other teams must adopt. Run BEFORE the rule is considered shipped.",
  phases: [
    { title: "Translate" },
    { title: "Verify" },
    { title: "Ratify" },
  ],
};

// The workflow runner may deliver `args` as a JSON string; normalize to an
// object so the `args?.x` reads work — and stay robust if passed already-parsed.
if (typeof args === "string") args = JSON.parse(args);

const ruleText = args?.rule_text;
const ruleId = args?.rule_id ?? `RULE-${new Date().toISOString().slice(0,10)}`;
const scopeHint = args?.scope_hint ?? "code";
if (!ruleText) throw new Error("args.rule_text is required");

const TEAMS = [
  { name: "Chosheb",  lead: "aholiab",     domain: "Design / UX" },
  { name: "Panim",    lead: "huram",       domain: "Frontend" },
  { name: "Yasad",    lead: "zerubbabel",  domain: "Backend / data" },
  { name: "Mishmar",  lead: "phinehas",    domain: "Security (cross-cutting)" },
  { name: "Migdal",   lead: "eliashib",    domain: "Infrastructure / ops" },
  { name: "Sefer",    lead: "jehoshaphat", domain: "Documentation" },
];

const TRANSLATION_SCHEMA = {
  type: "object",
  required: ["applies", "rule_in_team_voice", "impact"],
  properties: {
    applies: { type: "boolean" },
    rule_in_team_voice: { type: "string" },
    impact: { type: "string", enum: ["none", "small", "medium", "large"] },
    breaking_for: { type: "array", items: { type: "string" } },
    rationale: { type: "string" },
  },
};

const VERIFICATION_SCHEMA = {
  type: "object",
  required: ["aligned", "drift_found"],
  properties: {
    aligned: { type: "boolean" },
    drift_found: { type: "array", items: { type: "string" } },
    remediation_needed: { type: "string" },
  },
};

const RATIFY_SCHEMA = {
  type: "object",
  required: ["ratified", "rationale"],
  properties: {
    ratified: { type: "boolean" },
    rationale: { type: "string" },
    blockers: { type: "array", items: { type: "string" } },
  },
};

phase("Translate");
// Per-team translation. Each Team Lead decides if the rule applies to
// their team and what it means in their team's voice / vocabulary /
// path-scoped rule file.
const translations = await parallel(TEAMS.map(T => () =>
  agent(
    `New ${scopeHint} standard ${ruleId} just landed at the harness level. Verbatim text: """${ruleText}""" In your role as ${T.name} (${T.domain}) team lead, decide: does this apply to YOUR team? If yes, how would you write it in your team's voice for your path-scoped rules file? If no, justify briefly. Return the schema.`,
    { schema: TRANSLATION_SCHEMA, label: `translate:${T.name}`, agentType: T.lead, phase: "Translate" },
  ).then(t => ({ ...T, ...t }))
));

const applies = translations.filter(Boolean).filter(t => t.applies);
log(`Rule ${ruleId} applies to ${applies.length}/${TEAMS.length} teams.`);

if (!applies.length) {
  return {
    rule_id: ruleId,
    decision: "noop",
    summary: "No team's rules need updating for this standard. Y4NN-standards.md amendment alone is sufficient.",
  };
}

phase("Verify");
// Per-team verification: does the team's CURRENT agents/specialists/skills
// already align with this rule, or is there drift to remediate?
const verifications = await parallel(applies.map(T => () =>
  agent(
    `Standard ${ruleId} now applies to your team (${T.name}). Translated form: "${T.rule_in_team_voice}" Check your team's agents, skills, and existing rules for DRIFT — places that already contradict or won't propagate this rule. Return the schema.`,
    { schema: VERIFICATION_SCHEMA, label: `verify:${T.name}`, agentType: T.lead, phase: "Verify" },
  ).then(v => ({ team: T.name, lead: T.lead, ...v }))
));

const drifting = verifications.filter(Boolean).filter(v => !v.aligned || (v.drift_found?.length ?? 0) > 0);
log(`${drifting.length}/${applies.length} applying teams have drift to remediate.`);

phase("Ratify");
// Bezalel (CTO) + Phinehas (security cross-cutting if scope=security) +
// Jehoshaphat (Sefer/doc convention if scope=doc) ratify.
const ratifiers = [
  { role: "bezalel",     focus: "CTO — architecture and standards consistency across the harness" },
];
if (scopeHint === "security") {
  ratifiers.push({ role: "phinehas", focus: "Mishmar lead — cross-cutting security impact" });
}
if (scopeHint === "doc") {
  ratifiers.push({ role: "jehoshaphat", focus: "Sefer lead — documentation convention impact" });
}

const ratifications = await parallel(ratifiers.map(R => () =>
  agent(
    `Standard ${ruleId} rollout review. ${R.focus} ` +
    `Translations: ${JSON.stringify(applies.map(t => ({team: t.name, voice: t.rule_in_team_voice, impact: t.impact})))} ` +
    `Verifications: ${JSON.stringify(verifications.filter(Boolean))} ` +
    `Should this rule ship as-is, or are there blockers? Return the schema.`,
    { schema: RATIFY_SCHEMA, label: `ratify:${R.role}`, agentType: R.role, phase: "Ratify" },
  ).then(r => ({ role: R.role, ...r }))
));

const allRatified = ratifications.filter(Boolean).every(r => r.ratified);
const allBlockers = ratifications.filter(Boolean).flatMap(r => r.blockers ?? []);

return {
  rule_id: ruleId,
  scope_hint: scopeHint,
  applies_to_teams: applies.map(t => t.name),
  drifting_teams: drifting.map(d => d.team),
  ratifications,
  decision: allRatified ? "ship" : "block",
  blockers: allBlockers,
  summary: allRatified
    ? `Rule ${ruleId} ratified by ${ratifications.length} reviewers. Applies to ${applies.length} teams; ${drifting.length} need drift remediation per the verification report.`
    : `Rule ${ruleId} BLOCKED. ${allBlockers.length} blockers across ${ratifications.length} reviewers. Address blockers before re-running.`,
};
