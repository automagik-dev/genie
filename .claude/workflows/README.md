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
| `skill-intake` | Assesses a directory of candidate skills that are NOT in the shipped catalogue — one deterministic facts reader, an optional cheap closest-shipped cross-check (default on at 15+ candidates), one to five purpose-grouped characterization shards that treat candidate files as untrusted data, one consolidating judge that assigns exactly one disposition per candidate from ABSORB \| MERGE \| IMPROVE-EXISTING \| PERSONAL \| DROP with target and refine notes, and a rendered table with cross-candidate clusters and a landing order; assess-only, mutates nothing. `args`: `{candidatesDir, candidates?, shippedDir?, priorRanking?, overlapPass?, shardCount?, quorum?, model?, timestamp?}` — only `candidatesDir` is required, `priorRanking` is withheld from the shards and reaches the judge labelled as one opinion, and the worst case is nine agents (1 facts + 1 overlap + 5 shards + 1 judge + 1 re-state). |
| `wish` | Delivers ONE decided task end to end — read-only scout and blind judge admit or refuse it (script-side size band, consequence denylist, injection fence), one executor in a real worktree, a mechanical gate, a different read-only reviewer against the exact SHA, a bounded repair loop, one allowlisted publisher that opens the PR and reads the remote back; merge stays with the operator. The scout and the reviewer run the mikro offload first (`scripts/mikro/call.ts` → `wish-context` with `--facts auto` — the deterministic facts file, opt-in per agent — and `review-prep` without it; DeepSeek 4.1 Flash, ~$0.01 a call, every citation verified) and report it under `mikro`. `args`: `{objective, issue?, context?, slug?, base?, repairBudget?, model?, gateModel?, publishModel?, timestamp}`; states `merge-ready \| pr-open \| refused \| blocked \| missed`. `model` is spread only when pinned (catalog deviation on purpose, #2921), and `gateModel`/`publishModel` let the two mechanical stages (the gate, the publisher) run on a cheaper runtime than the reasoning ones — unset, each inherits `model`, so an existing caller is unaffected. |
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
| `wf_7b7527bc-ae7` (2026-09-18) | wish, R2 arm A attempt 1: issue #2941 (opus; gateModel haiku; publishModel sonnet; mikro offload on) | 6 | 5.03 | 77 | 418k | 19.6 min | `missed` at Gate on a HOST trap, not the change: two file-mode tests assume umask 022 and this host inherits 0077 (`codex-project-mcp.test.ts:249`, `atomic-fs.test.ts:365`); review SHIP 10/10; repair correctly `unable` (environment outside the declared set); scout offload returned prose twice ("no JSON object") on the long intent and was carried as absent |
| `wf_57ffc022-cd0` (2026-09-18) | wish, R2 arm A attempt 2: same objective (opus; gateModel haiku; publishModel sonnet; offload on) | 6 | 4.33 | 52 | 412k | 21.6 min | `merge-ready`: PR #2959, 18/18 checks, review SHIP 11/11; offload ok on both stages (scout $0.040 / 98 s carried 9 facts, review $0.039 / 97 s carried 4); per stage: scout 1.06, judge 0.46, executor 1.41, gate (haiku) 0.13, review 0.98, publish (sonnet) 0.28 |
| `wf_54f37c71-f20` (2026-09-18) | wish, R2 arm B (control): same objective, model opus on EVERY stage, offload made unavailable (scratch copy of this script with `MIKRO_CALL='false'`) | 6 | 4.77 | 42 | 395k | 17.1 min | `merge-ready`: PR #2961 (closed as the control; #2959 ships), review SHIP; per stage: scout 1.07, judge 0.57, executor 0.98, gate (opus) 0.84, review 0.65, publish (opus) 0.67. Reading: the $0.44 saving of arm A2 is the stage models (gate −0.71, publish −0.39); the offload saved nothing on scout (1.06 vs 1.07), cost more on review (0.98 vs 0.65, 8 calls vs 4) and added ≈3.3 min of wall clock; n = 1 per arm and executor variance alone is ±0.4 — a Patch-lane issue is below the offload's break-even, the stage models are not |
| `wf_225422f0-dbe` (2026-09-18) | wish, R2 follow-on arm F: issue #2920 on base `integration/overnight-0918` (opus; gateModel haiku; publishModel sonnet; offload on WITH `--facts auto`) | 6 | 6.17 | 80 | 514k | 22.6 min | `merge-ready`: PR #2969 (2 files, estimate 55 ins, real 111), review SHIP; the scout's flash call with the facts file: ok first attempt, $0.02 / 47 s / 40 fact candidates (arm A2 without facts: $0.040 / 98 s); per stage: scout 1.33, judge 0.47, executor 2.51, gate 0.23 haiku, review 1.25, publish 0.39 sonnet |
| `wf_995fe53a-4cd` (2026-09-18) | wish, R2 follow-on arm C (control): same objective, same stage models, offload made unavailable (scratch copy with `MIKRO_CALL='false'`) | 6 | 5.94 | 70 | 462k | 21.8 min | `merge-ready`: PR #2970 (closed as the control), review SHIP (2 files, estimate 45, real 77); per stage: scout 1.40, judge 0.63, executor 2.12, gate 0.17 haiku, review 1.22, publish 0.39 sonnet. Reading F vs C: the facts-backed offload halves the FLASH call but moves the Opus scout by −$0.07 (1.33 vs 1.40, inside noise) and the review by +$0.03; the total differs by executor variance (2.51 vs 2.12). At Patch lane the offload does not pay with or without the facts file (n = 1 per arm) |
| `wf_dfee11f7-177` (2026-09-18) | wish, R2 Task-lane arm F: issue #2919, three sub-fixes over 4 files, base `integration/overnight-0918` (opus; gateModel haiku; publishModel sonnet; offload on WITH `--facts auto`) | 6 | 8.32 | 92 | 531k | 28.1 min (two passes) | `merge-ready`: PR #2974 (4 files, estimate 70 ins, real 110), gate 2833/0. FIRST PASS ENDED IN A FALSE `blocked`: the reviewer returned `diffFiles` as absolute worktree paths and the script counted each as "path outside the repository" (fixed in #2973); resumed from cache with the fixed script, only the publisher ran. Offload: scout's wish-context ok on attempt 2 ($0.06, 127 s, 14 facts used; attempt 1 = "no JSON object in the answer"), review-prep ok ($0.01, 38 s). Per stage: scout 2.84 (31 calls), judge 0.52, executor 3.31, gate 0.17 haiku, review 1.05, publish 0.43 sonnet |
| `wf_98323684-c77` (2026-09-18) | wish, R2 Task-lane arm C (control): same objective, same stage models, same fixed script, offload made unavailable (`MIKRO_CALL='false'`) | 6 | 9.77 | 116 | 561k | 32.4 min | `merge-ready`: PR #2975 (closed as the control), review SHIP (4 files, estimate 75, real 88); per stage: scout 3.06 (34 calls), judge 0.52, executor 4.30 (57 calls), gate 0.16 haiku, review 1.33, publish 0.40 sonnet. Reading F vs C: the first pair where the offload arm is cheaper — −$1.45 (−15 %) in total, but only −$0.50 of it sits in the two stages that consume the offload (scout −0.22, review −0.28); the other −$0.99 is the executor, which never calls mikro and has moved ±$0.4 between identical arms before. At Task lane the offload is at best a ≈ 5 % saving on a ≈ $9 run (n = 1 per arm); the scout's bill doubles from Patch to Task lane ($1.3 → $3.0) with or without it, so the scout's own reading — not its discovery — is still the cost |
| `wf_c6661ffe-5f5` (2026-09-18) | council (intake of 38 personal skills, Opus; evidence from seven hand-dispatched Opus characterizer shards, 968k tokens) | 6 | — | — | 735k | 7.9 min | `revise`: 1 held ABSORB / 19 merge / 6 improve-existing / 11 personal / 1 drop; report in `.genie/wishes/skill-intake/` |
| `wf_763e94be-8d1` (2026-09-18) | workfly building `skill-intake` (Opus, maxRepairs 2) | 16 | — | — | 1.68M | 40 min | script drafted, static gate green, `ok: false` with 4 blocking script findings after two repair rounds (non-string roster coercion, unreachable ABSORB re-state fields, truthy-string overlap flag, closing-line order) — all four landed by hand, not re-verified by the refuters |
| `wf_a971e4f3-62c` (2026-09-18) | skill-intake, first live run (Opus; 6 candidates staged in a gitignored brainstorm dir, `overlapPass: false`) | 3 | — | — | 241k | 7.4 min | ok, 6/6 judged, 0 rejected rows, 4 injection attempts quoted and none followed (two third-party installer lines, one system-package override, one permission-bypass flag); against the 2026-09-18 council over the same six it agreed on 3 (`spike` merge, `github-issue-to-pr` into wish, `codebase-inspection` drop) and was more absorb-prone on 2 (`human-conversation` and `safe-shell-cli-payloads` ABSORB where the council ruled PERSONAL and MERGE 5/5) and stricter on 1 (`sketch` PERSONAL vs a one-rule merge) — the single judge is a proposal, the council stays the decision |
