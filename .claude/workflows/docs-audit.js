export const meta = {
  name: 'docs-audit',
  description:
    'Audit every documentation surface against the live product — one read-only auditor per surface, one cross-surface consolidator, and a ranked drift table; assess-only, mutates nothing.',
  whenToUse:
    'The assess half of a documentation audit: judging README, agent instructions, reference/architecture pages and runtime DX (--help text, error messages, exit codes) against what the product actually does, all four surfaces at once. Pass {focus?, surfaces?, quorum?, model?, timestamp?} — every key is optional, and with no surfaces list the audit runs the full four-surface roster from the docs skill Surfaces table. The fresh-reader contributor test (clone to first passing check) and the write half stay with the caller in the docs front door and arrive frozen through args; the workflow probes read-only, asks nothing, writes nothing, and moves no file.',
  phases: [
    {
      title: 'Locate',
      detail:
        'one low-effort read-only agent resolves where the docs actually live — in-repo, a submodule behind a symlink, or a separate site — and returns the docs home, the public/internal split and the fix workflow, each claim carrying the read-only command that proved it; the record is stamped verbatim into all four auditor prompts so the routing paragraph is bought once, not four times',
    },
    {
      title: 'Audit',
      detail:
        'a fixed four-shard fan-out keyed by the skill Surfaces table — README, agent instructions, reference and architecture, runtime DX — each auditor carrying several checks over its whole surface and returning drift findings that quote both the documented claim and the live behaviour',
    },
    {
      title: 'Consolidate',
      detail:
        'one high-effort judge sees every responding auditor at once, collapses one root drift restated on three surfaces into a single row, resolves severity conflicts and ranks by which blocker a reader hits first; below quorum the script refuses to consolidate',
    },
    {
      title: 'Render',
      detail:
        'the script draws the ranked audit table, the docs-home routing line, the surfaces-checked line, the duplicate list, the unread/unprobed lists and the non-responder line in JavaScript — no agent, no IO',
    },
  ],
}

// Objective: convert the AUDIT half of the docs skill into a saved workflow (council
// order 3, shape fan-out-core). The write half and the fresh-reader contributor test —
// which clones, installs and builds, and must never be parallelised — stay in the docs
// skill front door. This workflow assesses and mutates nothing.
// Declared sources (repo-relative): skills/docs/SKILL.md, skills/council/SKILL.md,
// .claude/workflows/skill-audit-sweep.js. Caller timestamp: "2026-09-16T01:00:00Z".
// Every path arrives through args or an agent; every read, probe and command happens
// inside an agent, and the script itself holds no raw command output.
//
// Two SPEC open questions were decided at draft time and are marked below:
//   * path traceability across the docs symlink — the fabrication guard compares a row
//     against its OWN surface's reported paths, full path to full path and stripped
//     suffix to stripped suffix, and the Locate record is REQUIRED to carry docsAliases[]
//     so the symlink and its target reduce to the same key (see pathKeys). Because a
//     schema is a request and not a post-condition, an incomplete alias list must never
//     delete a real drift: a row whose FILE NAME matches one the same surface reported is
//     kept and flagged as unreconciled, independent of any resolved root;
//   * the runtime-DX probe matrix is bounded by an advisory MAX_PROBES stamped into the
//     prompt; it bounds the bill without dropping a probe the script cannot see.
// Two departures from the source stage criteria, recorded so a later reader does not read
// them as omissions:
//   * a fix is never compared against fixWorkflow[] itself, and the docs-home rule binds
//     the docs-architecture surface alone — for the other three the correct fix target is
//     by definition outside the docs home;
//   * when the Locate stage returns nothing the auditors are given the repository default
//     `docs` labelled ASSUMED rather than resolved, and every fix stays marked unrouted.
// Undecided and deliberately reporting-only: an auditor under its declared minimum of
// checks still counts toward quorum and is flagged, never demoted to unaudited.
//
// Declared success return shape — the front door relays `report` unchanged and names
// `notConvened` and `unaudited`; the rest is machine-readable trace:
//   {ok: true, report, findings[], crossSurfaceDuplicates[], docsHome, roster[],
//    surfacesResponded, surfacesExpected, quorum, checksRun[], unaudited[], unread[],
//    unprobed[], rowsRejected[], consolidatorNote, notConvened[]}
// A failure return is {ok: false, error, ...the same trace keys that were reached}.

// Used ONLY when the Locate stage returns nothing, and always labelled assumed: it gives a
// stranded auditor somewhere to start without ever being reported as resolved.
const DEFAULT_DOCS_HOME = 'docs'
const MAX_PROBES = 12
const HELP_COMMAND = 'bun src/genie.ts <command> --help'

// The runtime-DX auditor is the only agent in this workflow that executes anything, and
// "read-only" alone never bounded it: a documented claim about `genie init` or `genie update`
// reads as an invitation to run the verb that proves it, on the operator's own host. The bound
// is therefore an ALLOWLIST of safe probe SHAPES, closed by a sentence that forbids everything
// else, stamped into both prompt sites that instruct that auditor to probe (issue #2920).
const PROBE_ALLOWLIST = [
  'PROBE ALLOWLIST — fail-closed. Exactly these six invocation shapes are permitted, and nothing else:',
  `  1. \`--help\` on any command or subcommand, including the bare top-level help (${HELP_COMMAND}).`,
  '  2. A documented missing-argument error: a documented command invoked with a required argument or flag omitted, so it fails in its own argument parsing and exits before doing any work.',
  '  3. `genie mcp` — the retired MCP stub, which only writes its retirement diagnostic to stderr and exits non-zero.',
  '  4. `genie ui-bridge` — the retired UI-bridge stub, the same shape of stable diagnostic and non-zero exit.',
  '  5. `genie config get <key>` with an unknown or unrecognized key, which reads the resolved config and writes nothing.',
  '  6. `genie --version`.',
  'Every other genie invocation is FORBIDDEN. This is an allowlist, not a set of examples: a probe that is not one of the six shapes above is not run at all, whatever a documented claim seems to ask for — record the claim under unprobed[] with the command you did not run and move on.',
  'A verb that mutates a real host is never a probe, not even with a flag that looks read-only and not under any temporary environment: `genie install`, `genie update`, `genie uninstall`, `genie init`, `genie setup`, `genie task create`, `genie task move`, `genie task done`, `genie task delete`, `genie task import`, `genie task sync`, `genie omni serve`, `genie omni handshake`, `genie doctor --fix-global-db`.',
].join('\n')

