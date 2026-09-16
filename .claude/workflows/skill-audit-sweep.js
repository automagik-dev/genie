export const meta = {
  name: 'skill-audit-sweep',
  description:
    'Sweep the shipped skill catalogue — mechanical signals, a sharded characterization fan-out, and one consolidated keep/improve/update/merge/retire table; assess-only, mutates nothing.',
  whenToUse:
    'The assessment half of a skill audit: judging the shipped catalogue for overlap, staleness, house-size and frontmatter drift across every shipped skill file at once. Pass {focus?, skills?, searchPass?, skillsDir?, shardCount?, quorum?, model?, timestamp?} — every key is optional, and with no skills list the sweep audits whatever the inventory check reports on disk. The search-before-authoring interview and the confirmation before any retirement or merge stay with the caller in the skill-audit front door and arrive frozen through args; the workflow asks nothing, writes nothing, and moves no file.',
  phases: [
    {
      title: 'Signals',
      detail:
        'one read-only agent runs the two repository checks and reads the doctor skills lines, returning a compact summary plus the on-disk inventory — never raw output',
    },
    {
      title: 'Characterize',
      detail:
        'a fixed roster of three or four shards, each reading several whole skill files against the closed category enum, the four mutates values and the forty-to-ninety house range',
    },
    {
      title: 'Verdicts',
      detail:
        'one judge sees every responding shard at once and assigns exactly one verdict per skill, with a single bounded re-state round for any reason that names no defect',
    },
    {
      title: 'Render',
      detail: 'the script draws the verdict table, the signals block, the unjudged list and the non-responder list in JavaScript — no agent, no IO',
    },
  ],
}

// Objective: convert the assess-only half of the skill-audit skill into a saved
// workflow — a sharded fan-out, never one agent per skill. One signals agent runs
// the mechanical checks, three or four characterizer shards each read several whole
// SKILL.md files, and one consolidator judges overlap across every responding shard;
// this script renders the verdict table itself.
// Declared sources (repo-relative): skills/skill-audit/SKILL.md, skills/README.md,
// skills/council/SKILL.md. Caller timestamp: "2026-09-15T23:59:00Z".
// Every path arrives through args and is repository-relative; every read, check and
// command happens inside an agent. The script itself holds no raw output.
//
// Declared success return shape — the front door relays `report` unchanged and lists
// `notConvened` and `unjudged`; the rest is machine-readable trace:
//   {ok: true, report, verdicts[], crossShardOverlap[], signals, characterizations[],
//    shardsResponded, shardsExpected, roster[], rosterSource, rosterDisagreement[],
//    unreadable[], unownedLintFindings[], unjudged[], reasonsRejected[], notConvened[]}
// A failure return is {ok: false, error, ...the same trace keys that were reached}.

const DEFAULT_SKILLS_DIR = 'skills'
const DEFAULT_SHARD_COUNT = 4
const MIN_SHARD_COUNT = 3
const MAX_SHARD_COUNT = 4
const MIN_SKILLS_PER_SHARD = 4
const HOUSE_MIN = 40
const HOUSE_MAX = 90
const REASON_MIN = 24

const VERDICTS = ['Keep', 'Improve', 'Update', 'Merge', 'Retire']
const CATEGORIES = ['lifecycle', 'routing', 'delivery', 'investigation', 'authoring', 'verification', 'integration', 'skill-ops', 'none']
const MUTATES = ['none', 'documents', 'repo', 'external']
const HOUSE_DRIFT = ['under', 'in-range', 'over']
const BARE_REASONS = ['superseded', 'too long']

const LINT_CHECK = 'bun scripts/skills-lint.ts'
const PARITY_CHECK = 'bun scripts/skills-inventory-parity.ts'
const DOCTOR_LINES = 'the skills lines of the genie doctor command'

const str = { type: 'string' }
const bool = { type: 'boolean' }
const int = { type: 'integer' }
const strList = { type: 'array', items: { type: 'string' } }
const note = (description) => ({ type: 'string', description })
const notes = (description) => ({ type: 'array', items: { type: 'string' }, description })
const enumOf = (values) => ({ type: 'string', enum: values })
const obj = (required, properties) => ({ type: 'object', required, properties })
const listOf = (required, properties) => ({ type: 'array', items: obj(required, properties) })

