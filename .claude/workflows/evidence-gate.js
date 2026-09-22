export const meta = {
  name: 'evidence-gate',
  description:
    'Verify a DECLARED evidence contract against the artifact it claims to cover — one fresh read-only verifier per declared file or command, then exactly one synthesis agent that returns a structured verdict, the per-item command, exit code and observed output, every claim left unverified, and one line naming what the run does NOT prove; read-only, and the only write is the report a writer agent is asked to land.',
  whenToUse:
    'A completion claim has to be checked against evidence a second reader will act on. Pass {contract, cwd?, context?}, where contract declares {files: [{path, mustBeNonEmpty?}], commands: [{run, expectExit?}], claims: []}. Every key arrives FROZEN — no stage re-asks, narrows or widens it and no declared item is dropped. The run answers insufficient rather than an approval whenever a verdict is missing, empty or off-vocabulary, whenever an item could not be executed, and whenever the synthesized block is incomplete; a passing command proves an exit code and never correctness.',
  phases: [
    {
      title: 'Freeze and enumerate the declared items',
      detail:
        'no agent: the script validates the frozen args, expands the contract into one item per declared file and command plus one claim per declared claim, names the report path, and refuses an empty or malformed contract before anything is dispatched',
    },
    {
      title: 'Verify each declared item',
      detail:
        'one fresh read-only verifier per declared file and command item, dispatched together under a fixed ceiling — each runs the literal check itself from cwd and judges only its own item, reporting the exact command, the exit code and the trimmed output, and answering insufficient when it could not execute at all',
    },
    {
      title: 'Synthesize the run verdict',
      detail:
        'exactly one agent sees every item result at once and returns the run verdict from a closed enum, at least one way a passing command could have passed for the wrong reason, one line naming what this run does not prove, and a status for every claim — which stays unverified, because a prose claim is not something a command proves',
    },
    {
      title: 'Enforce the verdict contract',
      detail:
        'no agent: the script turns a missing, empty or off-vocabulary verdict and every unsupported row into a failure, proves each declared item is accounted for exactly once, and accounts every declared claim as unverified unless an item bears on it',
    },
    {
      title: 'Write the full report',
      detail:
        'one writer agent lands the full report at the path the script derives from cwd and reads it back; the script returns the verdict block and that path, never the whole report',
    },
  ],
}

// Objective: generalize ONE procedure extracted from the retired dsh-swarm-orchestrator
// extension — verify a DECLARED EVIDENCE CONTRACT against the artifact it claims to cover,
// and return a structured verdict instead of a prose opinion. The portability rule comes
// first: the workflow VM gives this script no filesystem, shell, network or timers, so
// every mechanical check is performed by a child agent that has tools, and the script only
// coordinates, gates and renders.
// Declared sources (repo-relative): none given — the procedure arrived with the objective,
// and the catalog contract it had to satisfy was read from .claude/workflows/README.md,
// scripts/workflows-meta.test.ts and every .claude/workflows/*.js.
// Caller timestamp: "2026-09-21".
//
// Four hard requirements, each derived from a real failure, are enforced HERE and not only
// asked of an agent — a schema is a request, never a post-condition:
//   1. A missing, empty or off-vocabulary verdict is a FAILURE. The verdict is a closed
//      enum at the schema AND coerced to `insufficient` in the script; there is no path on
//      which a blank or unknown answer becomes an approval.
//   2. `commands` prove an exit code, never correctness. The synthesizer must name at least
//      one way a passing command could have passed for the wrong reason, and an empty answer
//      is a contract violation, not a footnote.
//   3. An item the verifier could not execute is `insufficient` with its reason — never
//      `pass`. Missing rows, unknown statuses and silent verifiers all land there.
//   4. Read-only. No verifier edits any file; the single writer agent writes the report and
//      nothing else.
//
// Five phases, and five only, because every stage of this gate is visible in them: intake and
// enumeration (no agent), verification (one verifier per declared item, capped at
// MAX_VERIFIERS so a large frozen contract cannot spend without limit), synthesis (exactly one
// agent), enforcement (no agent — the script, never a model, decides whether the synthesized
// block is usable), and the single report write.
//
// Declared return shape — small on purpose, the report lives on disk:
//   {ok, verdict, doesNotProve, howAPassingCommandCouldStillBeWrong, cwd, context,
//    items[] (id, kind, declared, status, command, exitCode, observedOutput, reason),
//    claims[] (claim, status, why), claimsUnverified[], contractViolations[], coerced[],
//    rowsRejected[], unknowns[], conflicts[], notConvened[], itemsExpected, itemsPassed,
//    reportPath, reportWritten}
// A normal failure returns {ok: false, error, ...the same trace keys that were reached};
// this script never throws. `ok` is true only when the synthesized verdict is `pass`, every
// dispatched item passed, no contract violation stands and the synthesizer answered — a
// declared claim left unverified does not by itself sink the run, it is reported.