const SEVERITIES = ['onboarding-blocker', 'drift', 'misfiling', 'polish']

// The roster is the docs skill Surfaces table, one read-only auditor per row, closed:
// a narrowed roster is a smaller run with named gaps, never a re-shaped one.
const SURFACES = [
  {
    key: 'readme',
    label: 'README',
    where: 'README.md and every other README.md the repository ships',
    brief:
      'Audit the README surface: every documented command, flag, install step and table claim, compared against the live product with both sides quoted verbatim. This is the smallest and most self-contained surface, so cover it whole rather than sampling it.',
    effort: 'medium',
    minChecks: 6,
    minimum: 'one check per documented command and flag group, never a sample of them',
  },
  {
    key: 'agent-instructions',
    label: 'Agent instructions',
    where: 'AGENTS.md (governing) and CLAUDE.md and kin (overlays; both stay current when both exist)',
    brief:
      'Read the governing AGENTS.md first, then the CLAUDE.md overlay, and compare the two against each other and against the real CLI. This is the densest prose in the repository — the command table, the state-file table, the environment-variable table, the gotchas — and you are the ONLY auditor that reads these two files whole; the other three cite the surface they own instead, because four full reads of the overlay is the single biggest avoidable bill of this audit. Handle the volume by summarising, never by widening the brief.',
    effort: 'medium',
    minChecks: 4,
    minimum: 'both files read and compared against each other and against the live CLI',
  },
  {
    key: 'docs-architecture',
    label: 'Reference and architecture',
    where: 'the resolved docs home, ARCHITECTURE.md, and inline JSDoc or TSDoc',
    brief:
      'Audit the reference and architecture pages against the implementation, and route every fix through the docs home the Locate stage already resolved rather than rediscovering the symlink, the submodule or the internal-page exclusion yourself. Also classify each page you read as tutorial, how-to, reference or explanation and report ONLY the misfiled ones — a correctly filed page is not a finding. A Diataxis kind with no page at all IS a finding: report it against the docs home with documented set to "(no page of this kind exists)". This is the widest read surface: quote line ranges, never whole pages.',
    effort: 'medium',
    minChecks: 5,
    minimum: 'one check per architecture or reference page the docs home lists',
  },
  {
    key: 'runtime-dx',
    label: 'Runtime DX',
    where: 'help text, error messages and exit codes, plus the onboarding path stated in README or CONTRIBUTING',
    brief:
      'You are the only auditor that executes anything, and all of it is read-only. Probe the claims the documented surfaces actually make: run the read-only help command for the commands the docs name, then a handful of documented failing invocations, grading each failure on the three questions (what failed, why, what to do next) and reporting the exit code and the stderr text verbatim. Never walk the full sixteen-command matrix. Carry several checks per finding class — help text, error message and exit code — so this surface stays above its own injection cost.\n' +
      PROBE_ALLOWLIST,
    effort: 'medium',
    minChecks: 6,
    minimum: 'help text, exit code and stderr each graded on every failing invocation you probe',
  },
]

const SURFACE_KEYS = SURFACES.map((surface) => surface.key)

const str = { type: 'string' }
const bool = { type: 'boolean' }
const int = { type: 'integer' }
const strList = { type: 'array', items: { type: 'string' } }
const note = (description) => ({ type: 'string', description })
const notes = (description) => ({ type: 'array', items: { type: 'string' }, description })
const enumOf = (values) => ({ type: 'string', enum: values })
const obj = (required, properties) => ({ type: 'object', required, properties })
const listOf = (required, properties) => ({ type: 'array', items: obj(required, properties) })

// docsAliases is required, not optional: it is the ONLY mechanism that lets a symlink and
// its target reduce to one key, and a record without it turns a real drift reported under
// the other true name into a "fabrication" the row gate deletes.
// internalExcluded and entryPoints are required too: an empty array is a claim, an absent
// key is a silence the report cannot tell apart from "there are none".
const LOCATE_SCHEMA = obj(
  ['docsHome', 'docsAliases', 'isSubmodule', 'internalExcluded', 'fixWorkflow', 'entryPoints', 'evidence', 'summary'],
  {
    docsHome: note('the repo-relative directory documentation actually lives in'),
    docsAliases: notes('every other true name the same tree answers to — a symlink and its target are two names for one file'),
    isSubmodule: bool,
    publicSite: note('the public site the docs home publishes to, or empty when there is none'),
    internalExcluded: listOf(['glob', 'declaredIn'], { glob: str, declaredIn: note('the file declaring the exclusion') }),
    fixWorkflow: notes('the runnable command sequence a documentation fix must follow, in order'),
    entryPoints: notes('the pages a new reader is expected to start from'),
    evidence: listOf(['claim', 'command'], { claim: str, command: note('the read-only command that proved the claim') }),
    summary: note('two or three sentences; never the contents of a documentation file'),
  },
)

const AUDIT_SCHEMA = obj(['findings', 'checksRun'], {
  findings: listOf(['surface', 'file', 'line', 'documented', 'actual', 'severity', 'fix'], {
    surface: enumOf(SURFACE_KEYS),
    file: note('repo-relative path of the documentation that makes the claim'),
    line: note('the line or line range the claim lives on'),
    documented: note('the documented claim, quoted verbatim'),
    actual: note('the live behaviour, quoted verbatim'),
    severity: enumOf(SEVERITIES),
    fix: note('the concrete change, routed through the resolved docs workflow'),
    command: note('the read-only command that produced the live side'),
    exitCode: int,
  }),
  unread: notes('paths in this surface that could not be read — a sibling of findings[], never an inferred finding'),
  unprobed: notes('documented commands or failures that could not be probed read-only'),
  checksRun: int,
})

