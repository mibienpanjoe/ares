// mishkan-release-readiness — pre-deploy gate as a barrier-parallel.
//
// Spawns all the team-level readiness checks in parallel; aggregates into
// a single go/no-go signal. The Eliashib + Phinehas + Bezalel deploy
// gate, run as a workflow so the readiness picture is built in one shot
// instead of sequential rounds of "ask each team."
//
// Patterns: barrier `parallel()` (all checks must complete before the
// gate decision is meaningful) + structured pass/fail aggregation +
// optional composition with mishkan-codebase-audit for the security
// lens (one level of nesting is allowed).
//
// Args: {
//   project_root: "/path/to/project",
//   release_tag: "v1.4.2",
//   audit_security: true,   // optional; nests mishkan-codebase-audit on the security lens
//   verify_commands: {
//     backend_tests:  "cd api && ./vendor/bin/pest -p",
//     frontend_tests: "cd client && pnpm test --run",
//     build:          "pnpm run build",
//     image_scan:     "trivy image --severity CRITICAL,HIGH <image:tag>",
//   }
// }

export const meta = {
  name: 'mishkan-release-readiness',
  description: 'Pre-deploy readiness gate: backend tests + frontend tests + security scan + dependency vetting + SLO budget + pipeline shape + (optional) codebase audit, all in parallel. Single go/no-go output.',
  whenToUse: 'Before every deploy from staging to production. Composes mishkan-codebase-audit when audit_security=true is passed.',
  phases: [
    { title: 'Parallel checks', detail: 'all readiness lenses run concurrently' },
    { title: 'Aggregate',       detail: 'Eliashib + Phinehas gate decision' },
  ],
}

// The workflow runner may deliver `args` as a JSON string; normalize to an
// object so the `args?.x` reads work — and stay robust if passed already-parsed.
if (typeof args === "string") args = JSON.parse(args);

if (!args?.project_root || !args?.release_tag) {
  throw new Error('mishkan-release-readiness requires: { project_root, release_tag, verify_commands?, audit_security? }')
}

const VC = args.verify_commands || {}

const CHECK_SCHEMA = {
  type: 'object',
  required: ['check', 'passed', 'detail'],
  properties: {
    check:    { type: 'string' },
    passed:   { type: 'boolean' },
    detail:   { type: 'string' },
    severity: { enum: ['blocker', 'major', 'minor', 'info'] },
  },
}

// Build the check fleet. Each entry has its agent, its label, the prompt
// instructing the check, and the schema.
const checks = []

if (VC.backend_tests) {
  checks.push({
    label: 'uriah:backend-tests',
    agent: 'uriah',
    prompt: `Act as Uriah. Run the backend test command at ${args.project_root}: ${VC.backend_tests}. ` +
            `Pass = exit 0 and zero failed tests. Detail names failing tests if any.`,
  })
}
if (VC.frontend_tests) {
  checks.push({
    label: 'jahaziel:frontend-tests',
    agent: 'jahaziel',
    prompt: `Act as Jahaziel. Run the frontend test command at ${args.project_root}: ${VC.frontend_tests}. ` +
            `Pass = exit 0 and zero failed tests.`,
  })
}
if (VC.build) {
  checks.push({
    label: 'meremoth:build',
    agent: 'meremoth',
    prompt: `Act as Meremoth. Run the production build at ${args.project_root}: ${VC.build}. ` +
            `Pass = exit 0 and emitted artefact.`,
  })
}
if (VC.image_scan) {
  checks.push({
    label: 'benaiah:image-scan',
    agent: 'benaiah',
    prompt: `Act as Benaiah. Apply benaiah-devsecops-craft. Run: ${VC.image_scan}. ` +
            `Pass = zero CRITICAL findings; HIGH findings noted but not blocking unless ` +
            `unpatched-with-known-PoC. Anchored to CVE ids in detail.`,
  })
}

// Always-on checks (do not depend on optional commands).
checks.push({
  label: 'ira:secret-scan',
  agent: 'ira',
  prompt: `Act as Ira. Apply ira-code-security-craft. Scan ${args.project_root} for hardcoded secrets ` +
          `staged for the ${args.release_tag} release. Anchor to OWASP A07 / CWE-798. Pass = none found.`,
})

checks.push({
  label: 'benaiah:dep-vetting',
  agent: 'benaiah',
  prompt: `Act as Benaiah. Apply benaiah-devsecops-craft. Confirm every dependency added since the previous ` +
          `release tag has a dependency-vetting log entry. Pass = no un-vetted new dependencies.`,
})

checks.push({
  label: 'rehum:slo-budget',
  agent: 'rehum',
  prompt: `Act as Rehum. Apply rehum-sre-advisor-craft. Report the current error-budget status for each SLO. ` +
          `Pass = no SLO is below 25% remaining budget in the current window.`,
})

checks.push({
  label: 'meremoth:pipeline-shape',
  agent: 'meremoth',
  prompt: `Act as Meremoth. Apply meremoth-devops-craft. Verify the CI pipeline and the remote deploy script ` +
          `for ${args.release_tag} have not diverged silently. Confirm SOPS marshalling is current and the ` +
          `config-drift hash check is in place. Pass = both surfaces aligned.`,
})

phase('Parallel checks')
const results = await parallel(checks.map(({ label, agent: a, prompt }) => () => agent(
  prompt + ` Return { check, passed, detail, severity }.`,
  { label, phase: 'Parallel checks', agentType: a, schema: CHECK_SCHEMA }
)))

// Optional nested workflow: codebase security audit.
let nestedAudit = null
if (args.audit_security) {
  log('audit_security=true → nesting mishkan-codebase-audit on the security lens')
  nestedAudit = await workflow('mishkan-codebase-audit', {
    project_root: args.project_root,
    lenses: ['security'],
    max_files: 100,
  })
}

phase('Aggregate')
const safe = results.filter(Boolean)
const failed = safe.filter(r => r.passed === false)
const blockers = failed.filter(r => r.severity === 'blocker' || !r.severity)
const majors = failed.filter(r => r.severity === 'major')

const nestedBlockers = nestedAudit
  ? (nestedAudit.findings_by_severity?.critical?.length || 0) + (nestedAudit.findings_by_severity?.high?.length || 0)
  : 0

const decision = (blockers.length === 0 && nestedBlockers === 0) ? 'GO' : 'NO-GO'

log(`Release ${args.release_tag} readiness: ${decision}. ${blockers.length} blockers, ${majors.length} majors, ` +
    `${nestedBlockers} critical/high findings from nested audit (if any).`)

return {
  release_tag: args.release_tag,
  decision,
  checks_passed: safe.filter(r => r.passed).map(r => r.check),
  checks_failed: failed,
  blockers,
  majors,
  nested_audit: nestedAudit,
  hand_to: decision === 'NO-GO'
    ? 'Remediate blockers; re-run mishkan-release-readiness. Route majors to the owning Team Lead.'
    : 'Hand to Y4NN for the actual deploy command (asymmetric delegation — workflow does not ssh).',
}
