<!-- wishes-lint:ignore -->
<!-- Group 0 evidence record, not a wish: this is the comparison `WISH.md` names as Group 0's first
     deliverable, so the wish-structure rules (header table, Execution Strategy, card graph) do not
     apply to it. The bailout is the linter's documented one. -->

# Group 0 — seam comparison: load over DSH's first-party `ctx.workflowEngine`, or fork `dsh_workflow`

| Field | Value |
|-------|-------|
| **Date** | 2026-09-19 |
| **Author** | Sofia (DSH body) for Felipe |
| **Host** | `khal-labs`, profile `web` |
| **Recorded host version** | `dsh --version` → `0.1.5-rc.2` |
| **Method** | live probes against the running host, plus a static audit of all nine catalog scripts; no catalog file was modified |
| **Route decided** | **Loader over the first-party engine** (§5); the fork stays the fallback (§5, triggers) |

This document is Group 0 of `dsh-workflow-fork`: deliverables 1 (hook-by-hook comparison), 2 (spike
record), 3 (host version and floor decision) and 4 (the chosen route, also recorded in `WISH.md`).

---

## 1. Host and floor decision (deliverable 3)

`dsh --version` on the target host reports **`0.1.5-rc.2`**, running the `web` profile.

- `plugins/dsh-genie-board/package.json` declares `dsh.engines.dsh: ">=0.1.2-rc.1"`.
- `0.1.5-rc.2` already satisfies that floor, so **no host upgrade and no lowered floor are needed**.
  Decision 6's either/or resolves to neither branch.
- Recommendation (not executed in this spike): re-run `scripts/dsh-genie-board-smoke.ts` as the standing
  check after any host bump. The smoke needs a live profile with the board installed; it was not run here,
  so this document records the version, not its result.

## 2. Hook-by-hook comparison (deliverable 1)

Columns: what a catalog script uses; what the first-party engine offers at `0.1.5-rc.2`; the evidence; and
the cost of closing the gap on each route. The upstream column is the 2026-09-15 analysis recorded in
`WISH.md` — **the upstream plugin was not fetched or run in this spike**.