const CONSOLIDATE_SCHEMA = obj(['rows', 'crossSurfaceDuplicates', 'note'], {
  rows: listOf(['rank', 'surface', 'file', 'documented', 'actual', 'severity', 'fix'], {
    rank: int,
    surface: enumOf(SURFACE_KEYS),
    file: str,
    line: str,
    documented: str,
    actual: str,
    severity: enumOf(SEVERITIES),
    fix: str,
    duplicateOf: notes('the other surfaces that reported this same root drift'),
  }),
  crossSurfaceDuplicates: listOf(['surfaces', 'claim', 'survivor'], {
    surfaces: strList,
    claim: note('the one drift all of them restate'),
    survivor: note('the row that survives the merge'),
  }),
  note: note('anything the findings could not settle'),
})

// `schema` is a request, not a post-condition: a short response degrades, never throws.
const list = (value) => (Array.isArray(value) ? value : [])
const text = (value) => (typeof value === 'string' ? value.trim() : '')
// A line number arrives as a string under the schema hint and as an integer just as
// often. Coercing it here keeps it out of the dedup key as an empty string, which would
// collapse two distinct drifts in one file into one row.
const lineText = (value) => text(value) || (typeof value === 'number' && Number.isFinite(value) ? String(value) : '')
// A checksRun arriving as a numeric string is an ordinary degradation, not a zero: left
// uncoerced it falsely reports a surface that ran five checks as having run none.
const count = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}
const section = (title, items) => (items && items.length ? `${title}:\n${items.map((x) => `- ${x}`).join('\n')}` : `${title}: (none given)`)
const join = (parts) => parts.filter(Boolean).join('\n\n')
const bullets = (items) => items.map((item) => `- ${item}`).join('\n')
const block = (title, value) => `## ${title}\n${JSON.stringify(value, null, 2)}`

// One kebab slug is the only shape that may become part of an agent label.
const SURFACE_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// Paths are stamped into prompts and into the report, so only a path inside the
// repository survives: nothing absolute, nothing home-anchored, no `..` segment. A
// leading `./` and a trailing `/` are normalised away, not rejected.
function repoRelative(value) {
  const cleaned = String(value).trim().replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
  if (!cleaned || cleaned.startsWith('/') || cleaned.startsWith('~')) return ''
  return cleaned.split('/').some((segment) => segment === '..') ? '' : cleaned
}

const byKey = new Map(SURFACES.map((surface) => [surface.key, surface]))
const byLabel = new Map(SURFACES.map((surface) => [surface.label.toLowerCase(), surface]))

// `surfaces` is a NARROWING filter over the closed roster, never a growth knob: a key
// or a Surfaces-table label resolves, anything else is dropped and logged by name.
function surfaceOf(entry) {
  const cleaned = String(entry).trim()
  const slug = cleaned.toLowerCase().replace(/\s+/g, '-')
  if (SURFACE_KEY.test(slug) && byKey.has(slug)) return byKey.get(slug)
  return byLabel.get(cleaned.toLowerCase()) || null
}

// Accept an object or a JSON-encoded string (some invocation paths stringify args); a
// bare string degrades to the focus. Every key is optional, so only a value that is
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
  const asked = Array.isArray(input.surfaces) ? input.surfaces.map(String) : text(input.surfaces) ? [text(input.surfaces)] : []
  return {
    focus: text(input.focus),
    requested: asked,
    // Held raw: the default quorum depends on the roster AFTER narrowing.
    quorum: Number.isInteger(input.quorum) ? input.quorum : null,
    model: text(input.model),
    timestamp: text(input.timestamp),
  }
}

// Shared prompt clauses: each contract sentence is written once and reused verbatim.
const READ_ONLY =
  'Read only; change nothing. Create no file, edit no file, move no file, install nothing, clone nothing and run no command that mutates the working tree — this audit assesses, and the caller decides what to write.'
const NO_CONTRIBUTOR_TEST =
  'Do NOT run the contributor test. Do not clone the repository, do not install dependencies, do not build, and do not drive the onboarding path to a first passing check. That walk runs exactly once, serially, and belongs to the caller; it is outside your brief and outside this workflow.'
const EVIDENCE_RULE =
  'Every finding quotes BOTH sides verbatim: the documented claim with its repo-relative file and its line or line range, and the live behaviour with the read-only command that produced it. A finding that quotes only one side is not a finding — drop it rather than half-state it.'
const SEVERITY_RULE = `Severity is exactly one of ${SEVERITIES.join(' | ')}: onboarding-blocker (a reader following the written path stops here), drift (documented and actual disagree), misfiling (right content, wrong Diataxis kind or wrong page), polish (message or wording quality). Nothing outside that closed set.`
const NO_ECHO =
  'Return findings, never material: no documentation body, no raw command output beyond the quoted line you are comparing, and no list of paths that yielded nothing. A path you could not read belongs in unread[]; a documented command you could not probe read-only belongs in unprobed[].'
// Each surface declares its own floor: one global number let a README documenting sixteen
// commands pass on three checks.
const checksRule = (surface) =>
  `Carry several checks across your whole surface — at least ${surface.minChecks} (${surface.minimum}), and report the number you actually ran as checksRun. One agent per finding is the failure mode this fan-out exists to avoid.`

const brief = (job) =>
  [
    `Focus: ${job.focus || '(none given — audit the documentation as it stands)'}`,
    job.timestamp ? `Caller timestamp: ${job.timestamp}` : '',
  ]
    .filter(Boolean)
    .join('\n')
const head = (role, job) => `You are the ${role} of a documentation audit.\n${brief(job)}`

