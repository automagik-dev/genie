export const meta = {
  name: 'workfly',
  description: 'Discover a procedure and build its saved workflow — spec, drafted script, adversarial verification, bounded repair',
  whenToUse:
    'A repeatable procedure (a skill, a runbook, a review ritual) should become a saved workflow in this catalog. Pass {objective, sources?, name?, catalogDir?, model?, maxRepairs?, timestamp?}. The workflow writes and verifies one script file; landing the README row and any skill conversion stays with the caller. A name any workflow or skill already holds is refused, so converting a skill means choosing a free workflow name — the converted skill keeps its own.',
  phases: [
    { title: 'Discover', detail: 'source stages, catalog contract, and token economy — three independent readers' },
    { title: 'Design', detail: 'one designer merges the three readings into a single buildable SPEC' },
    { title: 'Draft', detail: 'one author writes the script file from the SPEC' },
    { title: 'Verify', detail: 'the static contract test plus two refuters — semantics, and fidelity to the source' },
    { title: 'Repair', detail: 'bounded rounds applying the blocking findings to the script, re-verified each round' },
  ],
}

// workfly builds saved workflows. Everything arrives through `args` — objective,
// repo-relative sources, catalog directory, model, repair budget, timestamp — and the
// agents do every read and the single file write. Prompt prose lives in the shared
// clauses below, so the structural half of the file stays the reference shape.

const DEFAULT_CATALOG = '.claude/workflows'
const DEFAULT_MODEL = 'opus'
const DEFAULT_MAX_REPAIRS = 2
const META_TEST = 'scripts/workflows-meta.test.ts'
const SKILLS_DIR = 'skills'
const STAGE_KINDS = ['fan-out', 'sequential', 'verify', 'synthesis', 'user-facing']

const str = { type: 'string' }
const bool = { type: 'boolean' }
const strList = { type: 'array', items: { type: 'string' } }
const note = (description) => ({ type: 'string', description })
const notes = (description) => ({ type: 'array', items: { type: 'string' }, description })
const enumOf = (values) => ({ type: 'string', enum: values })
const obj = (required, properties) => ({ type: 'object', required, properties })
const listOf = (required, properties) => ({ type: 'array', items: obj(required, properties) })

const STAGE_FIELDS = ['name', 'kind', 'inputs', 'outputs', 'parallelizable', 'barrierReason', 'stays_in_front_door', 'successCriteria']
const SOURCE_SCHEMA = obj(['stages', 'contractTests'], {
  contractTests: notes("test files whose assertions pin this source's wording"),
  stages: listOf(STAGE_FIELDS, {
    name: str, kind: enumOf(STAGE_KINDS), inputs: str, outputs: str, parallelizable: bool, successCriteria: strList,
    barrierReason: note('why the stage needs all prior results at once; empty when the stage pipelines'),
    stays_in_front_door: { type: 'boolean', description: 'true when the stage needs the user mid-run, so it belongs to the fronting skill' },
  }),
})
const CONTRACT_SCHEMA = obj(['rules', 'forbidden', 'idioms', 'existingNames', 'frontDoorPattern'], {
  rules: strList, forbidden: strList, idioms: notes('shapes every catalog script already shares'),
  existingNames: notes('workflow AND skill names already taken; an empty list is a failed reading'),
  frontDoorPattern: note('how a skill fronts a workflow, incl. the by-hand fallback and the parity test'),
})
const ECONOMY_SCHEMA = obj(['tiers', 'dynamicFanOut', 'budgetNotes'], {
  budgetNotes: str, dynamicFanOut: obj(['recommended', 'reason'], { recommended: bool, reason: str }),
  tiers: listOf(['stage', 'effort', 'reason', 'keepOutOfOrchestrator'], {
    stage: str, effort: enumOf(['low', 'medium', 'high']), reason: str, keepOutOfOrchestrator: notes('outputs the stage must summarise, never return raw'),
  }),
})
const SPEC_FIELDS = ['name', 'description', 'whenToUse', 'phases', 'argsContract', 'agents', 'returnShape', 'frontDoor', 'parityGuard', 'openQuestions']
const SPEC_SCHEMA = obj(SPEC_FIELDS, {
  description: str, whenToUse: str, returnShape: str, openQuestions: strList,
  name: note('kebab, unique across every existing workflow and skill name'),
  phases: listOf(['title', 'detail'], { title: str, detail: str }),
  argsContract: note('every accepted key, its type, its default, and what is required'),
  agents: listOf(['label', 'phase', 'role', 'effort', 'schemaFields', 'barrier', 'model'], {
    label: str, phase: str, role: str, effort: str, schemaFields: strList,
    barrier: note('why this stage needs a barrier; empty when it pipelines'), model: note('the model to pin, or empty so the agent inherits the session model'),
  }),
  frontDoor: note('markdown the fronting skill needs: invocation, relay, what stays with the user, by-hand fallback'),
  parityGuard: note('what a static test should pin, or the single word none'),
})
const DRAFT_SCHEMA = obj(['path', 'readmeRow', 'frontDoor', 'parityGuard'], {
  path: str, frontDoor: str, parityGuard: str, readmeRow: note('one markdown table row for the catalog README Entries table'),
})
const STATIC_SCHEMA = obj(['pass', 'problems'], { pass: bool, problems: strList })
const REFUTE_SCHEMA = obj(['refuted', 'findings'], {
  refuted: bool,
  findings: listOf(['severity', 'file', 'line', 'claim', 'fix'], { severity: enumOf(['blocking', 'advisory']), file: str, line: { type: 'integer' }, claim: str, fix: str }),
})
const REPAIR_SCHEMA = obj(['applied', 'skipped'], { applied: strList, skipped: strList })

