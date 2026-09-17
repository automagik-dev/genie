export const meta = {
  name: 'observability-review',
  description:
    'Weekly Claude Code observability review — measure the code-annotator/v1 session annotations in the cc-* Phoenix projects, diagnose the worst sessions, and propose rule changes that cite evidence ids; proposal-only, never edits a file.',
  whenToUse:
    'Once a week, after scripts/observability/backfill.ts --verify and annotate.ts have landed the sessions in Phoenix. Pass {phoenix, rulesPath, projectPrefix?, since?, timestamp?} — phoenix is the Phoenix base URL, rulesPath the rules file the proposals are judged against (resolved by the caller, never home-relative), projectPrefix a cc-* project prefix (default cc-). The workflow reads Phoenix and the rules file, proposes rule changes with evidence ids, and never edits a file or writes to Phoenix; the operator approves and applies every change.',
  phases: [
    {
      title: 'Measure',
      detail:
        'one read-only reader lists the sessions of every cc-* project inside the window with their eight code-annotator/v1 session annotations, and returns totals plus the ten worst sessions by waste_usd',
    },
    {
      title: 'Diagnose',
      detail:
        'one read-only diagnostician opens the worst sessions’ traces in Phoenix and names each finding with the metric it moves, its cause, its confidence and the session, trace and span ids that prove it',
    },
    {
      title: 'Propose',
      detail:
        'one read-only proposer reads the rules file and turns findings into rule proposals that cite evidence ids; the script keeps only proposals whose every id a finding cited',
    },
  ],
}

// Proposal-only. Every agent reads Phoenix (GraphQL and REST GETs) and the rules file, and
// returns JSON; none edits a file, none writes to Phoenix, and this script performs no IO.
// The endpoint, the rules file path and the cc-* project prefix all arrive through args.
// Success returns {ok: true, since, projectPrefix, measured, findings[], proposals[],
// rejectedProposals[], noChange[], notConvened[]}; a failure is {ok: false, error, ...}.

const ANNOTATIONS = [
  'polling_share',
  'tool_error_rate',
  'interrupts',
  'max_context',
  'compactions',
  'rework',
  'waste_usd',
  'total_usd',
]
const ANNOTATOR = 'code-annotator/v1'
const PROJECT_PREFIX = 'cc-'
const DEFAULT_SINCE = 7
const MAX_SINCE = 90
const INTAKE_ERROR =
  'Pass {phoenix, rulesPath, projectPrefix?, since?, timestamp?}: phoenix is an http(s) Phoenix base URL, rulesPath the rules file (resolved by the caller, not home-relative), projectPrefix a cc-* project prefix.'

const PROPOSAL_ONLY =
  'Proposal only. You never edit, create, move or delete any file — not the rules file, not a settings file, not any repository file — and you never write to Phoenix: no POST, no PUT, no PATCH, no DELETE, no annotation upsert. Read, measure and report; the operator approves and applies every rule change.'
const EVIDENCE_RULE =
  'Every claim cites evidence ids exactly as Phoenix returned them: session ids, trace ids or span ids. A claim you cannot tie to an id is not a finding.'

const str = { type: 'string' }
const num = { type: 'number' }
const strings = (description) => ({ type: 'array', items: { type: 'string' }, description })
const obj = (required, properties) => ({ type: 'object', required, properties })

const MEASURE_SCHEMA = obj(['sessions', 'totals', 'topSessions', 'unannotatedSessions'], {
  sessions: num,
  unannotatedSessions: num,
  totals: obj(['totalUsd', 'wasteUsd', 'meanPollingShare', 'meanToolErrorRate', 'sessionsOver500kContext'], {
    totalUsd: num,
    wasteUsd: num,
    meanPollingShare: num,
    meanToolErrorRate: num,
    sessionsOver500kContext: num,
  }),
  topSessions: {
    type: 'array',
    items: obj(['project', 'sessionId', 'scores'], {
      project: str,
      sessionId: str,
      scores: { type: 'object', additionalProperties: { type: 'number' } },
    }),
  },
})

const DIAGNOSE_SCHEMA = obj(['findings'], {
  findings: {
    type: 'array',
    items: obj(['title', 'metric', 'evidenceIds', 'cause', 'confidence'], {
      title: str,
      metric: { type: 'string', enum: ANNOTATIONS },
      evidenceIds: strings('session, trace or span ids exactly as Phoenix returned them'),
      cause: str,
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    }),
  },
})

const PROPOSE_SCHEMA = obj(['proposals', 'noChange'], {
  proposals: {
    type: 'array',
    items: obj(['rule', 'where', 'finding', 'evidenceIds', 'expectedEffect', 'howToMeasure'], {
      rule: str,
      where: {
        type: 'string',
        description: 'the rules file passed as rulesPath | the AGENTS.md of a named repository | a named skill',
      },
      finding: { type: 'string', description: 'the title of the finding this proposal derives from' },
      evidenceIds: strings('ids taken from that finding'),
      expectedEffect: str,
      howToMeasure: { type: 'string', description: 'which annotation moves, in which direction, next week' },
    }),
  },
  noChange: {
    type: 'array',
    items: obj(['rule', 'evidenceIds'], { rule: str, evidenceIds: strings('ids showing the rule is working') }),
  },
})

