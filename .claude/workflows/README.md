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

The static half of this contract is enforced by `scripts/workflows-meta.test.ts`.