// `schema` is a request, not a post-condition: a short response degrades, never throws.
const list = (value) => (Array.isArray(value) ? value : [])
const section = (title, items) => (items && items.length ? `${title}:\n${items.map((x) => `- ${x}`).join('\n')}` : `${title}: (none given)`)

const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 4).join('-') || 'workflow'
// The only name shape that may reach a path: one kebab slug, no separator, no dot.
const KEBAB_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// Paths are stamped into prompts and into the drafted script's header, so only a path
// inside the repository survives: nothing absolute, nothing home-anchored, no `..`
// segment climbing out of the cwd. A leading `./` and a trailing `/` are normalised
// away, not rejected.
function repoRelative(value) {
  const text = String(value).trim().replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
  if (!text || text.startsWith('/') || text.startsWith('~')) return ''
  return text.split('/').some((segment) => segment === '..') ? '' : text
}

// Accept an object or a JSON-encoded string (some invocation paths stringify args).
function normalizeInput(raw) {
  let input = raw
  if (typeof input === 'string') {
    let parsed = null
    try { parsed = JSON.parse(input.trim()) } catch { parsed = null }
    input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { objective: input.trim() }
  }
  if (!input || typeof input !== 'object') return null
  const text = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback)
  const objective = text(input.objective, '')
  if (!objective) return null
  const requested = text(input.name, '')
  const declared = Array.isArray(input.sources) ? input.sources.map(String) : []
  const askedDir = text(input.catalogDir, DEFAULT_CATALOG)
  const catalogDir = repoRelative(askedDir) || DEFAULT_CATALOG
  const pinnedModel = text(input.model, '')
  return {
    objective, requested, catalogDir, pinnedModel, candidate: slugify(requested || objective),
    sources: declared.map(repoRelative).filter(Boolean), droppedSources: declared.filter((value) => !repoRelative(value)),
    droppedCatalogDir: repoRelative(askedDir) ? '' : askedDir, model: pinnedModel || DEFAULT_MODEL, timestamp: text(input.timestamp, ''),
    maxRepairs: Number.isInteger(input.maxRepairs) && input.maxRepairs >= 0 ? input.maxRepairs : DEFAULT_MAX_REPAIRS,
  }
}