const ITEM_STATUSES = ['pass', 'fail', 'insufficient']
const VERDICTS = ['pass', 'fail', 'insufficient']
// A claim is prose. No command proves one, so `verified` is deliberately absent: the
// strongest thing a run may say about a claim is that some item bears on it.
const CLAIM_STATUSES = ['unverified', 'item-bears-on-claim']
const MAX_OUTPUT = 800
// One verifier per declared item is the shape; an unbounded fan-out is not. This ceiling is
// the only bound on what the run can spend. Items past it are NOT dropped — they are carried
// as insufficient with the reason, because a silently shortened roster would be a hole in the
// very contract this gate exists to check.
const MAX_VERIFIERS = 64

const str = { type: 'string' }
const strList = { type: 'array', items: { type: 'string' } }
const note = (description) => ({ type: 'string', description })
const notes = (description) => ({ type: 'array', items: { type: 'string' }, description })
const enumOf = (values) => ({ type: 'string', enum: values })
const obj = (required, properties) => ({ type: 'object', required, properties })
const listOf = (required, properties) => ({ type: 'array', items: obj(required, properties) })

// `schema` is a request, not a post-condition: a short response degrades, never throws.
const list = (value) => (Array.isArray(value) ? value : [])
const section = (title, items) =>
  items && items.length ? `${title}:\n${items.map((x) => `- ${x}`).join('\n')}` : `${title}: (none given)`

const VERIFY_SCHEMA = obj(['status', 'command', 'exitCode', 'observedOutput', 'reason'], {
  status: enumOf(ITEM_STATUSES),
  command: note('the literal command you ran, verbatim, from the cwd you were given'),
  exitCode: { type: 'integer', description: '-1 when no command could be run at all — then the status is insufficient' },
  observedOutput: note(`the trimmed output, whitespace collapsed, first ${MAX_OUTPUT} characters; say so when you cut it`),
  reason: note('why this status; for insufficient, exactly what stopped you from executing'),
})

const SYNTHESIS_SCHEMA = obj(
  ['verdict', 'doesNotProve', 'howAPassingCommandCouldStillBeWrong', 'items', 'claims', 'unknowns', 'conflicts'],
  {
    verdict: enumOf(VERDICTS),
    doesNotProve: note('ONE line: what this run does NOT prove'),
    howAPassingCommandCouldStillBeWrong: note('at least one concrete way a passing command could have passed for the wrong reason'),
    items: listOf(['id', 'status', 'note'], { id: str, status: enumOf(ITEM_STATUSES), note: str }),
    claims: listOf(['claim', 'status', 'why'], { claim: str, status: enumOf(CLAIM_STATUSES), why: str }),
    unknowns: strList,
    conflicts: strList,
  },
)

const REPORT_SCHEMA = obj(['path', 'bytes', 'written'], {
  path: str,
  bytes: { type: 'integer' },
  written: { type: 'boolean', description: 'true only when you read the path back after writing it' },
})

const READ_ONLY =
  'Read only. You never edit, create, move or delete any file, and you never run a command that changes state: no write, no redirect into a file, no git command that mutates. Run only commands that observe.'