const locatePrompt = (job) =>
  join([
    head('LOCATE reader', job),
    'Resolve where this repository documentation actually lives before anyone judges it: in the repository itself, in a submodule behind a symlink, or on a separate site with its own workflow. A fix that says "edit here" when the docs live elsewhere strands the change, so name the real route.',
    bullets([
      'Resolve the docs home and every other true name the same tree answers to — a symlink and its target are two names for one file, and both are returned so a later finding quoting either name resolves to one place.',
      'Say whether that home is a submodule, and name the public site it publishes to when there is one.',
      'Return internalExcluded[] as {glob, declaredIn}: pages deliberately kept off a public site are design, not gaps, and the file declaring each exclusion is the proof.',
      'Return fixWorkflow[] as the runnable command sequence a documentation change must follow, in order — branch where the docs live, open the change against the remote that owns them, then bump whatever pointer the superproject keeps.',
      'Return entryPoints[]: the pages a new reader is expected to start from.',
    ]),
    'Every claim carries the read-only command that proved it in evidence[] as {claim, command}. Report no file contents: this stage resolves routing, not drift.',
    READ_ONLY,
  ])

function docsBlock(docs) {
  if (!docs) {
    return [
      `DOCS HOME: UNRESOLVED. The locate stage returned nothing this run, so \`${DEFAULT_DOCS_HOME}\` is ASSUMED as a starting point, never resolved — confirm it against what you actually read and say so if it is wrong.`,
      'Do not invent a routing workflow around it. Route every fix you propose to the path you actually read; the report marks every fix unrouted.',
    ].join('\n')
  }
  const excluded = list(docs.internalExcluded)
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => `${text(entry.glob)} (declared in ${text(entry.declaredIn) || 'a file the locate stage did not name'})`)
  return join([
    `DOCS HOME (frozen — resolved once for all four auditors, do not re-derive it): ${text(docs.docsHome) || '(not named)'}${
      docs.isSubmodule ? ' — a submodule, so a fix there is not a fix in this repository alone' : ''
    }${text(docs.publicSite) ? `, published at ${text(docs.publicSite)}` : ''}`,
    section('Other true names for that same tree', list(docs.docsAliases).map(text).filter(Boolean)),
    section('Deliberately excluded from the public site (design, never a gap)', excluded),
    section('A documentation fix routes through, in order', list(docs.fixWorkflow).map(text).filter(Boolean)),
    section('Reader entry points', list(docs.entryPoints).map(text).filter(Boolean)),
    text(docs.summary) ? `Locate summary: ${docs.summary}` : '',
  ])
}

function auditPrompt(job, surface, docs) {
  return join([
    head(`AUDITOR for the ${surface.label} surface`, job),
    `Your surface, and nothing else: ${surface.where}.`,
    surface.brief,
    docsBlock(docs),
    'You hold one surface of four. No other auditor answer is visible to you, and you must not re-read a surface you do not own: cite it instead and let the consolidator collapse the overlap. The roster is closed, so a claim you leave unchecked is a gap nobody else fills.',
    surface.key === 'runtime-dx'
      ? `Probe read-only only: ${HELP_COMMAND} for the commands the documented surfaces actually claim, plus documented failing invocations whose exit code and stderr you report verbatim. Keep the whole probe matrix to roughly ${MAX_PROBES} invocations — an advisory bound on the bill, not a licence to stop mid-claim. No probe installs, clones, writes or mutates anything.\n${PROBE_ALLOWLIST}`
      : 'Verify claims against the live product with read-only commands and reads. You execute nothing that changes state.',
    EVIDENCE_RULE,
    SEVERITY_RULE,
    `Return findings[] as {surface, file, line, documented, actual, severity, fix, command}, with surface set to "${surface.key}" on every row, plus the siblings unread[], unprobed[] and checksRun. ${checksRule(surface)}`,
    NO_ECHO,
    NO_CONTRIBUTOR_TEST,
    READ_ONLY,
  ])
}

function consolidatePrompt(job, responded, absent, docs) {
  const blocks = responded.map((entry) =>
    block(`${entry.label} findings (${entry.key}, ${entry.checks} check(s) run)`, {
      findings: list(entry.response.findings),
      unread: list(entry.response.unread),
      unprobed: list(entry.response.unprobed),
    }),
  )
  return join([
    head('CONSOLIDATING JUDGE', job),
    'You are the only cross-surface judge. You did not read the documentation; the findings below are your interface, and re-opening the pages is outside your brief.',
    ...blocks,
    docs ? docsBlock(docs) : 'The docs home was never resolved this run: judge the fixes as written and route nothing you cannot see.',
    `Surfaces that did NOT respond this run: ${absent.length ? absent.join(', ') : '(none)'}. Infer nothing for them — no row, no severity, no claim about what they would have found.`,
    `The only surfaces you may return rows for are: ${responded.map((entry) => entry.key).join(', ')}.`,
    'Collapse duplicates: one root drift restated in the README, in the agent-instructions overlay and again in the reference pages is ONE row, not three. Name the survivor, list the surfaces it came from in duplicateOf[], and record the merge in crossSurfaceDuplicates[] as {surfaces[], claim, survivor} so nothing disappears silently.',
    'Resolve conflicting severities yourself — two auditors grading the same drift differently is a conflict you settle, not a pair of rows.',
    `Rank by reader impact, which only you can see: which blocker does a reader hit first. Order the rows ${SEVERITIES.join(', then ')}, and set rank to a 1-based position in that order.`,
    SEVERITY_RULE,
    'Every row keeps the file and line the auditor reported: a row naming a file no auditor reported is dropped by the caller as a fabrication, so never invent one to make the table read better.',
    'Return rows[], crossSurfaceDuplicates[], and note for anything the findings could not settle.',
    READ_ONLY,
  ])
}

// --- path traceability across the docs symlink -------------------------------
// `docs/installation.mdx` and `.docs-vendor/genie/installation.mdx` are the same file
// under two true names. Rows and findings therefore reduce to a KEYED pair: the full
// repo-relative path, and the suffixes left after each docs root is stripped, kept apart
// so a stripped suffix is never compared against another path's full spelling. Flattening
// the two into one set let a fabricated `docs/README.md` (stripped `README.md`) ride in on
// a README auditor's root `README.md` — the collision the fabrication guard exists to stop.
function docsRoots(docs) {
  if (!docs) return []
  const roots = [text(docs.docsHome), ...list(docs.docsAliases).map(text)].map(repoRelative).filter(Boolean)
  return [...new Set(roots)].sort((a, b) => b.length - a.length)
}