const SIGNALS_SCHEMA = obj(['lint', 'parity', 'doctor', 'inventory', 'summary'], {
  lint: obj(['exitCode', 'findings', 'unattributable'], {
    exitCode: int,
    findings: listOf(['skill', 'rule', 'line', 'message'], { skill: str, rule: str, line: int, message: str }),
    unattributable: notes('findings no skill directory owns'),
  }),
  parity: obj(['exitCode', 'catalogBlockStale', 'missing', 'extra'], {
    exitCode: int,
    catalogBlockStale: bool,
    missing: notes('published names with no directory on disk'),
    extra: notes('directories on disk the packaging does not publish'),
    repo: notes('optional second reading: every skill directory name the parity check itself reads from the tree — reported as a disagreement, never used as the roster'),
  }),
  doctor: obj(['exitCode', 'skillsLines', 'recordedRef', 'stale', 'homes', 'retirementWarnings'], {
    exitCode: int,
    skillsLines: notes('every reported line beginning skills:'),
    recordedRef: note('the recorded release tag, or empty when no install record exists'),
    stale: bool,
    homes: listOf(['agent', 'present', 'total'], { agent: str, present: int, total: int }),
    retirementWarnings: strList,
  }),
  inventory: notes('every skill directory name the inventory check derives from the tree'),
  summary: note('two or three sentences; never the raw output of the three checks'),
})

const CHARACTERIZE_SCHEMA = obj(['skills'], {
  skills: listOf(
    ['skill', 'path', 'purpose', 'category', 'mutates', 'overlapCandidates', 'stalenessSignals', 'lineCount', 'houseSizeDrift', 'frontmatterDrift'],
    {
      skill: note('the directory name'),
      path: str,
      purpose: note('one sentence naming the workflow this entrypoint owns'),
      category: enumOf(CATEGORIES),
      mutates: enumOf(MUTATES),
      overlapCandidates: notes('other skill names this one may duplicate, each naming the overlapping need'),
      stalenessSignals: notes('text the repository has moved past, each quoting a line range'),
      lineCount: int,
      houseSizeDrift: enumOf(HOUSE_DRIFT),
      frontmatterDrift: notes('each deviation from the frontmatter contract'),
    },
  ),
  unread: notes('files in this shard that could not be read — a sibling of skills[], never a field of a record that does not exist'),
})

const VERDICT_SCHEMA = obj(['verdicts', 'crossShardOverlap', 'note'], {
  verdicts: listOf(['skill', 'verdict', 'reason'], {
    skill: str,
    verdict: enumOf(VERDICTS),
    reason: note('self-contained: the defect, the line range, and what covers the same need instead'),
    lineRange: note('the lines the defect lives on'),
    mergeTarget: note('the surviving entrypoint; required whenever the verdict is Merge'),
    carryAcross: note('content a merge must carry into the survivor'),
    section: note('for Improve: the section that has to change'),
    targetSize: note('for Improve: the line count the rewrite should land on'),
  }),
  crossShardOverlap: listOf(['skills', 'claim', 'survivor'], { skills: strList, claim: str, survivor: str }),
  note: note('anything the characterizations could not settle'),
})

const RESTATE_SCHEMA = obj(['reasons'], { reasons: listOf(['skill', 'reason'], { skill: str, reason: str }) })

// `schema` is a request, not a post-condition: a short response degrades, never throws.
const list = (value) => (Array.isArray(value) ? value : [])
const section = (title, items) => (items && items.length ? `${title}:\n${items.map((x) => `- ${x}`).join('\n')}` : `${title}: (none given)`)
const join = (parts) => parts.filter(Boolean).join('\n\n')
const bullets = (items) => items.map((item) => `- ${item}`).join('\n')
const block = (title, value) => `## ${title}\n${JSON.stringify(value, null, 2)}`
const text = (value) => (typeof value === 'string' ? value.trim() : '')
const objectOf = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

// One kebab slug is the only shape that may become a path segment.
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// Paths are stamped into prompts and into the report, so only a path inside the
// repository survives: nothing absolute, nothing home-anchored, no `..` segment. A
// leading `./` and a trailing `/` are normalised away, not rejected.
function repoRelative(value) {
  const cleaned = String(value).trim().replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
  if (!cleaned || cleaned.startsWith('/') || cleaned.startsWith('~')) return ''
  return cleaned.split('/').some((segment) => segment === '..') ? '' : cleaned
}

// A roster entry may arrive as a directory name or as a repo-relative path to the
// skill file; both reduce to the directory name, and anything else is dropped.
function skillNameOf(entry) {
  const cleaned = String(entry).trim().replace(/^(?:\.\/)+/, '').replace(/\/+$/, '').replace(/\/SKILL\.md$/i, '')
  const parts = cleaned.split('/').filter(Boolean)
  const name = parts.length ? parts[parts.length - 1] : ''
  return SKILL_NAME.test(name) ? name : ''
}

const clampInt = (value, low, high, fallback) => (Number.isInteger(value) ? Math.max(low, Math.min(high, value)) : fallback)