const FROZEN =
  'The contract is FROZEN: no stage re-asks, narrows or widens it, and no declared item is dropped. Judge ONLY the one item you were given — the run verdict is not yours to reach and you have not seen the other items.'
const ITEM_RULE =
  'Capture three things exactly: the command string you ran verbatim, the exit code you observed, and the trimmed output. Do not paraphrase the command and do not extend it. If you cannot execute the check at all — a tool you do not have, a permission you were refused, a path you could not resolve — answer insufficient and name in `reason` exactly what stopped you. An item you did not execute is insufficient whatever it looks like, and insufficient is never a pass.'

// args arrive as an object, or as a JSON-encoded string on some invocation paths.
function normalizeInput(raw) {
  let input = raw
  if (typeof input === 'string') {
    const text = input.trim()
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  }
  if (!input || typeof input !== 'object') return null
  const contract = input.contract
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return null
  const text = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback)
  const cwd = text(input.cwd, '.')
  const context = text(input.context, '')
  const claims = list(contract.claims)
    .map(String)
    .map((claim) => claim.trim())
    .filter(Boolean)
  // Every declared entry becomes a frozen item, in declaration order, files first. An entry
  // that cannot be executed is KEPT and reported as insufficient with its defect: a stage
  // that silently dropped it would be narrowing the contract the caller froze.
  const items = []
  const contractViolations = []
  const coerced = []
  list(contract.files).forEach((entry, i) => {
    const id = `file#${i + 1}`
    const bare = typeof entry === 'string'
    const path = bare ? entry.trim() : entry && typeof entry.path === 'string' ? entry.path.trim() : ''
    const mustBeNonEmpty = !bare && entry && entry.mustBeNonEmpty === true
    if (bare) coerced.push(`${id}: a bare string was read as {path}`)
    if (!path) {
      contractViolations.push(`${id}: a files entry declares no path, so it cannot be checked`)
      items.push({ id, kind: 'file', declared: '(no path declared)', path: '', mustBeNonEmpty, malformed: 'no path declared' })
      return
    }
    items.push({ id, kind: 'file', declared: path, path, mustBeNonEmpty })
  })
  list(contract.commands).forEach((entry, i) => {
    const id = `cmd#${i + 1}`
    const bare = typeof entry === 'string'
    const run = bare ? entry.trim() : entry && typeof entry.run === 'string' ? entry.run.trim() : ''
    const pinned = !bare && entry ? entry.expectExit : undefined
    const expectExit = pinned === undefined || pinned === null ? 0 : pinned
    if (bare) coerced.push(`${id}: a bare string was read as {run}`)
    if (!run) {
      contractViolations.push(`${id}: a commands entry declares no run string, so nothing can be executed`)
      items.push({ id, kind: 'command', declared: '(no run declared)', run: '', expectExit: 0, malformed: 'no run declared' })
      return
    }
    if (!Number.isInteger(expectExit)) {
      contractViolations.push(`${id}: expectExit is not an integer, so the exit code it wants is unusable`)
      items.push({ id, kind: 'command', declared: run, run, expectExit: 0, malformed: 'expectExit is not an integer' })
      return
    }
    items.push({ id, kind: 'command', declared: run, run, expectExit })
  })
  // An empty contract is a caller error: this workflow never invents an item to have
  // something to verify, because a gate that widens its own contract proves nothing.
  if (!items.length && !claims.length) return null
  return { cwd, context, claims, items, contractViolations, coerced }
}