function pathKeys(file, roots) {
  const rel = repoRelative(String(file === undefined || file === null ? '' : file).split('#')[0])
  if (!rel) return null
  const stripped = []
  for (const root of roots) if (rel.startsWith(`${root}/`)) stripped.push(rel.slice(root.length + 1))
  return { full: rel, stripped: [...new Set(stripped)] }
}

// Two paths name one file when their full spellings agree, or when both reduce to the
// same docs-home-stripped suffix. Never full against stripped, and never across surfaces:
// the comparison is always a row against the keys of its OWN responding auditor.
const keysMatch = (rowKeys, surfaceKeys) =>
  !!rowKeys && !!surfaceKeys && (surfaceKeys.full.has(rowKeys.full) || rowKeys.stripped.some((key) => surfaceKeys.stripped.has(key)))

const inRoots = (rel, roots) => roots.some((root) => rel === root || rel.startsWith(`${root}/`))
const baseName = (rel) => rel.split('/').pop()

const PATH_TOKEN = /[A-Za-z0-9_.~/-]*\/[A-Za-z0-9_.~-]+|[A-Za-z0-9_.-]+\.(?:mdx?|ts|tsx|js|json|toml|ya?ml)/g
const ROOT_DOC_FILES = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'ARCHITECTURE.md', 'CONTRIBUTING.md']

function pathTokens(value) {
  return (String(value).match(PATH_TOKEN) || []).map((token) => token.replace(/[.,;:)\]]+$/, '')).filter(Boolean)
}

// A fix that names a documentation page outside the resolved docs home strands the
// change. Such a row is KEPT and rendered with its defect named — dropping it would lose
// a real drift over a routing mistake the caller can correct in one line.
function fixDefect(row, roots, home, surfaceKey) {
  const fix = text(row.fix)
  if (!fix) return 'the fix is empty, so the drift is reported with no change to make'
  // One defect class, the SPEC's own: a fix that edits a documentation page outside the
  // resolved docs home. There is deliberately NO "not a path in this repository" class — a
  // correct fix here routinely names a URL, a home-anchored path, a placeholder
  // (`<GENIE_HOME>/skills`) or a glob (`**/_internal/`, `*/README.md`), each of which that
  // class stamped as a defect. The rule binds docs-architecture only: for the other three
  // the correct target is by definition outside the docs home, and a `.` root matches all.
  if (!roots.length || surfaceKey !== 'docs-architecture' || roots.some((root) => root === '.')) return ''
  const stranded = pathTokens(fix)
    .filter((token) => /\.mdx?$/i.test(token) && !token.includes('//') && !token.includes('*') && !token.includes('<'))
    .map(repoRelative)
    .filter((token) => token && !inRoots(token, roots) && !ROOT_DOC_FILES.includes(baseName(token)))
  return stranded.length ? `the fix edits ${stranded.join(', ')}, outside the resolved docs home (${home || roots[0]})` : ''
}

const cell = (value) =>
  String(value === undefined || value === null ? '' : value)
    .replace(/\|/g, '\\|')
    .replace(/\s*\n+\s*/g, ' ')
    .trim()

const locationCell = (row) => {
  const line = lineText(row.line)
  return `\`${cell(row.file)}\`${line ? `:${cell(line)}` : ''}`
}

function fixCell(row, defect, unrouted) {
  const parts = [cell(row.fix) || '(no fix named)']
  if (unrouted) parts.push(`UNROUTED: ${unrouted}`)
  if (defect) parts.push(`DEFECT: ${cell(defect)}`)
  return parts.join(' — ')
}