| Claude Code hook | First-party engine at 0.1.5-rc.2 | Evidence | Loader-route cost | Fork-route cost |
|---|---|---|---|---|
| `export const meta = {...}` in the file | **Rejected at parse.** `Error: workflow meta rides the `meta` request field, not the script: remove the `export const meta = {...}` statement from the body` | executed probe `meta-export-rejection-probe` | Split it off the body and pass it as `meta` — one transform, ~30 lines | Same transform (`src/claude-dialect.ts`), already planned |
| `agent(prompt, { schema })` | **Supported.** JSON Schema, object-rooted | catalog run: `council` 6 agents; `spawn` provider advertises `outputSchema: true` | none | none |
| `agent(..., { model })` | **Supported** (with `provider`) | tool contract; 41 uses across the catalog | none | none |
| `agent(..., { effort })` | **Rejected loudly.** `WorkflowError: agent() option "effort" is deferred and not supported by this engine (supported: label, phase, schema, provider, model)` | executed probe `effort-rejection-probe` (0 agents started) | Drop-with-warning, or map to a tier at spawn. 41 sites in 7 files, mechanical | Soft-hint adapter (already planned as Group 3) |
| `agent(..., { isolation: 'worktree' })` | **Rejected** (documented contract; not executed here) | `dsh-tool-workflow` contract lists accepted options | Refuse-with-error when present (fail closed) | `src/adapters/git-worktree.ts` (planned, larger) |
| `agent(..., { agentType })` | **Rejected** | same contract | Drop-with-warning | Deferred in the wish already |
| `parallel()`, `pipeline()` | **Supported**, same `(prev, item, index)` shape and null-on-throw semantics | `parallel` used in the catalog run; engine source `vm.Script("(async () => {\n" + body + "\n})()")` | none | none |
| `phase()`, `log()` | **Supported** (title string / message) | catalog run narrates phases | none | phase-marker bridge (planned) |
| `workflow()` (nested) | **Absent** — `typeof workflow === 'undefined'`; one-level nesting is a documented non-feature | executed probe `engine-surface-probe` | Refuse, or implement one level by re-entry — small but real | Guest shim (planned) |
| `budget()` | **Absent** — `ReferenceError: budget is not defined` | executed probe `budget-absence-probe` | Ignore/refuse; **0 uses in the catalog** | Guest shim (planned) |
| Clock ban (`Date.now`, `Math.random`, argless `new Date`) | **Not enforced.** `Date.now()` → `1789781356113`, `new Date().toISOString()` → `2026-09-19T01:29:16.113Z`, `Math.random()` → `0.244…` | executed probe `engine-surface-probe` | none to run; determinism must be enforced by conformance/review because the runtime will not | QuickJS bootstrap bans it |
| Catalog discovery (project + personal roots, shadowing) | **Absent** — DSH has no workflow registry and no `dsh workflow` subcommand; a script is a per-call tool argument | `dsh --help` shows only `web` and `plugin` commands | Implement both roots + the collision rule — the loader's main new surface | `src/catalog.ts` (planned) |
| Resume | **Absent** — documented no journaling/resume; the consumer writes four log-only session events (run-start, member starts/ends, run-end) | `dsh-workflow` contract "Known Limitations" | Journal *results* outside the run root; run-resume is not available on either route | Same class of gap |
| **Result delivery cap** (new finding, not in the wish) | **`maxResultChars` 50000 on the model-facing projection.** A run returning more loses its **tail**; the session log keeps only the same capped projection | the recorded `council` run: ~190 KB rendered result → the caller received the five lens sections and **lost the synthesis block** (decision, consensus, dissent, conditions, next action) | Journal the full result to disk and return a bounded projection — this is the "run driver writing normalized journals outside the DSH run root" already in the wish's IN list | Same cap applies; the fork inherits it |

The seven hooks the engine lacks are exactly the ones the catalog does not use, with two exceptions that
the loader must handle on every run: the `meta` split (always) and `effort` (7 of 9 files).

## 3. Spike record (deliverable 2)

**What the spike did.** Read `<catalog>/council.js`, split `export const meta` off the body into the
`meta` request field, and submit `{meta, script, args}` to the engine through its model-facing consumer
(`dsh-tool-workflow` over `ctx.workflowEngine`). The split is done with a TypeScript-AST parse
(`typescript` 5.9.3): the meta object is lifted, `effort` properties are removed from `agent()` **options
objects only**, and the transformed body is compile-checked before submission.

**Outcome: it runs.** `workflow "council" completed (6 agents)` — five lenses in parallel plus one
synthesizer, returning `decision: gather-evidence` with all four reporting lenses at
`support-with-conditions` (medium). No engine failure.

**Where it fails.** Nowhere for `council`. Two transforms are mandatory, and each absent hook fails with
a specific, recorded error rather than silently degrading (§2): `export const meta` at parse; `effort` at
the first `agent()` call; `budget`/`workflow` as `ReferenceError`/`undefined` if a script ever calls them.

**Catalog-wide result.** All nine scripts transform, compile and lint clean:

| Script | `effort` sites removed from `agent()` options | `effort` keys kept as data | Runs tonight |
|---|---|---|---|
| `council` | 0 | — | ✅ 6 agents |
| `observability-review` | 0 | — | — |
| `pm-ledger-verify` | 1 | — | — |
| `docs-audit` | 3 | 4 (`SURFACES` entries) | — |
| `research-sweep` | 4 | — | — |
| `skill-audit-sweep` | 4 | 4 | — |
| `skill-intake` | 5 | 8 | — |
| `wish` | 9 | — | — |
| `workfly` | 9 | 16 (`effort: enumOf([...])`, `effort: str` schema fields) | — |

