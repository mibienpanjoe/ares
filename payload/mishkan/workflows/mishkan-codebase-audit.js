// mishkan-codebase-audit — fan-out + adversarial verify across a codebase.
//
// The MISHKAN-shaped equivalent of the "codebase-wide bug sweep" and
// "security audit" use cases Anthropic documents. Spawns the right
// auditor per file-class in parallel, then 3-vote adversarially verifies
// each finding to drop confident hallucinations before reporting.
//
// Patterns: multi-modal sweep (one auditor lens per file class) +
// fan-out + adversarial verify (2/3-refute kills) + barrier (dedup before
// the verify stage so duplicate findings across auditors merge first).
//
// Args: {
//   project_root: "/path/to/project",
//   lenses: ["security", "bugs", "perf", "a11y", "contract"]  // pick subset
//   target_glob: "src/**/*.{ts,tsx,py,php}"  // optional; default: src/**
//   max_files: 200                            // cap for cost control
// }

export const meta = {
  name: 'mishkan-codebase-audit',
  description: 'Multi-lens sweep across a codebase. Per-file findings from the relevant Mishmar / Yasad / Panim specialists, then 3-vote adversarial verify before surfacing.',
  whenToUse: 'Periodic project-wide audits, pre-release reviews, post-incident hardening passes. Not for routine PR review (use mishkan-release-readiness or Task delegation).',
  phases: [
    { title: 'Discover', detail: 'enumerate files matching target_glob' },
    { title: 'Audit',    detail: 'one auditor per lens, parallel per file' },
    { title: 'Dedup',    detail: 'merge findings hitting the same file:line across lenses' },
    { title: 'Verify',   detail: '3-vote adversarial; 2/3 refute → drop' },
    { title: 'Report',   detail: 'aggregate by severity + anchor' },
  ],
}

if (!args?.project_root || !args?.lenses || args.lenses.length === 0) {
  throw new Error('mishkan-codebase-audit requires args: { project_root, lenses: [...], target_glob?, max_files? }')
}

const MAX_FILES = args.max_files || 200
const GLOB = args.target_glob || 'src/**/*'

// Each lens maps to the right auditor agent and anchor vocabulary.
const LENSES = {
  security: { agent: 'ira',      anchor: 'OWASP / CWE',                craft: 'ira-code-security-craft' },
  bugs:     { agent: 'uriah',    anchor: 'CONTRACT invariants / tests', craft: 'qa-evaluation-craft' },
  perf:     { agent: 'shallum',  anchor: 'EXPLAIN / Core Web Vitals',   craft: 'shallum-database-craft' },
  a11y:     { agent: 'asaph',    anchor: 'WCAG 2.2 SC',                 craft: 'asaph-a11y-seo-craft' },
  contract: { agent: 'zadok',    anchor: 'CONTRACT.md',                 craft: 'zadok-contract-craft' },
  surface:  { agent: 'joab',     anchor: 'OWASP API Top 10',            craft: 'joab-app-security-craft' },
}

const FINDING_SCHEMA = {
  type: 'object',
  required: ['location', 'severity', 'rule_violated', 'remediation', 'lens'],
  properties: {
    location:      { type: 'string', description: 'file:line or file:line-range' },
    severity:      { enum: ['critical', 'high', 'medium', 'low'] },
    rule_violated: { type: 'string' },
    remediation:   { type: 'string' },
    lens:          { type: 'string' },
    confidence:    { enum: ['high', 'medium', 'low'] },
  },
}

const FINDINGS_LIST_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: { type: 'array', items: FINDING_SCHEMA },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
}

// --- Stage 1: Discover -------------------------------------------------
phase('Discover')
const discovery = await agent(
  `List files under ${args.project_root} matching glob ${JSON.stringify(GLOB)}. ` +
  `Return up to ${MAX_FILES} files; if more match, prefer files modified most recently. ` +
  `Output a JSON array of relative paths.`,
  {
    label: 'discover:files',
    phase: 'Discover',
    agentType: 'Explore',
    schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },
  }
)

const files = (discovery?.files || []).slice(0, MAX_FILES)
log(`${files.length} files in scope across ${args.lenses.length} lenses → ${files.length * args.lenses.length} audit calls`)