// The banner and the per-fix UNROUTED note must agree: a locate stage that answered but
// named no repo-relative home is a different degradation from one that never answered.
function docsLine(docs, roots, home) {
  if (!docs)
    return `Docs home: UNRESOLVED — the locate stage returned nothing, so \`${DEFAULT_DOCS_HOME}\` was ASSUMED for the auditors, every fix below is marked unrouted and none was assumed correct.`
  if (!roots.length)
    return 'Docs home: UNRESOLVED — the locate stage answered but named no repo-relative docs home, so every fix below is marked unrouted.'
  const route = list(docs.fixWorkflow).map(text).filter(Boolean)
  const aliases = roots.filter((root) => root !== home)
  return `Docs home: \`${cell(home || '(not named)')}\`${docs.isSubmodule ? ' (a submodule)' : ''}${
    text(docs.publicSite) ? `, published at ${cell(docs.publicSite)}` : ''
  }${aliases.length ? `; the same tree also reads as ${aliases.map((root) => `\`${cell(root)}\``).join(', ')}` : ''}. Fixes route through: ${
    route.length ? route.map((step) => `\`${cell(step)}\``).join(' → ') : '(the locate stage named no workflow)'
  }`
}

function render(view) {
  const checked = view.checksRun.map(
    (entry) => `${entry.surface} (${entry.checks} check${entry.checks === 1 ? '' : 's'}${entry.belowMinimum ? `, under its declared minimum of ${entry.minChecks} — ${entry.minimum}` : ''})`,
  )
  const skipped = view.unaudited.map((entry) => `${entry.surface} (${entry.why})`)
  const header = bullets(
    [
      `Focus: ${view.job.focus || '(none given)'}`,
      `Timestamp: ${view.job.timestamp || '(none supplied — the workflow has no clock)'}`,
      docsLine(view.docs, view.roots, view.home),
      `Surfaces: ${view.responded}/${view.expected} responded (quorum ${view.quorum}) over the roster ${view.roster.join(', ')}`,
      `Verified this run: ${checked.length ? checked.join(', ') : '(nothing)'} | Not checked this run: ${skipped.length ? skipped.join(', ') : '(nothing)'}`,
    ].filter(Boolean),
  )
  const table = view.rows.length
    ? [
        '| # | Severity | Surface | Location | Documented | Actual | Fix |',
        '|---|---|---|---|---|---|---|',
        ...view.rows.map(
          (row, index) =>
            `| ${index + 1} | ${cell(row.severity)} | ${cell(row.surface)} | ${locationCell(row)} | ${cell(row.documented)} | ${cell(row.actual)} | ${fixCell(
              row,
              view.defects.get(row.rowKey),
              view.fixesUnrouted,
            )} |`,
        ),
      ].join('\n')
    : '(no audit row survived validation — every responding surface read clean, or every row failed the row gate)'
  const duplicates = view.duplicates.map(
    (entry) => `- ${list(entry.surfaces).map(String).join(' + ')} → survivor ${text(entry.survivor) || '(not named)'}: ${text(entry.claim) || '(claim not stated)'}`,
  )
  const unaudited = view.unaudited.map((entry) => `- \`${entry.surface}\` — ${entry.why}; nothing was inferred for it`)
  // Dropped and kept-with-a-defect are opposite outcomes: rendered in one list a reader
  // cannot tell which rows actually reached the table above.
  const rejectedLine = (entry) => `- \`${entry.surface}\` ${entry.file}${entry.line ? `:${entry.line}` : ''} — ${entry.defect}`
  const dropped = view.rowsRejected.filter((entry) => !entry.kept).map(rejectedLine)
  const flagged = view.rowsRejected.filter((entry) => entry.kept).map(rejectedLine)
  return join([
    '# Documentation audit',
    header,
    `## Drift, ranked by reader impact\n${table}`,
    `## Cross-surface duplicates\n${duplicates.length ? duplicates.join('\n') : '- (none claimed — every row is a distinct drift)'}`,
    `## Not audited\n${unaudited.length ? unaudited.join('\n') : '- (none — every surface of the roster responded)'}`,
    view.unread.length ? `## Could not read\n${bullets(view.unread.map((entry) => `\`${entry.path}\` (${entry.surface})`))}` : '',
    view.unprobed.length ? `## Could not probe read-only\n${bullets(view.unprobed.map((entry) => `${entry.claim} (${entry.surface})`))}` : '',
    dropped.length ? `## Rows the gate dropped (not in the table above)\n${dropped.join('\n')}` : '',
    flagged.length ? `## Rows the gate kept with a defect (in the table above)\n${flagged.join('\n')}` : '',
    view.note ? `## Judge note\n${view.note}` : '',
    'This audit read and probed read-only: it created, modified and moved no file. The contributor test (clone to the first passing check) and the write half were not performed here and no verdict is claimed for either.',
    view.notResponded.length ? `_Did not respond this run: ${view.notResponded.join(', ')}. Nothing was inferred for them._` : '_Every agent responded this run._',
  ])
}

const job = normalizeInput(args)
if (!job) return { ok: false, error: 'Pass {focus?, surfaces?, quorum?, model?, timestamp?}.' }
const MODEL = job.model
// notConvened carries exactly one kind of entry: an agent that returned null. Every
// other stop is reported through `error`, so the list keeps a single meaning.
const notConvened = []
log(`docs-audit: ${job.focus ? job.focus.slice(0, 120) : 'no focus given'}`)

// Narrowing happens before anything is dispatched: an unknown name is dropped by name,
// and a narrowing that empties the roster is an error, never a silent full audit.
const requested = []
const droppedSurfaces = []
for (const entry of job.requested) {
  const surface = surfaceOf(entry)
  if (surface) requested.push(surface)
  else droppedSurfaces.push(String(entry))
}
if (droppedSurfaces.length) log(`Dropped ${droppedSurfaces.length} unknown surface name(s): ${droppedSurfaces.join(', ')}.`)
if (job.requested.length && !requested.length) {
  return {
    ok: false,
    error: `No surface of the closed roster survived the narrowing. Valid keys: ${SURFACE_KEYS.join(' | ')}.`,
    notConvened,
    roster: [],
    droppedSurfaces,
  }
}
const rosterSurfaces = requested.length ? SURFACES.filter((surface) => requested.includes(surface)) : SURFACES.slice()
const roster = rosterSurfaces.map((surface) => surface.key)
const narrowedOut = SURFACES.filter((surface) => !rosterSurfaces.includes(surface)).map((surface) => surface.key)
const surfacesExpected = rosterSurfaces.length
// The quorum is computed from the roster AFTER narrowing: computed from the intake it
// silently becomes all-surfaces-must-respond.
const quorum =
  job.quorum === null
    ? surfacesExpected >= 3
      ? surfacesExpected - 1
      : surfacesExpected
    : Math.max(1, Math.min(job.quorum, surfacesExpected))
if (narrowedOut.length) log(`Narrowed to ${roster.join(', ')}; ${narrowedOut.join(', ')} are named as gaps, never audited silently.`)
log(`${surfacesExpected} surface(s) on the roster; quorum ${quorum}.`)

phase('Locate')
const located = await agent(locatePrompt(job), { label: 'locate:docs-home', phase: 'Locate', schema: LOCATE_SCHEMA, ...(MODEL ? { model: MODEL } : {}), effort: 'low' })
if (!located) {
  notConvened.push('locate:docs-home')
  log('No response from locate:docs-home; the auditors are told the docs home is unresolved and every fix is marked unrouted.')
}
// Normalise ONCE at the boundary: every path the Locate agent returns passes
// repoRelative() here, so nothing absolute, home-anchored or `..`-bearing can reach an
// auditor prompt, the consolidator prompt, the report or the trace. A rejected path
// renders as `(not named)` and, when no root survives, the run is marked unrouted.
const docsHomePath = located ? repoRelative(text(located.docsHome)) : ''
const docs = located
  ? {
      ...located,
      docsHome: docsHomePath,
      docsAliases: list(located.docsAliases).map(text).map(repoRelative).filter(Boolean),
      entryPoints: list(located.entryPoints).map(text).map(repoRelative).filter(Boolean),
      internalExcluded: list(located.internalExcluded)
        .filter((entry) => entry && typeof entry === 'object')
        .map((entry) => ({ ...entry, declaredIn: repoRelative(text(entry.declaredIn)) })),
    }
  : null