function filePrompt(job, item) {
  const emptiness = item.mustBeNonEmpty
    ? 'It declares mustBeNonEmpty: the check must prove the path exists, is a regular file, and carries at least one byte.'
    : 'It declares no mustBeNonEmpty: the check must prove the path exists as a regular file.'
  return [
    `You are an evidence verifier for ONE item of a frozen evidence contract. Item ${item.id}.`,
    `Working directory: ${job.cwd}`,
    item.mustBeNonEmpty ? `File under check: ${item.path} (non-empty required)` : `File under check: ${item.path}`,
    emptiness,
    `Run the literal read-only check yourself from the working directory above and report the command you ran. Report size or a count — never quote the file's contents, because this is an existence-and-size check, not a content review.`,
    `Judge only this item: pass when the command you ran proves the item holds, fail when it proves the item does not, insufficient when you could not execute the check.`,
    FROZEN,
    ITEM_RULE,
    READ_ONLY,
  ].join('\n\n')
}

function commandPrompt(job, item) {
  return [
    `You are an evidence verifier for ONE item of a frozen evidence contract. Item ${item.id}.`,
    `Working directory: ${job.cwd}`,
    `Run this exact command, verbatim, from the working directory above:`,
    item.run,
    `It is expected to exit ${item.expectExit}.`,
    `Execute it yourself. Do not paraphrase it, extend it, repair it or substitute a command you consider equivalent — if it cannot run as written, that is insufficient, not an invitation to improve it.`,
    `Judge only the exit code: pass means the command ran and exited ${item.expectExit} and nothing more. Whether what the command checks is the right thing to check, or is still true for the reason the caller assumes, is the synthesizer's question and never yours.`,
    FROZEN,
    ITEM_RULE,
    READ_ONLY,
  ].join('\n\n')
}

function synthesisPrompt(job, verified, notConvened) {
  const observed = verified.map((item) =>
    [
      `### ${item.id} — ${item.status}`,
      `declared: ${item.declared}`,
      `command: ${item.command || '(none ran)'}`,
      `exit code: ${item.exitCode}`,
      section('observed output', item.observedOutput ? [item.observedOutput] : []),
      `verifier reason: ${item.reason}`,
    ].join('\n'),
  )
  return [
    'You are the evidence gate synthesizer. Every item result of this run is below, at once. You do not run anything yourself and you do not re-open the artifact: you integrate what the verifiers observed into one verdict.',
    `Working directory of the run: ${job.cwd}`,
    job.context ? `Context the caller supplied (frozen, for reading only):\n${job.context}` : 'The caller supplied no context.',
    section('Frozen contract — claims (prose; no command proves one)', job.claims),
    section('Contract defects found at intake', job.contractViolations),
    `Item results:`,
    observed.join('\n\n') || '(no item was dispatched this run)',
    `Items that did not respond at all: ${notConvened.length ? notConvened.join(', ') : '(none)'}. Never infer what a silent verifier would have found; silence is insufficient, never a pass.`,
    `Return exactly one verdict for the run from the closed set: pass, fail, insufficient. Choose pass only when every dispatched item passed. Choose insufficient — not pass — whenever an item could not be executed, a verifier stayed silent, the contract itself is defective, or the evidence is thinner than the claim it is meant to carry. A missing or off-vocabulary answer is read as insufficient; there is no path here where a blank answer becomes an approval.`,
    `Answer howAPassingCommandCouldStillBeWrong with at least one CONCRETE way a command that exited zero in this run could have passed for the wrong reason — the wrong path was checked, the command tested nothing, the exit code was swallowed by a pipeline, the artifact changed between the run and the read, the thing asserted is not the thing the caller cares about. A command proves an exit code, never correctness, so this line is required and an empty one is a contract violation.`,
    `Answer doesNotProve with ONE explicit line naming what this run does NOT prove.`,
    `Return one rows entry per dispatched item id above, carrying the same status — never a pass for an item whose verifier reported anything else. Add no item id that was not dispatched.`,
    `Return one claims entry per frozen claim: status item-bears-on-claim when a specific item result bears on it, otherwise unverified. Claim statuses carry no "verified" value on purpose: a prose claim is not something this run proves, and saying otherwise would be the fail-open path this gate exists to close.`,
    `Put in unknowns whatever the evidence leaves open and in conflicts every place an item result and the caller's framing disagree. Return the schema object only.`,
  ].join('\n\n')
}