// Shared prompt clauses: each contract sentence is written once and reused verbatim.
const READ_ONLY = 'Read only; change nothing.'
const CHECKABLE = 'each one checkable — "the gate exits zero", never "understanding reached"'
const REFUTE_TAIL = `Return refuted and findings[{severity, file, line, claim, fix}]. Severity is blocking when the script would misbehave or fail the contract, advisory otherwise. Default to refuted true when uncertain — and whenever you refute, name at least one blocking finding carrying the reason, because a bare refutation is reported as one anyway. ${READ_ONLY}`
const BODY_RULES = 'plain JavaScript, bare globals only, every path arriving through args and relative to the repository, no clock and no entropy, no reads or writes in the script itself, .filter(Boolean) on every parallel result, and a log() line naming whatever was dropped. A normal failure returns a plain object; it never throws'
const CATALOG_IDIOMS = 'normalizeInput, section(), reporting what did not respond, meta.phases titles matching the phase() calls, and a schema root whose required is a subset of its properties'
const NAMESPACE_RULE = `every saved workflow name — always list ${DEFAULT_CATALOG} itself, even when the catalog directory above differs — AND every top-level directory name under ${SKILLS_DIR}/, listed from that directory`
const SEMANTIC_CHECKS = [
  `the catalog contract in ${DEFAULT_CATALOG}/README.md and ${META_TEST}`, 'paths: repo-relative and from args only, never stamped into the script',
  'pipeline versus barrier: every parallel() carries a justification the SPEC states, otherwise the stage pipelines',
  'null handling: every agent() result reaches a .filter(Boolean) or an explicit null check, and whatever did not respond is logged and returned rather than averaged in',
  'schema validity: object at the root, properties present, required a subset of properties, enums closed',
  'meta.phases titles equal the phase() titles, every agent carries its effort, and a model appears only where the SPEC pins one',
  'the returned object matches the SPEC returnShape, and a normal failure returns rather than throws',
]
const FIDELITY_CHECKS = [
  'every stage the source marks as not stays_in_front_door is present in the script',
  'no stage the source marks stays_in_front_door is trapped inside the script, where the user cannot reach it',
  'each stage keeps its inputs, its outputs, and its success criteria', "wording a contract test pins is preserved verbatim — read the source's contractTests[] and grep them",
]
const DESIGN_RULES = [
  "name is kebab and appears in none of the contract reader's existingNames",
  'every stage the source marks stays_in_front_door belongs to the fronting skill, so keep it out of the phases; every other stage maps to a phase or to an agent inside one, and phases[].title equals the phase() titles',
  'a stage gets a barrier only when it genuinely needs all prior results at once; otherwise it pipelines and barrier is empty',
  'argsContract names every key, its type, its default, and whether it is required; paths are repo-relative and arrive through args only',
  'frontDoor is the markdown the fronting skill needs: how to invoke, what to relay unchanged, what stays with the user, and the by-hand fallback for a runtime with no workflow surface',
  'parityGuard states what a static test should pin so the skill and the script cannot drift, or the word none', 'openQuestions[] carries what you could not settle; leave it empty only when it truly is',
]

const join = (parts) => parts.filter(Boolean).join('\n\n')
const bullets = (items) => items.map((item) => `- ${item}`).join('\n')
const block = (title, value) => `## ${title}\n${JSON.stringify(value, null, 2)}`
const brief = (job) => [`Objective: ${job.objective}`, section('Declared sources (repo-relative)', job.sources), `Catalog directory: ${job.catalogDir}`].join('\n')
const head = (role, job) => `You are the ${role}.\n${brief(job)}`

const sourcePrompt = (job) => join([head('SOURCE reader', job),
  'Decompose the procedure above into the stages a saved workflow would run. Read every declared source and anything it points at inside this repository. With no source declared, derive the stages from the objective alone and say so in a stage note.',
  `Per stage return: name, kind (${STAGE_KINDS.join(' | ')}), inputs, outputs, parallelizable, barrierReason (why all prior results are needed at once — empty when the stage pipelines), stays_in_front_door (true when the stage needs the user mid-run, so it belongs to the fronting skill and stays outside the workflow), and successCriteria[], ${CHECKABLE}.`,
  `Also return contractTests[]: the test files whose assertions pin this source's wording, found by grepping scripts/*.test.ts for the source name and its distinctive sentences. ${READ_ONLY}`])