// Accept an object or a JSON-encoded string (some invocation paths stringify args);
// a bare string degrades to the focus. Every key is optional, so only a value that is
// neither an object nor a string ends the run here.
function normalizeInput(raw) {
  let input = raw
  if (typeof input === 'string') {
    let parsed = null
    try {
      parsed = JSON.parse(input.trim())
    } catch {
      parsed = null
    }
    input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { focus: input.trim() }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const askedDir = text(input.skillsDir) || DEFAULT_SKILLS_DIR
  const skillsDir = repoRelative(askedDir) || DEFAULT_SKILLS_DIR
  return {
    focus: text(input.focus),
    requested: Array.isArray(input.skills) ? input.skills.map(String) : [],
    searchPass: input.searchPass && typeof input.searchPass === 'object' && !Array.isArray(input.searchPass) ? input.searchPass : null,
    skillsDir,
    droppedSkillsDir: repoRelative(askedDir) ? '' : askedDir,
    shardCount: clampInt(input.shardCount, MIN_SHARD_COUNT, MAX_SHARD_COUNT, DEFAULT_SHARD_COUNT),
    // Held raw: the default depends on the shard count AFTER the roster lowers it.
    quorum: Number.isInteger(input.quorum) ? input.quorum : null,
    model: text(input.model),
    timestamp: text(input.timestamp),
  }
}

// Shared prompt clauses: each contract sentence is written once and reused verbatim.
const READ_ONLY = 'Read only; change nothing. Create no file, edit no file, move no file, and recommend no mutation — this sweep assesses and proposes, and the caller decides.'
const HOUSE_RANGE = `${HOUSE_MIN} to ${HOUSE_MAX} lines is the house range`
const FRONTMATTER_RULE = 'frontmatter carries no key outside name, description, category and mutates, in that order — name and description are required, category and mutates are optional and a skill carrying neither is legal — with name equal to the directory name character for character'
const PRECEDENT = 'The consolidation table in the catalogue README is the precedent: audit lenses collapsed into one review entrypoint, investigation collapsed into one report entrypoint. Prefer the same move, and every retired name keeps a row naming its current route.'
const REASON_RULE = `Every reason is self-contained: name the defect, the line range, and what covers the same need instead. "Superseded" and "too long" are not reasons, and a reason under ${REASON_MIN} characters cannot carry all three.`

const brief = (job) => [
  `Focus: ${job.focus || '(none given — audit the catalogue as it stands)'}`,
  `Skills directory (repo-relative): ${job.skillsDir}`,
  job.timestamp ? `Caller timestamp: ${job.timestamp}` : '',
].filter(Boolean).join('\n')
const head = (role, job) => `You are the ${role} of a skill-catalogue audit sweep.\n${brief(job)}`

const signalsPrompt = (job) =>
  join([
    head('SIGNALS reader', job),
    'Gather the three mechanical readings exactly once each, then return the summary object rather than the raw output.',
    bullets([
      `Run: ${LINT_CHECK}`,
      `Run: ${PARITY_CHECK}`,
      `Then read ${DOCTOR_LINES}, read-only — never with the repair flag — and keep only the lines beginning "skills:".`,
    ]),
    `Report all three exit codes verbatim — lint, parity and doctor — including a non-zero one. Attribute every lint and parity finding to the bare skill directory name — \`review\`, never \`${job.skillsDir}/review/\` and never \`${job.skillsDir}/review/SKILL.md\` — or list it under unattributable[] rather than guessing an owner.`,
    'Return inventory[]: every skill directory name the inventory check derives from the tree. It is the one roster this sweep shards, so a name missing from it is a skill nobody audits.',
    'Optionally return parity.repo[]: every skill directory name the parity check itself reads from the tree, derived from that check\'s own output and never copied from inventory[]. It is reported as a second reading and a name present in only one is reported as a disagreement; it never joins the roster.',
    'When no install record exists the doctor reading is simply absent — return an empty recordedRef and empty homes[] rather than inventing either.',
    `Open no other file and gather nothing else. ${READ_ONLY}`,
  ])

function characterizePrompt(job, shard, findings) {
  return join([
    head(`CHARACTERIZER for shard ${shard.index} of ${shard.total}`, job),
    `Read each of the ${shard.paths.length} skill files below whole, then return one record per skill. You hold one contiguous slice of the catalogue: no other shard slice and no other shard answer is visible to you, so characterise each file on its own terms and leave cross-catalogue uniqueness to the consolidator.`,
    section('Files in this shard', shard.paths),
    `Per skill return: skill (the directory name), path, purpose (one sentence naming the workflow this entrypoint owns), category from the closed enum ${CATEGORIES.join(' | ')} — the frontmatter key is optional, so return category "none" for a skill whose frontmatter carries none rather than inventing a value the catalogue lint rejects; category is a required field of every record, so never omit it and never return an empty string — mutates from ${MUTATES.join(' | ')}, overlapCandidates[] (other skill names this one may duplicate, each naming the overlapping need), stalenessSignals[] (text the repository has moved past), lineCount, houseSizeDrift (${HOUSE_RANGE}: under | in-range | over), and frontmatterDrift[] against the contract that ${FRONTMATTER_RULE}.`,
    'Quote line ranges rather than whole files; a record that pastes the file back is a record nobody can act on. A file you could not read belongs in the top-level unread[] — a sibling of skills[], naming the path — and never in an inferred record.',
    section('Signals findings for the skills in this shard', findings),
    READ_ONLY,
  ])
}

function verdictPrompt(job, responded, absentShards, signals, roster) {
  const absent = absentShards.length ? absentShards.join(', ') : '(none)'
  const blocks = responded.map((entry) => block(`Shard ${entry.index} characterizations (${entry.skills.join(', ')})`, list(entry.response.skills)))
  return join([
    head('CONSOLIDATING JUDGE', job),
    'You are the only cross-shard judge. You did not read the skill files; the characterizations below are your interface, and re-opening the files is outside your brief. Decide which claimed overlaps are real, name the surviving entrypoint for every merge, and assign exactly one verdict per skill you received.',
    ...blocks,
    signals ? block('Signals summary', signals) : 'No signals summary reached this run: judge on the characterizations alone and infer no lint, parity or install state.',
    job.searchPass
      ? `${block('Frozen search pass', job.searchPass)}\nThat record is FROZEN. It is the front door five-step interview, already answered by the caller: never re-ask it, never re-derive it, never re-run it.`
      : 'No search-pass record was frozen into this run; judge the catalogue as it stands and ask the caller nothing.',
    PRECEDENT,
    `Shards that did not respond this run: ${absent}. Never infer the position of a skill you did not receive, and return no verdict row for one.`,
    `Judge each skill holistically against actionability, scope fit, uniqueness and currency, and return exactly one row per skill below, with verdict from ${VERDICTS.join(' | ')}. A Merge row names mergeTarget (the survivor) and carryAcross; an Improve row names section and targetSize. ${REASON_RULE}`,
    `Also return crossShardOverlap[]: each real overlap as {skills[], claim, survivor}. The skills you received, and the only ones to verdict, are: ${roster.join(', ')}.`,
    READ_ONLY,
  ])
}

function restatePrompt(job, rejected, records) {
  return join([
    head('REASON RE-STATER', job),
    'One bounded round. The rows below carry a verdict whose reason names no defect a reader can act on. You see only these rows and their characterizations — never the rest of the catalogue — and you change no verdict: you replace the reason only.',
    block('Rejected rows', rejected.map((entry) => ({ skill: entry.row.skill, verdict: entry.row.verdict, reason: entry.row.reason, defect: entry.defect }))),
    block('Characterizations for those skills', records),
    `${REASON_RULE} Return reasons[] as {skill, reason}, one entry per row above.`,
    READ_ONLY,
  ])
}

function partition(roster, shards) {
  const base = Math.floor(roster.length / shards)
  const extra = roster.length % shards
  const out = []
  let cursor = 0
  for (let i = 0; i < shards; i += 1) {
    const size = base + (i < extra ? 1 : 0)
    out.push({ index: i + 1, total: shards, skills: roster.slice(cursor, cursor + size) })
    cursor += size
  }
  return out.filter((entry) => entry.skills.length)
}

// The signals summary is injected per relevant skill, never whole into every shard.
// Every attributed name is normalised before the lookup: a finding may arrive as a bare
// directory name or path-shaped (`skills/review/`, `skills/review/SKILL.md`), and an
// un-normalised match drops it from every shard silently.
function shardFindings(signals, names) {
  if (!signals) return []
  const owned = new Set(names)
  const out = []
  for (const finding of list(objectOf(signals.lint).findings)) {
    if (finding && owned.has(skillNameOf(finding.skill))) out.push(`lint ${finding.rule || '(rule unnamed)'} at ${finding.skill}:${finding.line} — ${finding.message || '(no message)'}`)
  }
  const parity = objectOf(signals.parity)
  for (const name of list(parity.missing)) if (owned.has(skillNameOf(name))) out.push(`inventory parity: ${name} is published but has no directory on disk`)
  for (const name of list(parity.extra)) if (owned.has(skillNameOf(name))) out.push(`inventory parity: ${name} is on disk but the packaging does not publish it`)
  return out
}

// A lint finding attributed to a name no roster skill owns reaches no shard at all.
// Per-shard filtered injection is the whole reason the Signals stage runs serially, so
// the loss is counted and reported once rather than disappearing.
function unownedLintFindings(signals, rosterNames) {
  if (!signals) return []
  const owned = new Set(rosterNames)
  return list(objectOf(signals.lint).findings)
    .filter((finding) => finding && !owned.has(skillNameOf(finding.skill)))
    .map((finding) => `${text(finding.rule) || '(rule unnamed)'} attributed to ${text(finding.skill) || '(no skill named)'}`)
}

function reasonDefect(row) {
  const reason = text(row.reason)
  if (!reason) return 'the reason is empty'
  if (BARE_REASONS.includes(reason.toLowerCase().replace(/\.+$/, ''))) return `the reason is bare: "${reason}" names no defect`
  if (reason.length < REASON_MIN) return `the reason is ${reason.length} characters, under the ${REASON_MIN} a defect, a line range and a covering route need`
  return ''
}

const mergeDefect = (row) => (row.verdict === 'Merge' && !text(row.mergeTarget) ? 'a Merge verdict that names no surviving entrypoint' : '')

// The source vocabulary spells the fourth verdict `Merge into X`, so a judge answering in
// the catalogue's own words must not be dropped: the target is lifted out of the phrase
// and the verdict reduced to the enum value before the enum test runs.
const MERGE_PHRASE = /^merge(?:\s+into\s+(.+?))?[.\s]*$/i
function normalizeVerdict(row) {
  const raw = text(row.verdict)
  const phrase = raw.match(MERGE_PHRASE)
  if (!phrase) return { verdict: raw, mergeTarget: text(row.mergeTarget) }
  return { verdict: 'Merge', mergeTarget: text(row.mergeTarget) || text(phrase[1] || '').replace(/^`|`$/g, '') }
}

const cell = (value) => String(value === undefined || value === null ? '' : value).replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ').trim()
const verdictCell = (row) => (row.verdict === 'Merge' ? `Merge into ${text(row.mergeTarget) || '(target not named)'}` : row.verdict)

// The Reason cell carries the actionable detail the verdict vocabulary demands: a Merge
// names what the survivor must carry across, an Improve names the section and the size.
function reasonCell(row, defect) {
  const parts = [cell(row.reason)]
  if (row.verdict === 'Merge') parts.push(`carry across: ${cell(row.carryAcross) || '(not named)'}`)
  if (row.verdict === 'Improve') parts.push(`${cell(row.section) || '(section not named)'} → ${cell(row.targetSize) || '(target size not named)'}`)
  if (defect) parts.push(`ROW REJECTED: ${cell(defect)}`)
  return parts.join(' — ')
}

function signalsBlock(signals) {
  if (!signals) return '## Signals\nThe signals reader returned nothing this run. No lint, parity or install state was read, and none was inferred.'
  const lint = objectOf(signals.lint)
  const parity = objectOf(signals.parity)
  const doctor = objectOf(signals.doctor)
  const code = (value) => (Number.isInteger(value) ? String(value) : '(not reported)')
  const named = (title, items) => (items.length ? section(title, items.map(String)) : '')
  const homes = list(doctor.homes)
    .filter((home) => home && typeof home === 'object')
    .map((home) => `${cell(home.agent)}: ${cell(home.present)}/${cell(home.total)}`)
  return join([
    '## Signals',
    bullets([
      `${LINT_CHECK} — exit ${code(lint.exitCode)}, ${list(lint.findings).length} attributed finding(s), ${list(lint.unattributable).length} unattributable`,
      `${PARITY_CHECK} — exit ${code(parity.exitCode)}, catalog block ${parity.catalogBlockStale ? 'STALE' : 'current'}, ${list(parity.missing).length} missing, ${list(parity.extra).length} extra`,
      `doctor skills lines — exit ${code(doctor.exitCode)}, recorded ref ${text(doctor.recordedRef) || 'not recorded'}${doctor.stale ? ' (stale against this binary)' : ''}`,
    ]),
    named('Lint findings no skill directory owns', list(lint.unattributable)),
    named('Inventory parity: published but absent from disk', list(parity.missing)),
    named('Inventory parity: on disk but never published', list(parity.extra)),
    section('Doctor skills lines', list(doctor.skillsLines).map(String)),
    homes.length ? section('Recorded homes', homes) : '',
    named('Retirement warnings', list(doctor.retirementWarnings)),
    text(signals.summary) ? `Summary: ${signals.summary}` : '',
  ])
}

function render(view) {
  const pass = view.job.searchPass || {}
  const disagreement = list(view.rosterDisagreement)
  const header = bullets([
    `Focus: ${view.job.focus || '(none given)'}`,
    `Timestamp: ${view.job.timestamp || '(none supplied — the workflow has no clock)'}`,
    `Search pass: ${text(pass.decision) || 'not frozen into this run'}${text(pass.why) ? ` — ${pass.why}` : ''}`,
    `Roster: ${view.roster.length} skill(s) from ${view.rosterSource}`,
    `Shards: ${view.responded}/${view.expected} responded over ${view.roster.length} skill(s)`,
    disagreement.length
      ? `Second catalogue reading disagrees on ${disagreement.map((entry) => `\`${entry.skill}\` (missing from ${entry.missingFrom})`).join(', ')} — reported only; the roster is the inventory reading.`
      : '',
  ].filter(Boolean))
  const table = view.rows.length
    ? [
        '| Skill | Verdict | Reason | Lines |',
        '|---|---|---|---|',
        ...view.rows.map((row) => `| \`${cell(row.skill)}\` | ${cell(verdictCell(row))} | ${reasonCell(row, view.rejectedNow.get(row.skill))} | ${cell(row.lineRange) || '—'} |`),
      ].join('\n')
    : '(no verdict row survived validation)'
  const overlapLines = view.overlap.map((entry) => `- ${list(entry.skills).join(' + ')} → survivor ${text(entry.survivor) || '(not named)'}: ${text(entry.claim) || '(claim not stated)'}`)
  const unjudgedLines = view.unjudged.map((entry) => `- \`${entry.skill}\` — ${entry.why}`)
  return join([
    '# Skill audit sweep',
    header,
    signalsBlock(view.signals),
    `## Verdicts\n${table}`,
    `## Cross-shard overlap\n${overlapLines.length ? overlapLines.join('\n') : '- (none claimed)'}`,
    `## Unjudged\n${unjudgedLines.length ? unjudgedLines.join('\n') : '- (none — every roster skill carries a verdict)'}`,
    view.unreadable.length ? `## Unreadable\n${bullets(view.unreadable.map((entry) => `\`${entry}\` — a shard reported it could not be read; nothing was inferred for it`))}` : '',
    view.judgeNote ? `## Judge note\n${view.judgeNote}` : '',
    'This sweep created, modified and moved no file. Confirm every retirement and merge with the caller before any file moves.',
    view.notResponded.length ? `_Did not respond this run: ${view.notResponded.join(', ')}. Nothing was inferred for them._` : '_Every agent responded this run._',
  ])
}

