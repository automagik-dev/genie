export const meta = {
  name: 'pm-ledger-verify',
  description: 'Adversarially verify PM release-ledger edits against raw evidence before commit/push',
  whenToUse:
    'Run over uncommitted wish-ledger edits (WISH.md / REVIEW-DISPOSITION.md / .genie/INDEX.md) before committing them. Three independent lenses hunt overclaims, cross-document drift, and release-gate contract violations. Pass args {wishDir, evidenceFile?, repoRoot?}.',
  phases: [{ title: 'Verify', detail: 'three independent lenses over the ledger diff' }],
}

// args: { wishDir: string, evidenceFile?: string, repoRoot?: string }
// wishDir: absolute path to the wish directory containing WISH.md (and usually a
//   review/finding ledger). evidenceFile: optional absolute path to a raw-evidence
//   bundle (command outputs, quotes) that ledger claims must be grounded in.
// repoRoot: defaults to the git root containing wishDir.
// Tolerate a JSON-encoded string args (some invocation paths stringify it).
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
const wishDir = parsedArgs && parsedArgs.wishDir
if (!wishDir) throw new Error('pm-ledger-verify requires args.wishDir (absolute path to the wish directory)')
const evidenceFile = (parsedArgs && parsedArgs.evidenceFile) || null
const repoRoot = (parsedArgs && parsedArgs.repoRoot) || null

const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'quote', 'problem', 'severity', 'mustFix'],
        properties: {
          file: { type: 'string' },
          quote: { type: 'string', description: 'exact text from the edited ledger that is wrong' },
          problem: { type: 'string' },
          severity: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
          mustFix: {
            type: 'boolean',
            description: 'true only if committing without fixing would misstate release evidence',
          },
        },
      },
    },
  },
}

const COMMON = `
You are verifying PM release-ledger updates for the wish at ${wishDir}.
${repoRoot ? `Repository root: ${repoRoot}.` : 'Determine the repository root from the wish directory (git rev-parse --show-toplevel).'}
The edits under review are the UNCOMMITTED working-tree changes to the wish's ledger documents (typically WISH.md, a review/finding ledger such as REVIEW-DISPOSITION.md, and the repo's .genie/INDEX.md). Obtain them with: git -C <repoRoot> diff -- <wishDir> .genie/INDEX.md
${evidenceFile ? `The raw evidence bundle (command outputs, verbatim quotes) is at: ${evidenceFile}. Every new ledger claim must be grounded in it or in the repository itself.` : 'No evidence bundle was provided: ground every claim in the repository itself (files, git history, test output you can reproduce read-only).'}

Read the FULL edited documents, not just the diff. You may read anything in the repository read-only. Do NOT edit any file. Do NOT run any state-changing command. Report findings only via structured output. Only report what you can ground in files/evidence — no speculation. Default to an empty findings list if the ledgers are accurate.
`

const LENSES = [
  {
    key: 'overclaim',
    prompt:
      COMMON +
      `
Lens: OVERCLAIM HUNTER. Try to refute every NEW claim the ledger edits make. For each edited sentence ask: does the evidence actually support it? Hunt specifically for:
- gates marked PASS/CLOSED/SUPERSEDED/DONE without matching evidence,
- open findings or follow-ups being soft-pedaled, mislabeled as fixed, or omitted anywhere a reader would need them,
- numbers that do not match the evidence (test counts, file counts, SHAs, digest counts, dates),
- any blocker owned by another wish or an external actor (CI, human approval) represented as closed,
- any statement implying an untrusted component is now trusted, or that an external action happened when it did not.`,
  },
  {
    key: 'consistency',
    prompt:
      COMMON +
      `
Lens: CROSS-DOCUMENT CONSISTENCY. Compare every edited document against the others and against itself. Hunt for:
- the same fact stated with different numbers, SHAs, or states across documents (including between a gate table and the narrative paragraphs of the same file),
- finding-ID references that point at the wrong row or contradict the row's content,
- gate/table states that contradict success-criteria checkboxes (checked boxes must be supported; unchecked boxes must not be claimed done in prose),
- stale sentences elsewhere in these documents that the edits made false (e.g. text still calling something pending that the edit closed, or vice versa).`,
  },
  {
    key: 'contract',
    prompt:
      COMMON +
      `
Lens: RELEASE-GATE CONTRACT. Extract the wish's own rules (decisions, QA criteria, supersession/status rules, "X may only close when Y" statements) from WISH.md and its ledgers, then verify the edits obey every one of them. Typical contracts: scoped verdicts must never be represented as broader authorization; supersession/closure flips require named passing evidence; external gates close only via the named external actor; untrusted components stay labeled untrusted. Also check any new ledger rows use the ledger's own column semantics coherently.`,
  },
]

phase('Verify')
const results = await parallel(
  LENSES.map(l => () => agent(l.prompt, { label: `verify:${l.key}`, phase: 'Verify', schema: FINDINGS, effort: 'high' }))
)

const all = results.filter(Boolean).flatMap((r, i) => r.findings.map(f => ({ ...f, lens: LENSES[i].key })))
const mustFix = all.filter(f => f.mustFix)
log(`${all.length} findings (${mustFix.length} must-fix) across ${results.filter(Boolean).length}/3 lenses`)
return { mustFixCount: mustFix.length, findings: all }