function reportPrompt(job, gate, reportPath) {
  const rows = gate.items.map((item) =>
    [
      `### ${item.id} — ${item.status}`,
      `declared: ${item.declared}`,
      `command: ${item.command || '(none ran)'}`,
      `exit code: ${item.exitCode}`,
      `observed output: ${item.observedOutput || '(none)'}`,
      `reason: ${item.reason}`,
    ].join('\n'),
  )
  return [
    `You are the report writer for one evidence-gate run. Write the full report to ${reportPath} with your own tools — the only file you create — and change nothing else.`,
    `Report body to land, in this order: the verdict line; the doesNotProve line; the howAPassingCommandCouldStillBeWrong line; every item below with its declared target, the exact command, the exit code and the observed output; the claims with their statuses, listing every claim left unverified; the contract defects, coerced entries, rejected rows, unknowns, conflicts and the items that did not respond.`,
    `Read the path back after writing it and report its byte count. Set written true only when the read-back succeeded; if you could not write it, say so with written false and name what stopped you — a report that does not exist must never be reported as landed.`,
    `Verdict: ${gate.verdict}`,
    `Does not prove: ${gate.doesNotProve}`,
    `How a passing command could still be wrong: ${gate.howAPassingCommandCouldStillBeWrong}`,
    `Items:`,
    rows.join('\n\n') || '(none dispatched)',
    section('Claims left unverified', gate.claimsUnverified),
    section('Contract defects found at intake', gate.contractViolations),
    section('Items that did not respond', gate.notConvened),
    READ_ONLY,
  ].join('\n\n')
}

phase('Freeze and enumerate the declared items')
const job = normalizeInput(args)
if (!job) {
  return {
    ok: false,
    error:
      'No evidence contract. Pass {contract, cwd?, context?} where contract declares at least one of files: [{path, mustBeNonEmpty?}], commands: [{run, expectExit?}] or claims: [string].',
  }
}
// The report path is derived, never stamped: the caller may pass any cwd, and this script
// holds no absolute path of its own.
const reportBase = String(job.cwd).replace(/\/+$/, '')
const reportPath = !reportBase || reportBase === '.' ? 'evidence-gate-report.md' : `${reportBase}/evidence-gate-report.md`
log(
  `evidence-gate: ${job.items.length} item(s) and ${job.claims.length} claim(s) declared, frozen; report to ${reportPath}.`,
)
if (job.coerced.length) log(`${job.coerced.length} entry(ies) were read in shorthand: ${job.coerced.join('; ')}.`)
if (job.contractViolations.length)
  log(`${job.contractViolations.length} contract defect(s) at intake: ${job.contractViolations.join('; ')}.`)

const notConvened = []
const runnable = job.items.filter((item) => !item.malformed)
const malformed = job.items.filter((item) => item.malformed)
for (const item of malformed) log(`${item.id} cannot be executed (${item.malformed}); reported as insufficient, never as pass.`)
const dispatched = runnable.slice(0, MAX_VERIFIERS)
const overCeiling = runnable.slice(MAX_VERIFIERS)
if (overCeiling.length)
  log(
    `${overCeiling.length} declared item(s) past the ${MAX_VERIFIERS}-verifier ceiling were not dispatched: ${overCeiling.map((item) => item.id).join(', ')} — carried as insufficient, never as pass.`,
  )