const job = normalizeInput(args)
if (!job) return { ok: false, error: 'Pass {focus?, skills?, searchPass?, skillsDir?, shardCount?, quorum?, model?, timestamp?}.' }
const MODEL = job.model
// notConvened carries exactly one kind of entry: an agent that returned null. Every
// other stop is reported through `error`, so the list keeps a single meaning.
const notConvened = []
log(`skill-audit-sweep over ${job.skillsDir}/: ${job.focus ? job.focus.slice(0, 120) : 'no focus given'}`)
if (job.droppedSkillsDir) log(`Skills directory ${job.droppedSkillsDir} does not resolve inside the repository; using ${job.skillsDir}.`)

phase('Signals')
const signals = await agent(signalsPrompt(job), { label: 'signals:catalogue', phase: 'Signals', schema: SIGNALS_SCHEMA, ...(MODEL ? { model: MODEL } : {}), effort: 'low' })
if (!signals) {
  notConvened.push('signals:catalogue')
  log('No response from signals:catalogue; the run continues with empty per-shard findings and nothing is inferred.')
}

// A name is a roster candidate only when it reduces to a skill directory inside the
// repository; the caller list and the inventory reading are validated by this one rule.
function rosterCandidate(entry) {
  const name = skillNameOf(entry)
  const path = name ? `${job.skillsDir}/${name}/SKILL.md` : ''
  return name && repoRelative(path) === path ? name : ''
}

