# Genie workflow catalog

This directory is genie's canonical, git-tracked catalog of saved workflows. Every
file here is a Claude Code Workflow script and runs unmodified on any body that
honours this contract: Claude Code natively (project scope), and a DSH body through
the `dsh-workflow-fork` executor, which reads this same directory.

## Contract

- One workflow per file, named `<name>.js`. The file starts with a pure-literal
  `export const meta = { name, description, whenToUse?, phases? }` and `meta.name`
  equals the filename stem. No variables, calls, spreads or interpolation in `meta`.
- The body is plain JavaScript (no TypeScript syntax) using the bare globals
  `agent`, `parallel`, `pipeline`, `phase`, `log`, `workflow`, `budget` and `args`.
  Top-level `await` and a top-level `return` are the contract.
- Everything the script needs arrives through `args`: paths, slugs, timestamps,
  entropy. Never stamp an absolute path into a script; the retired
  `~/.claude/workflows/council.js` died that way.
- Forbidden: `import`, `require`, filesystem or process access, timers,
  `Date.now()`, `Math.random()`, argless `new Date()`. All IO happens inside agents.
- `agent()` returns `null` when the subagent fails or is skipped. Filter with
  `.filter(Boolean)` and report what did not respond; never average it in.
- `workflow()` nests one level only.
- Structured results use `schema`; a schema needs `{type: 'object', properties}` at
  the root and `required ⊆ properties`.

## Discovery

Claude Code discovers project scope (`<repo>/.claude/workflows/<name>.js`) and user
scope (`~/.claude/workflows/<name>.js`). Which one wins when both carry the same
name is not documented, and a 2026-09-15 probe in this repo resolved the name
`council` to the stale user copy, so never rely on shadowing: keep names unique
across both scopes, invoke by explicit path when in doubt, and delete a stale
`~/.claude/workflows/council.js` left by the old stamped install (its lens root is
dead; deleted on the dogfood host 2026-09-15). Skills share the slash namespace
with workflows: the `council` skill is deliberately the front door that runs this
workflow and carries no lens roster of its own (`scripts/council-workflow-parity.test.ts`).

## Entries

| Workflow | Purpose |
|----------|---------|
| `council` | Five independent lenses (architecture, delivery, product, security, dissent) plus a synthesis; assess-only. `args`: a decision string or `{decision, constraints?, evidence?, unknowns?}`. |
| `pm-ledger-verify` | Three adversarial lenses over uncommitted wish-ledger edits. `args`: `{wishDir, evidenceFile?, repoRoot?}`. |
| `skill-audit-sweep` | Sweeps the shipped skill catalogue — one signals reader, three or four characterizer shards, one consolidating judge, and a rendered keep/improve/update/merge/retire table; assess-only. `args`: `{focus?, skills?, searchPass?, skillsDir?, shardCount?, quorum?, model?, timestamp?}`. |
| `workfly` | Discovers a procedure and builds its saved workflow — three readers, one SPEC, a drafted script, then the static test plus two refuters with bounded repair. `args`: `{objective, sources?, name?, catalogDir?, model?, maxRepairs?, timestamp?}`. |

The static half of this contract is enforced by `scripts/workflows-meta.test.ts`.

## Measured runs

Token bills recorded so the break-even rule (convert a stage only when its agents consume or
produce more evidence than their own CLAUDE.md/AGENTS.md injection costs) rests on numbers:

| Run | Workflow | Agents | Subagent tokens | Wall clock | Result |
|-----|----------|--------|-----------------|------------|--------|
| `wf_a48db0e8-339` (2026-09-15) | council (skills-to-workflows, Opus) | 6 | 716k | 13 min | proceed-with-conditions |
| `wf_c9209af9-91b` (2026-09-15) | workfly building `skill-audit-sweep` (Opus) | 16 | 1.39M | 42 min | script drafted, static gate green, 4 script findings landed by hand |
| `wf_dd37d1db-bf6` (2026-09-16) | skill-audit-sweep, first live run (Opus) | 6 | 361k | 6 min | ok, 20/20 judged, report in `.genie/wishes/workflows-catalog/` |
