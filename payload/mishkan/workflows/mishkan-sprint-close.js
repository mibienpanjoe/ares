// mishkan-sprint-close — barrier parallel + aggregator
//
// Spawns the six Team Reporters in parallel; Nehemiah aggregates the
// six team-report.json outputs into a single sprint-close summary.
// Used by the main session at /sprint-close.
//
// Pattern: barrier `parallel()` (the aggregator genuinely needs all six
// reports together — partial aggregation hides cross-team handoffs).
//
// Args: { sprint: "S2" }  — required.

export const meta = {
  name: 'mishkan-sprint-close',
  description: 'Run all six Team Reporters in parallel; Nehemiah aggregates into a sprint-close summary.',
  whenToUse: 'At /sprint-close. Not a substitute for normal sprint state — runs once per sprint to assemble the milestone report.',
  phases: [
    { title: 'Reporters', detail: 'six teams emit team-report.json in parallel' },
    { title: 'Aggregate',  detail: 'Nehemiah merges and surfaces cross-team flags' },
  ],
}

if (!args || !args.sprint) {
  throw new Error('mishkan-sprint-close requires args.sprint (e.g. {sprint: "S2"})')
}

const TEAMS = [
  { team: 'panim',   reporter: 'ahikam'   },
  { team: 'chosheb', reporter: 'elasah'   },
  { team: 'yasad',   reporter: 'igal'     },
  { team: 'mishmar', reporter: 'maaseiah' },
  { team: 'migdal',  reporter: 'zaccur'   },
  { team: 'sefer',   reporter: 'huldah'   },
]

const TEAM_REPORT_SCHEMA = {
  type: 'object',
  required: ['team', 'sprint', 'tasks', 'research_logs', 'decisions',
             'findings', 'cross_team_in', 'cross_team_out', 'knowledge_candidates'],
  additionalProperties: false,
  properties: {
    team:   { type: 'string' },
    sprint: { type: 'string', pattern: '^S[0-9]+$' },
    tasks:  {
      type: 'object',
      required: ['done', 'blocked', 'carry_forward'],
      properties: {
        done:          { type: 'array', items: { type: 'string' } },
        blocked:       { type: 'array' },
        carry_forward: { type: 'array', items: { type: 'string' } },
      },
    },
    research_logs:         { type: 'array', items: { type: 'string' } },
    decisions:             { type: 'array' },
    findings:              { type: 'array' },
    cross_team_in:         { type: 'array' },
    cross_team_out:        { type: 'array' },
    knowledge_candidates:  { type: 'array' },
  },
}

phase('Reporters')
const reports = await parallel(TEAMS.map(({ team, reporter }) => () =>
  agent(
    `Act as ${reporter} (${team} Team Reporter). Apply reporter-discipline-craft. ` +
    `Assemble team-report.json for sprint ${args.sprint}, scoped to the ${team} team's silent collection ` +
    `through this sprint. Schema-bound; structured summaries with references, never raw logs. ` +
    `No decisions, no editorial improvements.`,
    {
      label: `${reporter}:${team}`,
      phase: 'Reporters',
      agentType: reporter,
      schema: TEAM_REPORT_SCHEMA,
    }
  )
))

phase('Aggregate')
const valid = reports.filter(Boolean)
const failed = TEAMS.filter((_, i) => reports[i] === null).map(t => t.team)

if (failed.length > 0) {
  log(`Warning: ${failed.length}/${TEAMS.length} reporters failed: ${failed.join(', ')}`)
}

// Aggregate cross-team items both sides; flag mismatches for Nehemiah.
const crossTeam = []
for (const r of valid) {
  for (const out of r.cross_team_out || []) crossTeam.push({ originator: r.team, ...out, direction: 'out' })
  for (const inn of r.cross_team_in  || []) crossTeam.push({ consumer:   r.team, ...inn, direction: 'in'  })
}

const summary = {
  sprint: args.sprint,
  generated_from: TEAMS.map(t => t.team),
  partial: failed.length > 0,
  failed_teams: failed,
  team_reports: Object.fromEntries(valid.map(r => [r.team, r])),
  cross_team_items: crossTeam,
  totals: {
    tasks_done:     valid.reduce((n, r) => n + (r.tasks?.done?.length || 0), 0),
    tasks_blocked:  valid.reduce((n, r) => n + (r.tasks?.blocked?.length || 0), 0),
    findings_open:  valid.reduce((n, r) => n + (r.findings?.length || 0), 0),
    research_logs:  valid.reduce((n, r) => n + (r.research_logs?.length || 0), 0),
    knowledge_candidates_total: valid.reduce((n, r) => n + (r.knowledge_candidates?.length || 0), 0),
  },
}

log(`Sprint ${args.sprint} aggregated: ${summary.totals.tasks_done} done, ` +
    `${summary.totals.tasks_blocked} blocked, ${summary.totals.findings_open} findings open, ` +
    `${summary.totals.knowledge_candidates_total} promotion candidates`)

return summary