function collectNames(entries, what) {
  const kept = []
  const dropped = []
  for (const entry of entries) {
    const name = rosterCandidate(entry)
    if (name) kept.push(name)
    else dropped.push(String(entry))
  }
  if (dropped.length) log(`Dropped ${dropped.length} ${what} that are not a skill directory name inside the repository: ${dropped.join(', ')}.`)
  return kept
}

// Roster: the caller list when one was passed, otherwise the inventory[] the signals
// reader derived from the tree — and nothing else. parity.repo[] is a second reading of
// the same catalogue and is reported as a disagreement only: pushing its names into the
// roster fabricates audit gaps for directories that may not exist.
const requestedNames = collectNames(job.requested, 'roster entr(ies)')
const inventoryNames = requestedNames.length || !signals ? [] : collectNames(list(signals.inventory), 'inventory name(s)')
const rosterSource = requestedNames.length ? 'args' : 'inventory'
const rosterDisagreement = []
if (!requestedNames.length && signals) {
  const parityRepoNames = list(objectOf(signals.parity).repo).map(rosterCandidate).filter(Boolean)
  if (!parityRepoNames.length) log('The parity reading named no skill directory this run, so the inventory reading stands alone and no second reading cross-checks it.')
  else {
    const inInventory = new Set(inventoryNames)
    const inParity = new Set(parityRepoNames)
    for (const name of new Set(inventoryNames)) if (!inParity.has(name)) rosterDisagreement.push({ skill: name, readIn: 'inventory', missingFrom: 'parity repo listing' })
    for (const name of inParity) if (!inInventory.has(name)) rosterDisagreement.push({ skill: name, readIn: 'parity repo listing', missingFrom: 'inventory' })
    if (rosterDisagreement.length)
      log(`The two catalogue readings disagree on ${rosterDisagreement.length} name(s): ${rosterDisagreement.map((entry) => `${entry.skill} (missing from ${entry.missingFrom})`).join(', ')}. Reported only — the roster is the inventory reading.`)
  }
}