// ---------- intake ----------
const job = args && typeof args === 'object' ? args : {}
const text = (value) => (typeof value === 'string' ? value.trim() : '')
const phoenix = text(job.phoenix).replace(/\/+$/, '')
const rulesPath = text(job.rulesPath)
const projectPrefix = text(job.projectPrefix) || PROJECT_PREFIX
const sinceValue = Number(job.since ?? DEFAULT_SINCE)
const since = Number.isInteger(sinceValue) && sinceValue > 0 && sinceValue <= MAX_SINCE ? sinceValue : DEFAULT_SINCE
const windowEnd = text(job.timestamp)

if (!/^https?:\/\/[^\s]+$/.test(phoenix)) return { ok: false, error: INTAKE_ERROR }
if (!rulesPath || rulesPath.charAt(0) === '~' || rulesPath.indexOf('$') !== -1) {
  return { ok: false, error: `${INTAKE_ERROR} Got rulesPath ${JSON.stringify(rulesPath)}.` }
}
if (projectPrefix.indexOf(PROJECT_PREFIX) !== 0 || !/^[A-Za-z0-9_.-]+$/.test(projectPrefix)) {
  return { ok: false, error: `projectPrefix must select converter projects (${PROJECT_PREFIX}*): got ${JSON.stringify(projectPrefix)}.` }
}

const windowText = windowEnd
  ? `the ${since} days ending at ${windowEnd}`
  : `the last ${since} days (ask Phoenix for the newest session start and count back from it)`
const notConvened = []

// ---------- Measure ----------
phase('Measure')
const measured = await agent(
  `${PROPOSAL_ONLY}

Measure Claude Code sessions in Phoenix at ${phoenix} (GraphQL at ${phoenix}/graphql, REST GETs under ${phoenix}/v1).
Consider ONLY projects whose name starts with "${projectPrefix}" — the projects scripts/observability/backfill.ts names cc-<repo>.
For every such project, list the sessions that started within ${windowText}, with their session annotations
${ANNOTATIONS.join(', ')} written by identifier ${ANNOTATOR}.
Return: the session count; how many of those sessions carry no ${ANNOTATOR} annotation (unannotatedSessions);
totals (sum of total_usd and waste_usd, mean polling_share, mean tool_error_rate, sessions whose max_context exceeds 500000);
and the 10 worst sessions by waste_usd with their project, session id and every annotation score.`,
  { label: 'measure:annotations', schema: MEASURE_SCHEMA },
)
if (!measured) {
  notConvened.push('measure:annotations')
  return { ok: false, error: 'the Measure agent returned nothing; no finding can be diagnosed', notConvened }
}

// ---------- Diagnose ----------
phase('Diagnose')
const diagnosed = await agent(
  `${PROPOSAL_ONLY}

${EVIDENCE_RULE}

You diagnose Claude Code session friction from these measurements (JSON):
${JSON.stringify(measured)}

For the worst sessions, open their traces in Phoenix at ${phoenix}: REST GET ${phoenix}/v1/projects/<project>/spans?attribute=session.id:<id>,
and span filters on metadata.bash_head, metadata.prompt_kind, metadata.skill, span_kind and status_code.
Stay inside projects whose name starts with "${projectPrefix}".
Name each finding with the annotation it moves (one of ${ANNOTATIONS.join(', ')}), the concrete evidence ids,
the cause, and your confidence.`,
  { label: 'diagnose:sessions', schema: DIAGNOSE_SCHEMA },
)
if (!diagnosed) {
  notConvened.push('diagnose:sessions')
  return { ok: false, error: 'the Diagnose agent returned nothing; no proposal can cite evidence', measured, notConvened }
}
const findings = (diagnosed.findings || []).filter((f) => f && Array.isArray(f.evidenceIds) && f.evidenceIds.length > 0)
const citedIds = new Set(findings.flatMap((f) => f.evidenceIds))

// ---------- Propose ----------
phase('Propose')
const proposed = await agent(
  `${PROPOSAL_ONLY}

${EVIDENCE_RULE}

Given these findings (JSON):
${JSON.stringify(findings)}

and the rules already in force in the rules file at ${rulesPath} (read it; do not change it), propose rule changes for
the operator to approve. Each proposal names the finding it derives from by title, carries the evidence ids of that
finding it relies on, says where the rule belongs (that rules file, the AGENTS.md of a named repository, or a named
skill), the expected effect, and how next week's ${ANNOTATOR} annotations would show it worked. Also list rules the data
says are already working (no change), each with its evidence ids. You only propose rule changes; you never edit files.`,
  { label: 'propose:rules', schema: PROPOSE_SCHEMA },
)
if (!proposed) {
  notConvened.push('propose:rules')
  return { ok: false, error: 'the Propose agent returned nothing', measured, findings, notConvened }
}

// A proposal survives only when it cites at least one id and every id it cites a finding cited.
const proposals = []
const rejectedProposals = []
for (const p of proposed.proposals || []) {
  const ids = p && Array.isArray(p.evidenceIds) ? p.evidenceIds : []
  const uncited = ids.filter((id) => !citedIds.has(id))
  if (ids.length === 0 || uncited.length > 0) {
    rejectedProposals.push({ proposal: p, reason: ids.length === 0 ? 'cites no evidence id' : `cites ids no finding cited: ${uncited.join(', ')}` })
  } else {
    proposals.push(p)
  }
}

log(`observability-review: ${findings.length} finding(s), ${proposals.length} proposal(s), ${rejectedProposals.length} rejected`)

return {
  ok: true,
  since,
  projectPrefix,
  measured,
  findings,
  proposals,
  rejectedProposals,
  noChange: proposed.noChange || [],
  notConvened,
}