The data/option distinction is not cosmetic: `workfly.js` and `docs-audit.js` define **schema fields named
`effort`**. A text-level transform deletes them and silently changes the contract the run depends on; the
AST transform preserves them, which is why the spike uses a parser instead of a regex.

**Second probe.** `workflow "engine-surface-probe" completed (0 agents)` captured the global surface and
the clock behaviour quoted in §2.

## 4. Catalog feature audit

Occurrences across the nine scripts (`grep -oE` counts): `budget(` 0 · `workflow(` 0 · `isolation` 0 ·
`agentType` 0 · `disallowedTools` 0 · `bashCommandClamp` 0 · `Math.random` 0 · `Date.now` 0 · `new Date` 0 ·
`'haiku'`/`'sonnet'`/`'opus'`/`'fable'` 0. Agent options actually used: `model:` 41, `effort:` 41.

So the fork's distinguishing machinery — QuickJS guest, `budget`/`workflow` shims, worktree isolation
adapter, model-alias map, clock ban — covers **zero current catalog usage**, while the two options the
catalog does use (`model`, `effort`) need one passthrough and one transform respectively.

## 5. Route decision (deliverable 4)

**Chosen: a thin loader over DSH's first-party `ctx.workflowEngine`, as an in-repo genie DSH plugin next
to `plugins/dsh-genie-board`** (same bun build, same DSH floor, same tarball) — the expected outcome
recorded in the wish.

Reasons, in order of weight:

1. The catalog needs only the `meta` split plus one `effort` policy; everything else it uses
   (`agent`+`schema`+`model`, `parallel`, `phase`, `log`, `args`) is already first-party.
2. The `spawn` provider already advertises `agentOptions`, `outputSchema`, `depthLimit`, `persona`,
   `toolFilter` and `prepareContinuable` — so Group 1's capability assertion (`outputSchema` /
   `depthLimit`) is **answered in advance**: no new subagent seam is required.
3. The fork's extra machinery covers zero current catalog usage (§4).
4. The one genuine gap — result delivery past the 50k projection cap — is solved in the loader's journal
   writer, which the wish already scopes, and is **not** solved by the fork at all (it is the consumer's cap).
5. A loader keeps `council.js` canonical and unmodified on disk, which is the wish's own kill criterion.

**Where the fork is still the right answer** (triggers, unchanged): a script that needs
`isolation: 'worktree'`, nested `workflow()`, `budget`, a runtime-enforced clock ban, or a model-alias map
for names DSH rejects. Each is a fail-closed refusal in the loader today, so the trigger surfaces as an
explicit error rather than a silent semantic difference.

**Re-plan implications for Groups 1–3** (the wish requires re-planning against the seam):
Group 1 (fork bootstrap, private-snapshot detachment, exact-version pins) becomes **unnecessary**;
Group 2 (dialect) shrinks to meta extraction, the `effort` policy, and two-root discovery with the
shadowing/collision rule; Group 3 (adapters) shrinks to an explicit fail-closed policy for
`isolation`/`agentType` plus the journal writer; Group 4 (conformance) keeps the Claude Code goldens and
comparator but drops the QuickJS fixture matrix. `workflow()`/`budget` implementations stay deferred.

## 6. What this spike did not verify

- The upstream `omdsh-dev/dsh_workflow` plugin was not fetched, installed or run; its column in §2 is the
  2026-09-15 analysis already recorded in the wish.
- `scripts/dsh-genie-board-smoke.ts` was not run.
- Only `council` ran end-to-end with agents; the other eight scripts were transformed, compile-checked and
  linted, not executed.
- The `isolation` and `agentType` rejections are taken from the tool contract, not executed.
- Wide fan-out behaviour was not exercised: the 1000-agent ceiling, CPU-derived concurrency, the 4096-item
  `parallel`/`pipeline` cap, the 5 s synchronous-slice timeout and the 5 s dispose grace are read from the
  engine's configuration, not measured under load.
- No claim is made about Claude Code's own result-size limit; the 50k cap is the DSH consumer's.