// Barrier: the synthesis stage needs every item result at once — a verdict drawn from a
// partially reported run is the prose opinion this workflow replaces. Dispatch is
// per-item and simultaneous, so a slow verifier delays nothing but the barrier.
phase('Verify each declared item')
const raw = await parallel(
  dispatched.map(
    (item) => () =>
      agent(item.kind === 'file' ? filePrompt(job, item) : commandPrompt(job, item), {
        label: `verify:${item.id}`,
        phase: 'Verify each declared item',
        schema: VERIFY_SCHEMA,
        effort: 'low',
      }),
  ),
)
const verified = dispatched.map((item, i) => {
  const result = raw[i]
  if (!result) {
    notConvened.push(`verify:${item.id}`)
    return { ...item, status: 'insufficient', command: '', exitCode: -1, observedOutput: '', reason: 'the verifier did not respond, so this item was never executed' }
  }
  // Fail closed on the verifier side too: an unknown, empty or missing status is
  // insufficient, because the only alternative reading is a pass nobody observed.
  const status = ITEM_STATUSES.includes(result.status) ? result.status : 'insufficient'
  const reason = String(result.reason || '').trim()
  return {
    ...item,
    status,
    command: String(result.command || '').trim(),
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : -1,
    observedOutput: String(result.observedOutput || '').trim(),
    reason:
      status === result.status
        ? reason || 'the verifier gave no reason'
        : `${reason || 'no reason given'} (the verifier answered ${JSON.stringify(result.status)}, which is not one of ${ITEM_STATUSES.join(', ')}; read as insufficient)`,
  }
})
for (const item of overCeiling)
  verified.push({
    ...item,
    status: 'insufficient',
    command: '',
    exitCode: -1,
    observedOutput: '',
    reason: `the ${MAX_VERIFIERS}-verifier ceiling was reached, so this declared item was never executed`,
  })
for (const item of malformed)
  verified.push({
    ...item,
    status: 'insufficient',
    command: '',
    exitCode: -1,
    observedOutput: '',
    reason: `${item.malformed}, so no check could be executed`,
  })
const ordered = job.items.map((item) => verified.find((entry) => entry.id === item.id)).filter(Boolean)
const passed = ordered.filter((item) => item.status === 'pass').length
log(
  `${dispatched.length - notConvened.length}/${dispatched.length} verifier(s) responded; ${passed}/${ordered.length} item(s) passed.${
    notConvened.length ? ` No response from: ${notConvened.join(', ')} — carried as insufficient.` : ''
  }`,
)

phase('Synthesize the run verdict')
const synthesis = await agent(synthesisPrompt(job, ordered, notConvened), {
  label: 'synthesize:verdict',
  phase: 'Synthesize the run verdict',
  schema: SYNTHESIS_SCHEMA,
  effort: 'high',
})

// From here the script — not an agent — decides whether the synthesized block is usable.
phase('Enforce the verdict contract')
if (!synthesis) {
  notConvened.push('synthesize:verdict')
  return {
    ok: false,
    error: 'The synthesizer returned nothing; there is no verdict to report, so this run approves nothing.',
    verdict: 'insufficient',
    cwd: job.cwd,
    context: job.context,
    items: ordered,
    claims: job.claims.map((claim) => ({ claim, status: 'unverified', why: 'the synthesizer did not respond' })),
    claimsUnverified: job.claims,
    contractViolations: job.contractViolations,
    coerced: job.coerced,
    rowsRejected: [],
    unknowns: [],
    conflicts: [],
    notConvened,
    itemsExpected: ordered.length,
    itemsPassed: passed,
    reportPath,
    reportWritten: false,
  }
}

// The synthesized block is gated here, item by item, because a schema is a request and not
// a post-condition. Everything missing, empty or off-vocabulary fails CLOSED: an unreadable
// answer can only ever cost an approval, never buy one.
const contractViolations = [...job.contractViolations]
const rowsRejected = []
const askedVerdict = typeof synthesis.verdict === 'string' ? synthesis.verdict.trim().toLowerCase() : ''
const verdict = VERDICTS.includes(askedVerdict) ? askedVerdict : 'insufficient'
if (verdict !== askedVerdict)
  contractViolations.push(
    `the synthesized verdict was ${askedVerdict ? `off-vocabulary (${JSON.stringify(synthesis.verdict)})` : 'missing or empty'}; read as insufficient, never as an approval`,
  )
const doesNotProve = String(synthesis.doesNotProve || '').trim()
if (!doesNotProve)
  contractViolations.push('the synthesizer named nothing this run does not prove; the required one-line limit is missing')