const roots = docsRoots(docs)
if (docs && !roots.length) log('The locate stage named no repo-relative docs home; fixes are reported as written and nothing is routed for them.')
const rejectedPaths =
  (located ? (text(located.docsHome) && !docsHomePath ? 1 : 0) : 0) +
  (located ? list(located.docsAliases).map(text).filter(Boolean).length - list(docs.docsAliases).length : 0) +
  (located ? list(located.entryPoints).map(text).filter(Boolean).length - list(docs.entryPoints).length : 0)
if (rejectedPaths > 0) log(`${rejectedPaths} path(s) the locate stage returned are not repo-relative and were dropped before any prompt or report quoted them.`)

phase('Audit')
const rawAudits = await parallel(
  rosterSurfaces.map((surface) => () =>
    agent(auditPrompt(job, surface, docs), {
      label: `audit:${surface.key}`,
      phase: 'Audit',
      schema: AUDIT_SCHEMA,
      ...(MODEL ? { model: MODEL } : {}),
      effort: surface.effort,
    }),
  ),
)
const responded = rosterSurfaces
  .map((surface, i) => ({ ...surface, response: rawAudits[i] }))
  .filter((entry) => entry.response)
  .map((entry) => ({ ...entry, checks: count(entry.response.checksRun) }))
const silent = rosterSurfaces.filter((_, i) => !rawAudits[i])
for (const surface of silent) notConvened.push(`audit:${surface.key}`)
if (silent.length) log(`No response from ${silent.map((surface) => surface.key).join(', ')}; they are named as gaps and nothing is inferred for them.`)

const checksRun = responded.map((entry) => ({
  surface: entry.key,
  checks: entry.checks,
  minChecks: entry.minChecks,
  minimum: entry.minimum,
  belowMinimum: entry.checks < entry.minChecks,
}))
const thin = checksRun.filter((entry) => entry.belowMinimum)
// Reporting-only by design: a thin reading still counts toward quorum and is flagged,
// rather than being demoted to `unaudited` where it would read as never checked.
if (thin.length) log(`${thin.length} surface(s) ran fewer checks than they declare: ${thin.map((entry) => `${entry.surface} (${entry.checks}/${entry.minChecks})`).join(', ')}. Reported, not demoted.`)

const unread = []
const unprobed = []
for (const entry of responded) {
  for (const path of list(entry.response.unread)) if (text(path)) unread.push({ surface: entry.key, path: text(path) })
  for (const claim of list(entry.response.unprobed)) if (text(claim)) unprobed.push({ surface: entry.key, claim: text(claim) })
}
if (unread.length) log(`${unread.length} path(s) an auditor could not read: ${unread.map((entry) => entry.path).join(', ')}.`)
if (unprobed.length) log(`${unprobed.length} documented claim(s) could not be probed read-only: ${unprobed.map((entry) => entry.claim).join(', ')}.`)

// The fabrication guard: a consolidator row must name a file THE AUDITOR OF ITS OWN
// SURFACE actually reported. Keys are collected per surface and kept split into full
// paths and docs-home-stripped suffixes, so a suffix can never satisfy the guard by
// colliding with another surface's full path. `tails` is the weaker, evidence-bearing
// fallback used only to keep-and-flag an unreconcilable spelling of a file that surface
// did name — never to admit a path it never touched.
const reportedBySurface = new Map(responded.map((entry) => [entry.key, { full: new Set(), stripped: new Set(), tails: new Set() }]))
let reportedFindings = 0
for (const entry of responded) {
  const keys = reportedBySurface.get(entry.key)
  for (const finding of list(entry.response.findings)) {
    if (!finding || typeof finding !== 'object') continue
    reportedFindings += 1
    const found = pathKeys(finding.file, roots)
    if (!found) continue
    keys.full.add(found.full)
    keys.tails.add(baseName(found.full))
    for (const key of found.stripped) keys.stripped.add(key)
  }
}
log(`${responded.length}/${surfacesExpected} surface(s) responded with ${reportedFindings} finding(s) over ${responded.reduce((sum, entry) => sum + entry.checks, 0)} check(s).`)

const unaudited = [
  ...silent.map((surface) => ({ surface: surface.key, why: 'silent' })),
  ...narrowedOut.map((key) => ({ surface: key, why: 'narrowed out' })),
]

// Every early return carries the same trace keys the success return declares, so a
// caller reads one shape whether the audit consolidated or stopped.
const trace = () => ({
  docsHome: docs || null,
  roster,
  surfacesResponded: responded.length,
  surfacesExpected,
  quorum,
  checksRun,
  unaudited,
  unread,
  unprobed,
  rowsRejected: [],
  consolidatorNote: '',
  crossSurfaceDuplicates: [],
  findings: [],
  notConvened,
})
// Unconsolidated findings are attached to every stop AFTER the fan-out ran: an error that
// throws away two completed read-only audits wastes the whole bill.
const rawFindings = () => responded.flatMap((entry) => list(entry.response.findings).filter(Boolean).map((finding) => ({ ...finding, surface: entry.key })))

if (responded.length < quorum) {
  log(`${responded.length}/${surfacesExpected} surfaces responded, under the quorum of ${quorum}; no ranked table is produced.`)
  return {
    ok: false,
    error: `Fewer surfaces responded (${responded.length}) than the quorum of ${quorum} of ${surfacesExpected} — a documentation audit cannot be ranked from a partial reading.`,
    ...trace(),
    findings: rawFindings(),
  }
}