if (files.length === 0) {
  return { findings: [], stats: { files: 0, lenses: args.lenses }, note: 'no files matched' }
}

// --- Stage 2: Audit ----------------------------------------------------
// Pipeline by file: each file goes through all selected lenses in parallel;
// audits land into the dedup barrier as they arrive.
phase('Audit')
const auditTasks = []
for (const file of files) {
  for (const lensName of args.lenses) {
    const lens = LENSES[lensName]
    if (!lens) continue
    auditTasks.push({ file, lensName, lens })
  }
}

const rawFindings = await parallel(auditTasks.map(({ file, lensName, lens }) => () =>
  agent(
    `Act as ${lens.agent}. Apply ${lens.craft}. Audit ${args.project_root}/${file} for ${lensName} issues. ` +
    `Anchor every finding to ${lens.anchor}. Anchorless findings are not raised. ` +
    `Return a (possibly empty) findings list — empty is a valid outcome.`,
    {
      label: `${lens.agent}:${lensName}:${file.slice(-32)}`,
      phase: 'Audit',
      agentType: lens.agent,
      schema: FINDINGS_LIST_SCHEMA,
    }
  )
))

const allFindings = rawFindings
  .filter(Boolean)
  .flatMap(r => r.findings || [])
  .map((f, i) => ({ ...f, _id: i }))

log(`Audit produced ${allFindings.length} raw findings`)

// --- Stage 3: Dedup ----------------------------------------------------
// Two lenses can flag the same file:line for related reasons. Merge by
// (file:line, anchor) — keep the highest-severity version, append cross-lens
// note.
phase('Dedup')
const key = (f) => `${f.location}::${(f.rule_violated || '').slice(0, 40)}`
const grouped = {}
for (const f of allFindings) {
  const k = key(f)
  if (!grouped[k]) { grouped[k] = { ...f, lenses: [f.lens] }; continue }
  grouped[k].lenses.push(f.lens)
  const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 }
  if (sevOrder[f.severity] < sevOrder[grouped[k].severity]) {
    grouped[k].severity = f.severity
    grouped[k].rule_violated = f.rule_violated
    grouped[k].remediation = f.remediation
  }
}
const deduped = Object.values(grouped)
log(`After dedup: ${deduped.length} unique findings (collapsed ${allFindings.length - deduped.length})`)

// --- Stage 4: Adversarial verify --------------------------------------
// 3 independent skeptics per finding; 2/3 refute → drop.
phase('Verify')
const verified = await parallel(deduped.map((f) => async () => {
  const votes = await parallel([0, 1, 2].map((v) => () => agent(
    `Adversarial verifier ${v + 1}/3. Try to REFUTE this audit finding. Default to refuted=true if uncertain. ` +
    `Read ${args.project_root}/${f.location.split(':')[0]} to confirm. Finding: ${JSON.stringify(f)}. ` +
    `Refute if: (a) the anchor does not actually apply at this location, (b) the failure mode is not concretely ` +
    `describable, or (c) the remediation does not address the named anchor.`,
    { label: `verify:${f.location.slice(-32)}:v${v + 1}`, phase: 'Verify',
      agentType: 'hushai', schema: VERDICT_SCHEMA }
  )))
  const refuted = votes.filter(Boolean).filter(v => v.refuted).length
  return refuted >= 2 ? null : f
}))

const confirmed = verified.filter(Boolean)
const killed = deduped.length - confirmed.length
log(`Verify: ${confirmed.length} confirmed, ${killed} refuted by adversarial vote`)

// --- Stage 5: Report --------------------------------------------------
phase('Report')
const bySeverity = { critical: [], high: [], medium: [], low: [] }
for (const f of confirmed) (bySeverity[f.severity] || bySeverity.low).push(f)

return {
  findings_by_severity: bySeverity,
  totals: {
    files_audited: files.length,
    lenses: args.lenses,
    raw_findings: allFindings.length,
    after_dedup: deduped.length,
    after_verify: confirmed.length,
    refuted_by_verify: killed,
  },
  next_actions: confirmed.filter(f => f.severity === 'critical' || f.severity === 'high'),
}