const roster = [...new Set(requestedNames.length ? requestedNames : inventoryNames)].sort()
if (!roster.length) {
  return {
    ok: false,
    error: signals
      ? 'No roster could be assembled: no valid skill was passed and the inventory reading named none, which is a failed reading of the catalogue, not an empty catalogue.'
      : 'No roster could be assembled: no valid skill was passed and the signals reader returned nothing, so the catalogue was never read.',
    notConvened,
    rosterSource,
    rosterDisagreement,
    signals: signals || null,
  }
}

// Fixed roster of shards, never one agent per skill: the shard count is lowered until
// every shard carries at least MIN_SKILLS_PER_SHARD files, and floored at one.
const shardCount = Math.max(1, Math.min(job.shardCount, Math.floor(roster.length / MIN_SKILLS_PER_SHARD)))
if (shardCount < MIN_SHARD_COUNT)
  log(`Fan-out degraded on purpose: ${roster.length} skill(s) cannot fill ${MIN_SHARD_COUNT} shards of at least ${MIN_SKILLS_PER_SHARD}, so the declared three-or-four roster drops to ${shardCount} shard(s).`)
const shards = partition(roster, shardCount).map((entry) => ({
  ...entry,
  total: shardCount,
  paths: entry.skills.map((name) => `${job.skillsDir}/${name}/SKILL.md`),
}))
const shardsExpected = shards.length
// The default quorum is computed from the shard count the roster actually produced, not
// from the intake count: computed earlier it silently becomes all-shards-must-respond.
const quorum = job.quorum === null ? (shardsExpected >= MIN_SHARD_COUNT ? shardsExpected - 1 : shardsExpected) : Math.max(1, Math.min(job.quorum, shardsExpected))
log(`${roster.length} skill(s) partitioned into ${shardsExpected} shard(s): ${shards.map((entry) => `shard-${entry.index} [${entry.skills.join(', ')}]`).join(' | ')}. Quorum: ${quorum}.`)
const unownedFindings = unownedLintFindings(signals, roster)
if (unownedFindings.length) log(`${unownedFindings.length} lint finding(s) name no roster skill and reach no shard: ${unownedFindings.join('; ')}.`)