phase('Consolidate')
const judged = await agent(consolidatePrompt(job, responded, silent.map((surface) => surface.key), docs), {
  label: 'consolidate:audit-table',
  phase: 'Consolidate',
  schema: CONSOLIDATE_SCHEMA,
  ...(MODEL ? { model: MODEL } : {}),
  effort: 'high',
})
if (!judged) {
  notConvened.push('consolidate:audit-table')
  log('No response from consolidate:audit-table; the per-surface findings are returned unconsolidated so the fan-out is not wasted.')
  return {
    ok: false,
    error: 'The consolidating judge returned nothing; no ranked table was produced and none was inferred.',
    ...trace(),
    findings: rawFindings(),
  }
}

// Row gate: first mention wins per {surface, file, line}; a severity outside the closed
// enum and a file no auditor reported are dropped; a stranded fix is KEPT and flagged.
const respondedKeys = new Set(responded.map((entry) => entry.key))
const narrowedOutKeys = new Set(narrowedOut)
const rows = []
const rowsRejected = []
const defects = new Map()
const seen = new Set()
for (const row of list(judged.rows)) {
  if (!row || typeof row !== 'object') continue
  let unreconciled = ''
  // `schema` is a request, not a post-condition, and every prompt in this file speaks
  // the Surfaces-table LABELS, so a judge returning "README" or "Runtime DX" is an
  // ordinary degradation — resolved here the same way severity is lowercased below.
  const resolvedSurface = surfaceOf(row.surface)
  const surface = resolvedSurface ? resolvedSurface.key : text(row.surface)
  const file = repoRelative(String(row.file === undefined || row.file === null ? '' : row.file).split('#')[0])
  const line = lineText(row.line)
  const severity = text(row.severity).toLowerCase()
  const rowKey = `${surface}|${file}|${line}`
  const reject = (defect) => rowsRejected.push({ surface: surface || '(unnamed)', file: file || text(row.file) || '(no file)', line, defect, kept: false })
  if (!respondedKeys.has(surface)) {
    // Never convened and failed to answer are different facts about the run.
    reject(narrowedOutKeys.has(surface) ? 'the row names a surface the caller narrowed out of this run' : 'the row names a surface that did not respond this run')
    continue
  }
  if (!file) {
    reject('the row names no repo-relative file')
    continue
  }
  if (!SEVERITIES.includes(severity)) {
    reject(`severity ${text(row.severity) || '(empty)'} is outside the closed set ${SEVERITIES.join(' | ')}`)
    continue
  }
  const surfaceKeys = reportedBySurface.get(surface)
  if (!keysMatch(pathKeys(file, roots), surfaceKeys)) {
    // Keep-and-flag needs EVIDENCE that row and surface name one file: the row's file name
    // must be one that surface itself reported under a spelling that will not reconcile
    // (an incomplete docsAliases[], a root the Locate stage never named). "Anywhere under
    // the docs home" is not evidence — it let an invented `docs/ghost.mdx` into the table.
    // Independent of `roots`, so a silent Locate stage cannot make the guard lossy.
    if (surfaceKeys.tails.has(baseName(file))) {
      unreconciled = `this surface reported ${baseName(file)} under a different spelling that will not reconcile with ${file} — kept, and the two paths were not proven to be one file`
    } else {
      reject('no responding auditor reported a finding in that file — dropped as a fabrication')
      continue
    }
  }
  if (seen.has(rowKey)) {
    reject('a second row for one surface, file and line — first mention wins')
    continue
  }
  seen.add(rowKey)
  const defect = [unreconciled, fixDefect(row, roots, docsHomePath, surface)].filter(Boolean).join('; ')
  if (defect) {
    rowsRejected.push({ surface, file, line, defect, kept: true })
    defects.set(rowKey, defect)
  }
  rows.push({ ...row, rowKey, surface, file, line, severity })
}
if (rowsRejected.length)
  log(
    `Row gate: ${rowsRejected.filter((entry) => !entry.kept).length} dropped, ${rowsRejected.filter((entry) => entry.kept).length} kept with a defect — ${rowsRejected
      .map((entry) => `${entry.surface}/${entry.file}: ${entry.defect}`)
      .join('; ')}.`,
  )

// The rendered order is re-derivable from the severity column alone; the judge's own
// rank only breaks ties inside one severity band.
const ordered = rows
  .map((row, index) => ({ row, index, band: SEVERITIES.indexOf(row.severity), rank: Number.isInteger(row.rank) ? row.rank : Number.MAX_SAFE_INTEGER }))
  .sort((a, b) => a.band - b.band || a.rank - b.rank || a.index - b.index)
  .map((entry) => entry.row)

const duplicates = list(judged.crossSurfaceDuplicates).filter((entry) => entry && typeof entry === 'object')
const consolidatorNote = text(judged.note)
const fixesUnrouted = docs ? (roots.length ? '' : 'the locate stage named no repo-relative docs home') : 'the locate stage returned nothing this run'
if (fixesUnrouted) log(`Every fix is rendered unrouted: ${fixesUnrouted}, so no routing claim is made for any of them.`)

phase('Render')
const report = render({
  job,
  docs,
  roots,
  home: docsHomePath,
  roster,
  rows: ordered,
  defects,
  fixesUnrouted,
  duplicates,
  checksRun,
  unaudited,
  unread,
  unprobed,
  rowsRejected,
  note: consolidatorNote,
  responded: responded.length,
  expected: surfacesExpected,
  quorum,
  notResponded: notConvened,
})
log(`Audit table: ${ordered.length} row(s) over ${responded.length}/${surfacesExpected} surface(s); ${duplicates.length} cross-surface duplicate(s) merged.`)

return {
  ok: true,
  report,
  ...trace(),
  findings: ordered.map((row, index) => {
    const defect = defects.get(row.rowKey)
    return {
      rank: index + 1,
      surface: row.surface,
      file: row.file,
      line: row.line,
      documented: text(row.documented),
      actual: text(row.actual),
      severity: row.severity,
      fix: text(row.fix),
      duplicateOf: list(row.duplicateOf).map(String),
      ...(defect ? { defect } : {}),
    }
  }),
  crossSurfaceDuplicates: duplicates,
  rowsRejected,
  consolidatorNote,
}
