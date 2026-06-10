// mishmar-security-gate — security gate before merge on sensitive surface.
//
// A diff that touches sensitive surface (auth, payment, PII, secrets, RBAC)
// goes in; three orthogonal security lenses verify in parallel with 3-vote
// refute pattern. Output is pass/block + structured findings.
//
// Pattern: barrier + 3-vote adversarial verify (each finding refuted by 2 of 3).
// ADR D-010 check:
//   - panel orthogonality: Ira (code-level OWASP injection),
//     Joab (surface attack vectors), Hushai (advisor on threat model) —
//     distinct evaluation domains.
//   - synthesis: pass/block decision with finding list.
//
// CONSERVATIVE loop variant (team-lead-craft §6.1): a security block usually
// needs a HUMAN decision, not another agent attempt. So on block this gate runs
// at most ONE remediation-PROPOSAL step (Ira drafts concrete fixes for the
// confirmed blockers — generative advice only) and then ESCALATES to the
// engineer. It deliberately does NOT auto-iterate or re-verify a fix that was
// not actually applied, and it NEVER applies a fix or merges (no stateful op
// inside the gate — asymmetric delegation). The loop touches only the
// generative/review portion.

export const meta = {
  name: "mishmar-security-gate",
  description: "Security gate before merge on sensitive surface — 3 orthogonal lenses + adversarial refute, with a conservative remediation-proposal + escalate on block.",
  whenToUse: "Before merging changes that touch auth, payment, PII, secrets, RBAC, crypto.",
  phases: [{ title: "Find" }, { title: "Refute" }, { title: "Decide" }, { title: "Remediate" }],
};

// The workflow runner may deliver `args` as a JSON string (observed in this
// runtime); normalize to an object so the `args?.x` reads work — and stay robust
// if a caller passes it already-parsed.
if (typeof args === "string") args = JSON.parse(args);

const diffRef = args?.diff_ref;
const surface = args?.surface;
const project = args?.project ?? ".";
if (!diffRef) throw new Error("args.diff_ref is required (PR URL, branch, or diff path)");
if (!surface) throw new Error("args.surface is required (e.g. 'auth' | 'payment' | 'pii' | 'rbac')");

const FINDING_SCHEMA = {
  type: "object", required: ["findings"],
  properties: { findings: { type: "array", items: { type: "object", required: ["title", "severity", "rationale"], properties: { title: {type:"string"}, severity: {type:"string", enum:["info","low","medium","high","critical"]}, file: {type:"string"}, line: {type:"integer"}, rationale: {type:"string"} } } } },
};
const REFUTE_SCHEMA = {
  type: "object", required: ["refuted", "rationale"],
  properties: { refuted: {type:"boolean"}, rationale: {type:"string"} },
};
const REMEDIATION_SCHEMA = {
  type: "object", required: ["remediations"],
  properties: { remediations: { type: "array", items: { type: "object", required: ["finding", "fix"], properties: { finding: {type:"string"}, fix: {type:"string"}, files: {type:"array", items:{type:"string"}} } } } },
};

phase("Find");
const LENSES = [
  { key: "code-owasp", agent: "ira",    prompt: "OWASP Top 10 at the code level: injection, broken auth, broken access, SSRF, deserialization, secrets. Inspect the diff line-by-line." },
  { key: "surface",    agent: "joab",   prompt: "Surface attack vectors: input validation gaps, AuthZ boundary checks, CSRF/CORS, rate limits, error leakage at the endpoint level." },
  { key: "threat",     agent: "hushai", prompt: "Threat model: trust boundary changes, new abuse paths, secrets handling, audit trail completeness, privilege escalation surfaces." },
];

const findings = await parallel(LENSES.map(L => () =>
  agent(
    `Surface: ${surface}. Diff: ${diffRef}. Project: ${project}. Your lens: ${L.prompt} Return the schema. Default to listing findings if uncertain — we tolerate false positives in this gate.`,
    { schema: FINDING_SCHEMA, label: `find:${L.key}`, agentType: L.agent, phase: "Find" },
  ).then(f => ({ lens: L.key, findings: f.findings ?? [] }))
));

const allFindings = findings.filter(Boolean).flatMap(f => f.findings.map(x => ({ ...x, lens: f.lens })));
log(`${allFindings.length} raw findings across 3 lenses.`);

phase("Refute");
const refuters = ["ira", "joab", "hushai"];
const verified = await parallel(allFindings.map(F => () =>
  parallel(refuters.map(r => () =>
    agent(
      `Surface: ${surface}. Finding: "${F.title}" — ${F.rationale}. Try to REFUTE this finding. Default refuted=true if uncertain — we want only confirmed findings to block.`,
      { schema: REFUTE_SCHEMA, label: `refute:${r}:${F.title.slice(0,20)}`, agentType: r, phase: "Refute" },
    )
  )).then(votes => {
    const valid = votes.filter(Boolean);
    const refutedCount = valid.filter(v => v.refuted).length;
    return { finding: F, refuted_votes: refutedCount, confirmed: refutedCount <= 1 };
  })
));

const confirmed = verified.filter(v => v.confirmed).map(v => v.finding);
const blockingSeverities = ["high", "critical"];
const blockers = confirmed.filter(f => blockingSeverities.includes(f.severity));

phase("Decide");
if (blockers.length === 0) {
  return {
    surface,
    diff_ref: diffRef,
    total_findings_raw: allFindings.length,
    confirmed_findings: confirmed,
    blockers,
    decision: "pass",
    escalate_to_engineer: false,
    summary: `Security gate PASS. ${confirmed.length} non-blocking findings (info/low/medium). Merge allowed.`,
  };
}

// Conservative loop: ONE remediation-proposal cycle, then escalate. No re-verify
// of an unapplied fix; no change applied; no merge (asymmetric delegation).
phase("Remediate");
const plan = await agent(
  `You are Ira. For each confirmed BLOCKER on the ${surface} surface, draft a concrete, durable remediation — generative advice ONLY: do NOT apply changes and do NOT merge. Blockers: ${JSON.stringify(blockers)}. Return the schema.`,
  { schema: REMEDIATION_SCHEMA, agentType: "ira", label: "remediate", phase: "Remediate" },
);

return {
  surface,
  diff_ref: diffRef,
  total_findings_raw: allFindings.length,
  confirmed_findings: confirmed,
  blockers,
  decision: "block",
  escalate_to_engineer: true,
  remediation_plan: plan?.remediations ?? [],
  summary: `Security gate BLOCK → ESCALATED to engineer. ${blockers.length} confirmed high/critical finding(s) on ${surface}. Remediation proposed per blocker; the engineer applies the fix and re-runs the gate. No change applied, no merge (asymmetric delegation).`,
};