phase('Characterize')
const rawShards = await parallel(
  shards.map((entry) => () =>
    agent(characterizePrompt(job, entry, shardFindings(signals, entry.skills)), {
      label: `characterize:shard-${entry.index}`,
      phase: 'Characterize',
      schema: CHARACTERIZE_SCHEMA,
      ...(MODEL ? { model: MODEL } : {}),
      effort: 'medium',
    }),
  ),
)
const respondedShards = shards.map((entry, i) => ({ ...entry, response: rawShards[i] })).filter((entry) => entry.response)
const silentShards = shards.filter((_, i) => !rawShards[i])
const absentShards = silentShards.map((entry) => `shard-${entry.index}`)
for (const entry of silentShards) notConvened.push(`characterize:shard-${entry.index}`)
if (absentShards.length) log(`No response from ${absentShards.join(', ')}; their skills are carried as unjudged, never inferred.`)

const rosterSet = new Set(roster)
const characterizations = []
const droppedRecords = []
const unreadable = []
for (const entry of respondedShards) {
  for (const record of list(entry.response.skills)) {
    const name = record && text(record.skill)
    if (name && rosterSet.has(name)) characterizations.push({ ...record, skill: name, shard: `shard-${entry.index}` })
    else droppedRecords.push(name || '(unnamed record)')
  }
  for (const path of list(entry.response.unread)) if (text(path)) unreadable.push(text(path))
}
if (droppedRecords.length) log(`Dropped ${droppedRecords.length} characterization record(s) naming no roster skill: ${droppedRecords.join(', ')}.`)
if (unreadable.length) log(`${unreadable.length} skill file(s) a shard could not read: ${unreadable.join(', ')}. Nothing is inferred for them.`)
const characterized = new Set(characterizations.map((record) => record.skill))
const unreadableSkills = new Set(unreadable.map(skillNameOf).filter(Boolean))
const silentSkills = new Set(silentShards.flatMap((entry) => entry.skills))

function unjudgedList(verdicted) {
  return roster
    .filter((name) => !verdicted.has(name))
    .map((name) => ({
      skill: name,
      why: silentSkills.has(name)
        ? 'shard silent'
        : unreadableSkills.has(name)
          ? 'unreadable'
          : characterized.has(name)
            ? 'not verdicted'
            : 'not characterized',
    }))
}

// Every early return carries the same trace keys the success return declares, so a
// caller reads one shape whether the sweep consolidated or stopped.
const trace = () => ({
  notConvened,
  rosterSource,
  rosterDisagreement,
  shardsResponded: respondedShards.length,
  shardsExpected,
  signals: signals || null,
  characterizations,
  roster,
  unreadable,
  unownedLintFindings: unownedFindings,
  unjudged: unjudgedList(new Set()),
})

if (respondedShards.length < quorum) {
  log(`${respondedShards.length}/${shardsExpected} shards responded, under the quorum of ${quorum}; no partial catalogue verdict is produced.`)
  return {
    ok: false,
    error: `Fewer shards responded (${respondedShards.length}) than the quorum of ${quorum} — the catalogue cannot be consolidated from a partial reading.`,
    ...trace(),
  }
}