// The contract reader always enumerates the real catalog AND the skill namespace: a
// non-default catalogDir adds a directory, it never replaces either namespace.
const contractPrompt = (job) => join([head('CONTRACT reader', job),
  `Establish what a script in this catalog is allowed to be. Read ${DEFAULT_CATALOG}/README.md, ${META_TEST}, every ${DEFAULT_CATALOG}/*.js${job.catalogDir === DEFAULT_CATALOG ? '' : `, and every ${job.catalogDir}/*.js`}.`,
  `Return rules[] (what every script must do) and forbidden[] (every token and construct the static test rejects). Return idioms[] — the shapes the existing scripts share: ${CATALOG_IDIOMS}.`,
  `Return existingNames[], both namespaces in one list, because a runtime resolves both from one invocation list and a collision in either is a defect: ${NAMESPACE_RULE}. An empty list ends the run; it is read as a failed reading, never as "every name is free".`,
  `Return frontDoorPattern: how the council skill fronts council.js — what the skill names, what it relays, what it keeps for a runtime with no workflow surface, and how scripts/council-workflow-parity.test.ts pins that. ${READ_ONLY}`])

const economyPrompt = (job) => join([head('ECONOMY reader', job),
  'Price the procedure above before it is built. Return tiers[]: per stage, the effort (low | medium | high), the reason that tier fits, and keepOutOfOrchestrator[] — outputs large enough that the stage must summarise them rather than return them raw to the orchestrating script. Reserve high for the hardest judge and refute stages; mechanical stages are low.',
  `Return dynamicFanOut {recommended, reason}: whether the stage count should scale with the discovered work or stay a fixed roster. Return budgetNotes: where this workflow would burn tokens for no gain. ${READ_ONLY}`])

function designPrompt(job, source, contract, economy) {
  const model = job.pinnedModel
    ? `every agent carries the model "${job.pinnedModel}" the caller pinned`
    : 'no model was pinned, so every agents[].model is empty and each agent inherits the session model'
  return join([`${head('DESIGNER', job)}\nCandidate name: ${job.candidate} ${job.requested ? '(requested by the caller — keep it unless it collides)' : '(derived from the objective)'}.`,
    'Merge the three readings below into one buildable SPEC for a saved workflow.',
    block('Source stages', source), block('Catalog contract', contract), block('Token economy', economy),
    `Rules for the SPEC:\n${bullets([...DESIGN_RULES, `every agent carries an explicit effort taken from the economy reading, and ${model}`])}`])
}

function draftPrompt(job, spec, contract, name, target) {
  const stamp = job.timestamp ? `"${job.timestamp}"` : '(omit the timestamp line — none was supplied)'
  return join([`${head('AUTHOR', job)}\nWrite the saved workflow script at ${target} from the SPEC below. Write that one file, and nothing else.`,
    block('SPEC', spec), block('Catalog contract', contract),
    `Open ${job.catalogDir}/council.js and ${job.catalogDir}/pm-ledger-verify.js first and match their shape. The file starts with a pure-literal export const meta = {name, description, whenToUse, phases} whose name is "${name}", followed by a header comment naming the objective and the declared sources stated above, and the timestamp ${stamp}.`,
    `Then the body: ${BODY_RULES}. Where the SPEC leaves an agent's model empty, omit the model option entirely so the agent inherits the session model; pass a model only where the SPEC pins one.`,
    `Verify your own file before returning: it must satisfy ${META_TEST}. Return path (${target}), readmeRow (ONE markdown table row for the catalog README Entries table, in the shape the existing rows use), frontDoor (the markdown the fronting skill needs), and parityGuard (what a static test should pin, or none).`])
}

// The gate is grounded in what bun test actually emits — an exit code and a summary
// line. It names failing cases only, so a per-case pass line does not exist at all.
const staticPrompt = (path) => join([`Run: bun test ${META_TEST}`,
  `Return pass true ONLY when that command exits zero AND its summary reports \`0 fail\` AND ${path} sits inside ${DEFAULT_CATALOG}. Never look for a per-case pass line and never read its absence as a failure: bun test names failing cases only. The suite enumerates ${DEFAULT_CATALOG}/*.js, so a drafted file outside that directory is never opened at all — that is pass false, with the fact quoted in problems[].`,
  `Every failing assertion is one more problems[] entry, quoted from the output, and so is the summary line whenever it reports any failure. Run the test; do not reason about it. ${READ_ONLY}`])

const semanticsPrompt = (job, spec, path) => join([`${head('REFUTER', job)}\nRead ${path} and try to prove it wrong. Style is not your subject.`,
  `Report everything that fails:\n${bullets(SEMANTIC_CHECKS)}`, block('SPEC', spec), REFUTE_TAIL])

const fidelityPrompt = (job, source, path) => join([`${head('FIDELITY REFUTER', job)}\nRead ${path} and compare it against the procedure it claims to encode.`,
  block('Source stages', source), `Report everything that fails:\n${bullets(FIDELITY_CHECKS)}`, REFUTE_TAIL])

const repairPrompt = (path, blocking) => join([`You are the REPAIRER. Apply the blocking findings below to ${path}. Edit that one file and nothing else: no README row, no skill, no test, no other script.`,
  section('Blocking findings', blocking.map((f) => `${f.file}:${f.line} — ${f.claim} → fix: ${f.fix}`)),
  'Preserve everything the findings do not name. Return applied[] (one line per finding you fixed) and skipped[] (one line per finding you deliberately left standing, with the reason).'])

const job = normalizeInput(args)
if (!job) return { ok: false, error: 'No objective. Pass {objective, sources?, name?, catalogDir?, model?, maxRepairs?, timestamp?}.' }
const MODEL = job.model
// notConvened carries exactly one kind of entry: an agent that returned null. Every
// other condition is reported through `error`, so the list keeps a single meaning.
const notConvened = []
log(`workfly: ${job.objective.slice(0, 120)}${job.objective.length > 120 ? '…' : ''}`)
if (job.droppedSources.length) log(`Dropped ${job.droppedSources.length} source path(s) that were not repo-relative: ${job.droppedSources.join(', ')}.`)
if (job.droppedCatalogDir) log(`Catalog directory ${job.droppedCatalogDir} is not repo-relative; using ${job.catalogDir}.`)

// Barrier: the designer needs all three readings at once; no source or contract, no run.
phase('Discover')
const READERS = ['source', 'contract', 'economy']
const discovery = await parallel([
  () => agent(sourcePrompt(job), { label: 'discover:source', phase: 'Discover', schema: SOURCE_SCHEMA, model: MODEL, effort: 'high' }),
  () => agent(contractPrompt(job), { label: 'discover:contract', phase: 'Discover', schema: CONTRACT_SCHEMA, model: MODEL, effort: 'medium' }),
  () => agent(economyPrompt(job), { label: 'discover:economy', phase: 'Discover', schema: ECONOMY_SCHEMA, model: MODEL, effort: 'medium' }),
])
const [source, contract, economy] = discovery
const absentReaders = READERS.filter((_, i) => !discovery[i])
for (const key of absentReaders) notConvened.push(`discover:${key}`)
log(`${discovery.filter(Boolean).length}/${READERS.length} readers responded.${absentReaders.length ? ` No response from: ${absentReaders.join(', ')}; nothing was inferred for them.` : ''}`)
if (!source || !contract) return { ok: false, error: 'The source and the contract readings are both required before a workflow can be designed.', notConvened }

phase('Design')
const pricing = economy || { tiers: [], dynamicFanOut: { recommended: false, reason: 'the economy reader did not respond' }, budgetNotes: '' }
const spec = await agent(designPrompt(job, source, contract, pricing), { label: 'design:spec', phase: 'Design', schema: SPEC_SCHEMA, model: MODEL, effort: 'high' })
if (!spec) return { ok: false, error: 'The designer returned nothing; there is no SPEC to build from.', notConvened }
const name = typeof spec.name === 'string' ? spec.name.trim() : ''
if (!name) return { ok: false, error: 'The designer returned a SPEC with no name; there is nothing to build.', spec, notConvened }
// The name becomes a path segment, so it is checked before it is ever joined: a
// designer-returned name is untrusted input, and one carrying a separator, a dot or a
// `..` would place the drafted file wherever it liked.
if (!KEBAB_NAME.test(name)) return { ok: false, error: `The designer returned the name ${name}, which is not a single kebab slug; nothing was drafted.`, spec, notConvened }
// An empty existingNames[] is a failed reading, never evidence the name is free. The
// reader did answer, so this is an `error`, never a notConvened entry.
const taken = list(contract.existingNames).map((n) => String(n).toLowerCase())
if (!taken.length) {
  log('The contract reader named no existing workflow or skill names, so no name can be checked for a collision.')
  return { ok: false, error: `No existing names were reported, so ${name} could not be checked for a collision; nothing was drafted.`, spec, notConvened }
}
if (taken.includes(name.toLowerCase())) return { ok: false, error: `The name ${name} is already taken by a workflow or a skill; pass a free name (converting a skill keeps that skill's name for the skill).`, spec, notConvened }
if (job.requested && name !== job.candidate) log(`The designer renamed ${job.requested} to ${name}; the drafted script and every prompt use ${name}.`)
log(`SPEC ${name}: ${list(spec.phases).map((p) => (p && p.title) || '(untitled)').join(' → ')}`)
const openQuestions = list(spec.openQuestions)
if (openQuestions.length) log(`${openQuestions.length} open question(s) carried into the draft.`)

// The verified path is the checked one; a path the author reports is logged, not adopted.
const scriptPath = `${job.catalogDir}/${name}.js`
// Belt and braces: catalogDir was normalised at intake and the name is a kebab slug, so
// the join must survive the same predicate unchanged. Anything else escapes the repo.
if (repoRelative(scriptPath) !== scriptPath) return { ok: false, error: `The script path ${scriptPath} does not resolve inside the repository; nothing was drafted.`, name, path: scriptPath, spec, notConvened }

phase('Draft')
const draft = await agent(draftPrompt(job, spec, contract, name, scriptPath), { label: 'draft:script', phase: 'Draft', schema: DRAFT_SCHEMA, model: MODEL, effort: 'high' })
if (!draft) return { ok: false, error: `The author returned nothing; check ${scriptPath} for a partial write before re-running.`, name, path: scriptPath, spec, notConvened }
if (draft.path && draft.path !== scriptPath) log(`The author reported ${draft.path}; verification stays on ${scriptPath}, the name that was checked.`)

// A non-default catalogDir is appended to the static problems by this script and forces
// pass false, but is never a repair target: no edit to the drafted file brings it into
// the suite. The lens is never asked to echo it, so nothing depends on it matching.
const coverageNote = job.catalogDir === DEFAULT_CATALOG ? '' : `catalogDir ${job.catalogDir} is outside ${DEFAULT_CATALOG}; ${META_TEST} enumerates ${DEFAULT_CATALOG} only, so it never opened ${scriptPath}.`
if (coverageNote) log(coverageNote)

// A refuter standing on refuted:true while naming nothing blocking would otherwise give
// ok:false with no finding, no error, and a repair loop that can never start.
function standingRefusal(key, result) {
  if (!result || result.refuted !== true || list(result.findings).some((f) => f && f.severity === 'blocking')) return []
  return [{ severity: 'blocking', file: scriptPath, line: 0, claim: `the ${key} refuter returned refuted:true without naming a blocking finding`,
    fix: `re-read ${scriptPath} against the ${key} brief, then name the defect or withdraw the refutation` }]
}

// One verify pass, reused by every repair round. Barrier: the repair decision needs
// all three verdicts together, and a round that fixes nothing must not start.
async function verify(round) {
  const results = await parallel([
    () => agent(staticPrompt(scriptPath), { label: `verify:static#${round}`, phase: 'Verify', schema: STATIC_SCHEMA, model: MODEL, effort: 'low' }),
    () => agent(semanticsPrompt(job, spec, scriptPath), { label: `verify:semantics#${round}`, phase: 'Verify', schema: REFUTE_SCHEMA, model: MODEL, effort: 'high' }),
    () => agent(fidelityPrompt(job, source, scriptPath), { label: `verify:fidelity#${round}`, phase: 'Verify', schema: REFUTE_SCHEMA, model: MODEL, effort: 'high' }),
  ])
  const absent = ['static', 'semantics', 'fidelity'].filter((_, i) => !results[i])
  for (const key of absent) notConvened.push(`verify:${key}#${round}`)
  if (absent.length) log(`Round ${round}: no response from ${absent.join(', ')} — counted as unverified, never as pass.`)
  const [staticResult, semantics, fidelity] = results
  const ran = { static: Boolean(staticResult), semantics: Boolean(semantics), fidelity: Boolean(fidelity) }
  // A lens that did not run reports nothing: dispatching the repairer at a test that
  // never ran spends a round on a transport fault. `ran` and notConvened carry it.
  const staticReport = staticResult || { pass: false, problems: [], note: 'did not respond' }
  // Everything the lens reports is repairable by construction: the coverage gap is the
  // script's own note, appended below and never asked of the lens.
  const reported = ran.static ? list(staticReport.problems).map(String) : []
  const unexplained = ran.static && staticReport.pass !== true && !reported.length && !coverageNote
  const claims = unexplained ? ['the static contract test did not pass'] : reported

  const staticFindings = claims.map((claim) => ({ severity: 'blocking', file: scriptPath, line: 0, claim, fix: `satisfy ${META_TEST}` }))
  const refuterFindings = [semantics, fidelity].filter(Boolean).flatMap((r) => list(r.findings))
  const findings = [...staticFindings, ...refuterFindings, ...standingRefusal('semantics', semantics), ...standingRefusal('fidelity', fidelity)]
  const problems = coverageNote ? [...reported, coverageNote] : reported
  return {
    static: { ...staticReport, pass: staticReport.pass === true && !coverageNote, problems },
    semantics: semantics || { refuted: true, findings: [], note: 'did not respond' },
    fidelity: fidelity || { refuted: true, findings: [], note: 'did not respond' },
    ran, findings, blocking: findings.filter((f) => f.severity === 'blocking'),
  }
}

phase('Verify')
let verification = await verify(1)
log(`Round 1: static ${verification.static.pass ? 'pass' : 'fail'}, ${verification.blocking.length} blocking, ${verification.findings.length - verification.blocking.length} advisory.`)

let repairs = 0
while (verification.blocking.length > 0 && repairs < job.maxRepairs) {
  const round = repairs + 1
  phase('Repair')
  const repair = await agent(repairPrompt(scriptPath, verification.blocking), { label: `repair#${round}`, phase: 'Repair', schema: REPAIR_SCHEMA, model: MODEL, effort: 'high' })
  if (!repair) {
    notConvened.push(`repair#${round}`)
    log(`Repair round ${round}: the repairer did not respond; no round was spent and the blocking findings stand.`)
    break
  }
  repairs = round
  log(`Repair round ${round}: ${list(repair.applied).length} applied, ${list(repair.skipped).length} left standing.`)
  phase('Verify')
  verification = await verify(round + 1)
  log(`Round ${round + 1}: static ${verification.static.pass ? 'pass' : 'fail'}, ${verification.blocking.length} blocking.`)
}
if (verification.blocking.length > 0 && repairs >= job.maxRepairs) log(`Repair budget spent (${repairs}/${job.maxRepairs}); ${verification.blocking.length} blocking finding(s) return unfixed.`)

// ok is the static gate passing, no blocking finding standing, and all three lenses
// having answered. A standing refutation already arrived as a blocking finding.
const ran = verification.ran
return {
  ok: verification.blocking.length === 0 && verification.static.pass === true && ran.static && ran.semantics && ran.fidelity,
  name, path: scriptPath, spec, repairs, notConvened, readmeRow: draft.readmeRow,
  frontDoor: draft.frontDoor || spec.frontDoor, parityGuard: draft.parityGuard || spec.parityGuard,
  verification: { static: verification.static, semantics: verification.semantics, fidelity: verification.fidelity, ran, findings: verification.findings, blocking: verification.blocking },
}
