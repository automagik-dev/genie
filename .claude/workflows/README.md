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
| `docs-audit` | Audits every documentation surface against the live product — one docs-home reader, four read-only surface auditors, one cross-surface consolidator, and a ranked drift table; assess-only. `args`: `{focus?, surfaces?, quorum?, model?, timestamp?}`. |
| `observability-review` | Weekly Claude Code observability review over the cc-* Phoenix projects `scripts/observability/backfill.ts` writes — one reader measures the eight `code-annotator/v1` session annotations, one diagnostician names findings with session/trace/span evidence ids, one proposer drafts rule changes against the rules file, and the script drops any proposal citing an id no finding cited; proposal-only, never edits a file or writes to Phoenix. `args`: `{phoenix, rulesPath, projectPrefix?, since?, timestamp?}` (endpoint, rules path and cc-* prefix always arrive through args). |
| `pm-ledger-verify` | Three adversarial lenses over uncommitted wish-ledger edits. `args`: `{wishDir, evidenceFile?, repoRoot?}`. |
| `research-sweep` | Investigates a frozen question against a frozen source list — one planner shards by source, a bounded reader fan-out returns cited findings under the research injection fence, one synthesizer merges them, and a mechanical citation gate keeps every claim traceable; read-only. `args`: `{question, sources[], notesHint?, maxReaders?, model?, timestamp?}`. |
| `skill-audit-sweep` | Sweeps the shipped skill catalogue — one signals reader, three or four characterizer shards, one consolidating judge, and a rendered keep/improve/update/merge/retire table; assess-only. `args`: `{focus?, skills?, searchPass?, skillsDir?, shardCount?, quorum?, model?, timestamp?}`. |
| `wish` | Delivers ONE decided task end to end — read-only scout and blind judge admit or refuse it (script-side size band, consequence denylist, injection fence), one executor in a real worktree, a mechanical gate, a different read-only reviewer against the exact SHA, a bounded repair loop, one allowlisted publisher that opens the PR and reads the remote back; merge stays with the operator. The scout and the reviewer run the mikro offload first (`scripts/mikro/call.ts` → `wish-context`, `review-prep`; DeepSeek 4.1 Flash, ~$0.01 a call, every citation verified) and report it under `mikro`. `args`: `{objective, issue?, context?, slug?, base?, repairBudget?, model?, timestamp}`; states `merge-ready \| pr-open \| refused \| blocked \| missed`. `model` is spread only when pinned (catalog deviation on purpose, #2921). |
| `workfly` | Discovers a procedure and builds its saved workflow — three readers, one SPEC, a drafted script, then the static test plus two refuters with bounded repair. `args`: `{objective, sources?, name?, catalogDir?, model?, maxRepairs?, timestamp?}`. |

The static half of this contract is enforced by `scripts/workflows-meta.test.ts`.

## Measured runs

Token bills recorded so the break-even rule (convert a stage only when its agents consume or
produce more evidence than their own CLAUDE.md/AGENTS.md injection costs) rests on numbers:

| Run | Workflow | Agents | USD | API calls | Subagent tokens | Wall clock | Result |
|-----|----------|--------|-----|-----------|-----------------|------------|--------|
| `wf_a48db0e8-339` (2026-09-15) | council (skills-to-workflows, Opus) | 6 | — | — | 716k | 13 min | proceed-with-conditions |
| `wf_c9209af9-91b` (2026-09-15) | workfly building `skill-audit-sweep` (Opus) | 16 | — | — | 1.39M | 42 min | script drafted, static gate green, 4 script findings landed by hand |
| `wf_dd37d1db-bf6` (2026-09-16) | skill-audit-sweep, first live run (Opus) | 6 | — | — | 361k | 6 min | ok, 20/20 judged, report in `.genie/wishes/workflows-catalog/` |
| `wf_8dcc346c-59a` (2026-09-16) | docs-audit, first live run (Opus) | 6 | — | — | 454k | 9 min | ok, 4/4 surfaces, report in `.genie/wishes/workflows-catalog/` |
| `wf_ed316125-671` (2026-09-16) | research-sweep, first live run (Opus) | 5 | — | — | 316k | 5 min | ok, 3/3 readers, external URL fetched, report in `.genie/wishes/workflows-catalog/` |
| `wf_93b90188-3d0` (2026-09-16) | workfly building `wish` (Opus) | 16 | — | — | 1.74M | 59 min | script drafted, static gate green, 4 blocking refuter findings landed by hand and re-verified |
| `wf_f0fbb70a-b4f` (2026-09-16) | wish, dry run B: denylisted path (session model) | 2 | — | — | 110k | 1.4 min | `refused` / route `plan`; estimate 1 file / 3 ins / 1 unit; nothing created |
| `wf_d1251eed-383` (2026-09-16) | wish, dry run A: oversized rename (session model) | 2 | — | — | 152k | 7.3 min | `refused` / route `plan`; estimate 26 files / 110 ins / 5 units, over the 25-file and 3-unit maxima; nothing created |
| `wf_7218c974-893` (2026-09-16) | wish, first live run: issue #2921 (session model) | 4 + 6 (3 replayed) | — | — | 284k + 192k | 6.4 + 10.9 min | attempt 1 `missed` at Gate (the gate agent backgrounded `bun run check` and returned nothing; prompt now says foreground under a timeout); resume adopted the same commit → `merge-ready`: PR #2932, 13/13 checks, review SHIP 11/11 criteria, darwin six tolerated after base re-confirmation; estimate 5 files / 95 ins / 2 units vs real 5 / 117 |
| `wf_85e90108-e9a` (2026-09-17) | wish, fold observability into genie | — | 9.28 | 70 | 7.8M | 23.2 min | `blocked` on one advisory check; PR #2936, 11 files, 2,338 additions vs estimate 1,650 |
| `wf_e7f47170-980` (2026-09-17) | wish, wish self-optimization | — | 5.17 | 37 | 3.0M | 14 min | `merge-ready`: PR #2937, 4 files, +419/-8 vs estimate 560 |
| `wf_be0903ef-7b3` (2026-09-17) | wish, observe-skill bundle + fixes | 2 | — | — | — | ~3 min | `refused` / route `plan`; denylist `scripts/release-*` matched scripts/release-docs.test.ts |
| `wf_8491beac-ef6` (2026-09-17) | wish, observe fixes only | 2 | — | — | — | ~72 s | `refused` / route `plan`; 9 units over the maximum 3 |