phase('Verdicts')
const judged = await agent(verdictPrompt(job, respondedShards, absentShards, signals, respondedShards.flatMap((entry) => entry.skills)), {
  label: 'verdict:consolidate',
  phase: 'Verdicts',
  schema: VERDICT_SCHEMA,
  ...(MODEL ? { model: MODEL } : {}),
  effort: 'high',
})
if (!judged) {
  notConvened.push('verdict:consolidate')
  log('No response from verdict:consolidate; the characterizations return unconsolidated so the fan-out is not wasted.')
  return { ok: false, error: 'The consolidating judge returned nothing; no verdict was assigned and none was inferred.', ...trace() }
}

// One row per skill, first mention wins: a name is consumed the moment a row claims it,
// so a malformed row followed by a well-formed retry is reported, not silently honoured.
const rows = []
const seen = new Set()
const droppedRows = []
for (const row of list(judged.verdicts)) {
  const name = row && text(row.skill)
  if (!name || !rosterSet.has(name)) {
    droppedRows.push(`${name || '(unnamed row)'} — not in the audited roster`)
    continue
  }
  if (seen.has(name)) {
    droppedRows.push(`${name} — a second verdict row for one skill`)
    continue
  }
  seen.add(name)
  const { verdict, mergeTarget } = normalizeVerdict(row)
  if (!VERDICTS.includes(verdict)) droppedRows.push(`${name} — verdict ${verdict || '(empty)'} is outside the closed enum`)
  else if (silentSkills.has(name)) droppedRows.push(`${name} — its shard was silent; never verdicted`)
  else rows.push({ ...row, skill: name, verdict, mergeTarget })
}
if (droppedRows.length) log(`Dropped ${droppedRows.length} verdict row(s): ${droppedRows.join('; ')}.`)

// One bounded re-state round, dispatched only when the mechanical reason gate rejects
// at least one row, and carrying only the rejected rows.
const rejected = rows.map((row) => ({ row, defect: reasonDefect(row) })).filter((entry) => entry.defect)
if (rejected.length) {
  const names = new Set(rejected.map((entry) => entry.row.skill))
  log(`${rejected.length} verdict reason(s) name no defect; one bounded re-state round for ${[...names].join(', ')}.`)
  phase('Verdicts')
  const restated = await agent(restatePrompt(job, rejected, characterizations.filter((record) => names.has(record.skill))), {
    label: 'verdict:restate',
    phase: 'Verdicts',
    schema: RESTATE_SCHEMA,
    ...(MODEL ? { model: MODEL } : {}),
    effort: 'high',
  })
  if (!restated) {
    notConvened.push('verdict:restate')
    log('No response from verdict:restate; the original reasons stand and are reported with their defect named.')
  } else {
    let replaced = 0
    for (const entry of list(restated.reasons)) {
      const name = entry && text(entry.skill)
      const reason = entry && text(entry.reason)
      const target = rows.find((row) => row.skill === name)
      if (!target || !names.has(name) || !reason || reasonDefect({ reason })) continue
      target.reason = reason
      replaced += 1
    }
    log(`Re-state round: ${replaced}/${rejected.length} reason(s) replaced; the rest keep their original verdict and are reported.`)
  }
}

// At most one entry per row: a Merge row missing its survivor is one rejected row, not a
// reason defect and a target defect counted twice.
const reasonsRejected = []
const rejectedNow = new Map()
for (const row of rows) {
  const defects = [reasonDefect(row), mergeDefect(row)].filter(Boolean)
  if (!defects.length) continue
  const defect = defects.join('; ')
  reasonsRejected.push({ skill: row.skill, reason: text(row.reason), defect })
  rejectedNow.set(row.skill, defect)
}
if (reasonsRejected.length) log(`${reasonsRejected.length} verdict row(s) still fail the row gate and are rendered with the defect named.`)

const overlap = list(judged.crossShardOverlap).filter((entry) => entry && typeof entry === 'object')
const unjudged = unjudgedList(new Set(rows.map((row) => row.skill)))
if (unjudged.length) log(`${unjudged.length} roster skill(s) carry no verdict: ${unjudged.map((entry) => `${entry.skill} (${entry.why})`).join(', ')}.`)

phase('Render')
const ordered = roster.map((name) => rows.find((row) => row.skill === name)).filter(Boolean)
const report = render({
  job,
  roster,
  rosterSource,
  rosterDisagreement,
  signals,
  rows: ordered,
  rejectedNow,
  overlap,
  unjudged,
  unreadable,
  notResponded: notConvened,
  responded: respondedShards.length,
  expected: shardsExpected,
  judgeNote: text(judged.note),
})
log(`Verdicts: ${ordered.length} row(s) over ${roster.length} skill(s); ${respondedShards.length}/${shardsExpected} shards responded.`)

return {
  ok: true,
  report,
  verdicts: ordered,
  crossShardOverlap: overlap,
  ...trace(),
  unjudged,
  reasonsRejected,
}