const wrongReason = String(synthesis.howAPassingCommandCouldStillBeWrong || '').trim()
if (!wrongReason)
  contractViolations.push(
    'the synthesizer named no way a passing command could have passed for the wrong reason, so no exit code in this run is qualified',
  )
const synthesisRows = new Map()
for (const row of list(synthesis.items)) {
  const id = row && typeof row.id === 'string' ? row.id.trim() : ''
  if (!id || !ordered.some((item) => item.id === id)) {
    rowsRejected.push(`a row naming ${id ? JSON.stringify(id) : 'no id'} matches no dispatched item`)
    continue
  }
  synthesisRows.set(id, row)
}
const items = ordered.map((item) => {
  const row = synthesisRows.get(item.id)
  if (!row) {
    rowsRejected.push(`${item.id}: the synthesizer returned no row for this item`)
    return { ...item, synthesisNote: 'the synthesizer returned no row for this item' }
  }
  if (row.status !== item.status)
    rowsRejected.push(
      `${item.id}: the synthesizer called it ${JSON.stringify(row.status)} where the verifier observed ${item.status}; the observation stands`,
    )
  return { ...item, synthesisNote: String(row.note || '').trim() }
})
// The verdict is gated against the observations, not merely echoed: a synthesizer that
// answers `pass` over an item whose verifier said otherwise is overruled here. Trusting the
// agent for this one step is exactly how a gate learns to approve.
let finalVerdict = verdict
if (finalVerdict === 'pass' && items.some((item) => item.status !== 'pass')) {
  finalVerdict = 'insufficient'
  contractViolations.push(
    'the synthesized verdict was pass while an item did not pass; the observations overrule it and the run answers insufficient',
  )
}
const claims = job.claims.map((claim) => {
  const row = list(synthesis.claims).find((entry) => entry && String(entry.claim || '').trim() === claim)
  if (!row) return { claim, status: 'unverified', why: 'the synthesizer returned no status for this claim' }
  const status = CLAIM_STATUSES.includes(row.status) ? row.status : 'unverified'
  return { claim, status, why: String(row.why || '').trim() }
})
const claimsUnverified = claims.filter((entry) => entry.status !== 'item-bears-on-claim').map((entry) => entry.claim)
if (claimsUnverified.length)
  log(`${claimsUnverified.length}/${claims.length} claim(s) left unverified; a prose claim is not proved by a command.`)
if (rowsRejected.length) log(`${rowsRejected.length} synthesized row(s) rejected: ${rowsRejected.join('; ')}.`)

phase('Write the full report')
const report = await agent(reportPrompt(job, { verdict: finalVerdict, doesNotProve, howAPassingCommandCouldStillBeWrong: wrongReason, items, claimsUnverified, contractViolations, notConvened }, reportPath), {
  label: 'report:write',
  phase: 'Write the full report',
  schema: REPORT_SCHEMA,
  effort: 'low',
})
if (!report) notConvened.push('report:write')
const reportWritten = Boolean(report) && report.written === true
if (!reportWritten) log(`The report was not confirmed at ${reportPath}; the verdict below stands on its own.`)
log(`Verdict: ${finalVerdict} (${passed}/${ordered.length} item(s) passed, ${contractViolations.length} contract violation(s)).`)

return {
  ok: finalVerdict === 'pass' && !contractViolations.length && ordered.every((item) => item.status === 'pass'),
  verdict: finalVerdict,
  doesNotProve: doesNotProve || `this run proved nothing beyond ${ordered.length} declared item(s), and no claim in it is verified`,
  howAPassingCommandCouldStillBeWrong:
    wrongReason || 'the synthesizer named none, so no passing exit code in this run is qualified',
  cwd: job.cwd,
  context: job.context,
  items,
  claims,
  claimsUnverified,
  contractViolations,
  coerced: job.coerced,
  rowsRejected,
  unknowns: list(synthesis.unknowns).map(String),
  conflicts: list(synthesis.conflicts).map(String),
  notConvened,
  itemsExpected: ordered.length,
  itemsPassed: passed,
  reportPath,
  reportWritten,
}
