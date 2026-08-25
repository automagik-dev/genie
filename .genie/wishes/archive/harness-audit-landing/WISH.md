# Wish: Land the three-harness audit findings

| Field | Value |
|-------|-------|
| **Status** | SHIPPED — PR [#2752](https://github.com/automagik-dev/genie/pull/2752) merged to dev 2026-08-07 (all 3 groups done on the board, `b23c82d04`); header reconciled + archived 2026-08-24 |
| **Slug** | `harness-audit-landing` |
| **Date** | 2026-08-06 |
| **Author** | Fable 5 (council-validated: questioner, architecture, simplifier, perf — 2 rounds) |
| **Appetite** | small |
| **Branch** | `wish/harness-audit-landing` (to be created; the diffs currently sit uncommitted on `dev`) |
| **Repos touched** | genie |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Three audited contract repairs (schemaIsCurrent backfill skip, freshness handler prompt-injection channel, shortcuts uninstall heuristic) are finished, tested, and sitting uncommitted in the working tree. This wish lands them behind an attribution gate, closes the fourth broken contract (an unfenced `completeTask` that lets any caller complete another worker's claimed task), and deletes the dead wish-group state machine that TAXONOMY documents but nothing calls. A four-lens council deliberation (see `council-report.md` in this directory) converged unanimously on the three-group shape and the gate-zero precondition.

## Scope

### IN

- **Gate zero (precondition, not a group):** upgrade bun to >=1.3.10 (engines pin; local is 1.3.9), baseline clean HEAD in a temporary worktree (no stashing — see Group 1), then run the suite on the working tree. Only failures surviving both runs are findings; codex-delivery survivors are logged as a separate finding, not fixed here.
- **Group 1 — Land the ready fixes:** three separate commits with their existing tests (schemaIsCurrent backfill skip + importState marker-clear; freshness handler rework; shortcuts uninstall rewrite + new `shortcuts.test.ts`), then one PR. No hardening riders, no config flags.
- **Group 2 — completeTask CAS fence:** reconcile the claim-side and complete-side identity chains into one named identity source, then move the claim predicate into the UPDATE on `claimed_by`; typed error on zero changed rows mirroring `releaseFailure`; three-case acceptance test.
- **Group 3 — Asymmetric wish-group deletion:** delete the dead wish-group execution machinery by exact symbol list (below), the mcp-tools read branches, the `wish_groups` export/import code paths, and the state-machine prose in `src/lib/v5/TAXONOMY.md`; keep the `CREATE TABLE IF NOT EXISTS wish_groups` DDL (and its TAXONOMY column reference) inert with a vestigial-pending-drop note; `importState` tolerates-and-drops the legacy `wish_groups` snapshot key.

### OUT

- Dropping the `wish_groups` table from live DBs — a real schema migration under the same lockstep contract Group 1 repairs; deferred to a future migration wish.
- Root-causing the 13 codex-delivery test failures — unattributed observations from an unsupported runtime on a dirty tree; any survivors of gate zero become a separate trace task.
- Freshness-handler latency (hyperfine) baseline as a merge gate — logged as a separate observability follow-up; if captured, it rides as commit-lane evidence, never as a blocker.
- `group_name` on tasks — live at task-state.ts:369/388/487/1498 and launch.ts; explicitly untouched.
- `listWishSlugs` (including its `UNION … FROM wish_groups` read at task-state.ts:1167), `hasOperationalState`, and `wipeAllTables` — live code reading the surviving table; untouched.
- Any force/override knob on the completeTask fence — force-release-then-complete already composes from existing verbs.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Three independent groups, gate zero as shared precondition | A stall on either open finding must never hold the finished fixes hostage; every "verified" claim so far was produced under bun 1.3.9 on a dirty tree, so landing needs a clean-runtime receipt first (council unanimous). |
| 2 | Fence column is `claimed_by`; the final SQL is an output of the identity reconciliation, not an input to it | `assignee` exists only on the wish_groups DDL; the tasks table's claim column is `claimed_by` (genie-db.ts:518 in the working tree). Plan review proved that pinning the predicate before reconciling identity sources produces SQL that refuses the default CLI flow. |
| 3 | One identity source for claim and complete | `claimed_by` is written from `claimTask`'s `worker` (`opts.worker ?? GENIE_AGENT_NAME ?? 'cli'`, v5-task.ts:318) while the complete side resolves `resolveEventAuthor().author` (`GENIE_AGENT_NAME ?? GENIE_AGENT_ID ?? null`, v5-task.ts:284) — two different fallback chains. The sole production caller (v5-task.ts:253) always passes the author wrapper; "authorless" therefore means `author?.author == null`, not a missing parameter. Group 2 must normalize both sides to a single resolver before writing the fence, so that plain `genie task checkout` → `genie task done` (no env vars, claimed_by='cli') still completes. |
| 4 | Hyperfine baseline is not a merge gate | Three of four council lenses judged it scope inflation on a finished diff; the underlying observability gap is real and is logged as a follow-up instead of silently dropped (perf's dissent preserved in council-report.md). |
| 5 | Wish-group provenance check is a quick `.genie/` grep for in-flight dependents, not archaeology | Majority position: git history keeps the origin story either way; the only load-bearing question is whether any SHIP-ready plan depends on wiring the machinery, and a grep answers it. |
| 6 | Deletion is asymmetric: code dies by exact symbol list, table DDL and its column docs stay inert | Dead TypeScript is free to delete; the table sits inside the versioned schema, and dropping it is a live-DB migration entangled with the very schemaIsCurrent lockstep contract this wish fixes. The whole dead set goes — including `createWishGroups` and its validators, which are equally production-dead — with the four test files that import them reworked (export-parity seeds rows via direct SQL against the surviving table). |

## Simplicity Case

- **Simplest complete design:** commit three finished diffs as-is, move one predicate into one UPDATE statement reusing an idiom the module already implements twice (claimTask, releaseTask), and delete dead code. No new mechanisms anywhere.
- **Added machinery:** none. The fence is a WHERE clause plus a typed error shaped like the existing `releaseFailure`; the identity reconciliation removes a resolver, it does not add one.
- **Deferred until measured:** freshness-handler latency baseline (trigger: the follow-up observability task, or any observed hook-timeout incident); `wish_groups` table drop (trigger: a future schema-migration wish with its own compatibility plan).
- **Complexity removed:** the dead wish-group machinery (state machine, writers, validators, cycle detection, typed errors), guaranteed-empty per-call queries on the MCP wish-status path, one of two competing identity fallback chains, and the TAXONOMY prose that manufactures the impression of a supported feature.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] Gate-zero receipt recorded in the PR: `bun --version` >= 1.3.10, full suite run on a clean-HEAD temporary worktree and again on the working tree, with surviving failures (if any) logged as separate findings rather than fixed here.
- [ ] The three fixes land as three separate commits with their tests; PR opens with no scope riders.
- [ ] Group 2's identity reconciliation is documented (claim-side `worker` chain vs complete-side `author` chain, normalized to one named resolver) and predates the fence SQL in commit history.
- [ ] `completeTask` refuses a non-claimant's complete and an identity-less complete of a claimed task with a typed error, while plain `genie task checkout` → `genie task done` with no env vars still completes; the three-case acceptance test is green.
- [ ] `assertWishSignature`, `startWishGroup`, `completeWishGroup`, `promoteReadyGroups`, `getWishGroups`, `createWishGroups`, `computeGroupsSignature`, `wishSigKey`, `validateGroups`, `validateGroupRefs`, `detectGroupCycles`, and their wish-group typed-error classes no longer exist in `src/`; the `wish_groups` DDL remains with a vestigial-pending-drop comment and no schema version bump.
- [ ] `importState` accepts a legacy snapshot containing a `wish_groups` array without error and without inserting rows; `exportState` keeps emitting `wish_groups: []` and the key stays in `SNAPSHOT_TABLE_KEYS` — older binaries' `validateSnapshot` hard-fails on any missing listed key, so removing the field would break every old reader of new snapshots.
- [ ] `genieWishStatus`'s `groups` field is preserved as a literal `[]` (`WishStatusPayload`), and `resolveWishBranch`'s dropped wish-group branch is recorded as safe because production `wish_groups` is always empty (no production writer exists).
- [ ] `src/lib/v5/TAXONOMY.md` no longer contains the state-machine sentence (line 131) or the signature drift-guard paragraph (lines 146–149); the wish_groups column reference stays, annotated vestigial-pending-drop.
- [ ] Full repository gate green under bun >=1.3.10: `bun run check:fast && bun test`.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 2 — mechanical commit/PR lane, but it baselines and lands changes to the shared state engine (+2 stateful) | engineer-standard / medium | Run gate zero, then commit the three ready fixes as three commits and open the PR |

### Wave 2 (parallel, after Wave 1's gate-zero receipt)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | 4 — +2 stateful core engine, +2 subjective acceptance (identity reconciliation needs judgment before SQL) | engineer-complex / high | Identity reconciliation, fence, three-case test |
| 3 | engineer | 3 — +2 stateful (schema-adjacent deletion), +1 multi-surface (MCP wish-status contract, four test files) | engineer-standard / high | Asymmetric deletion of the wish-group machinery by symbol list, with contract preservation |

## Execution Groups

### Group 1: Land the ready fixes

**Goal:** Put the three finished audit fixes on a branch with a clean-runtime receipt, as three commits and one PR.

**Deliverables:**
1. Gate-zero receipt: bun >=1.3.10 installed; clean-HEAD baseline produced in a **temporary worktree** (`git worktree add <scratch> HEAD`, then `bun install` there — a fresh worktree has no `node_modules` — run the suite, `git worktree remove`) so the untracked `shortcuts.test.ts` and this wish directory are never stashed or run against the wrong sources; then the suite run in the real working tree; any surviving failures logged as new findings outside this wish.
2. Commit 1: schemaIsCurrent backfill-marker check + importState marker-clear, with genie-db.test.ts and task-state.test.ts additions.
3. Commit 2: freshness handler rework (bounded machine-shaped git output, trusted-executable gate), with freshness.test.ts changes.
4. Commit 3: shortcuts uninstall exact-snippet rewrite + queued prompt + new shortcuts.test.ts.
5. PR opened from `wish/harness-audit-landing` with the receipt in the body.

**Acceptance Criteria:**
- [ ] `bun --version` reports >=1.3.10 in the receipt.
- [ ] Clean-HEAD baseline comes from a temporary worktree, not a stash; only failures present in both runs are carried forward, as findings not fixes.
- [ ] Three commits, each scoped to exactly one fix plus its tests; `git show --stat` per commit demonstrates no cross-contamination.
- [ ] No new flags, options, or hardening riders appear in the diff.

**Validation:**
```bash
bun run check:fast && bun test
```
Scope: the diffs touch the shared v5 state engine (genie-db.ts, task-state.ts) and a hook handler — shared runtime/core behavior escalates to the repository full gate per this repo's documented policy.

**depends-on:** none

---

### Group 2: completeTask CAS fence

**Goal:** Make task completion honor the claim fence its own file documents, without regressing the default CLI flow.

**Deliverables:**
1. Identity reconciliation (in the PR or commit message, before any SQL): document the claim-side chain (`claimTask`'s `worker` = `opts.worker ?? GENIE_AGENT_NAME ?? 'cli'`, v5-task.ts:318) and the complete-side chain (`resolveEventAuthor().author` = `GENIE_AGENT_NAME ?? GENIE_AGENT_ID ?? null`, v5-task.ts:284), and normalize both to one named resolver so the same invocation environment yields the same identity on checkout and on done.
2. Fence in SQL on `claimed_by`, emitted from the reconciliation: intent is `WHERE id = ? AND status IN ('ready','in_progress') AND (claimed_by IS NULL OR claimed_by = <reconciled identity>)` — the exact bound value is defined by the reconciliation, with the adopted semantics: an identity-less call (`author?.author == null` under the unified resolver) completes unclaimed tasks only; completing a claimed task requires a matching identity; plain `genie task checkout` → `genie task done` with no env vars must still complete.
3. Typed error on zero changed rows, mirroring `releaseFailure`; no force/override knob.
4. Three-case acceptance test: two racing identities (one wins, one gets typed error); non-claimant refused; identity-less complete against a claimed task refused — plus the default-CLI regression case (checkout then done, no env, succeeds).

**Acceptance Criteria:**
- [ ] The reconciliation is documented and predates the SQL change in commit history.
- [ ] All acceptance cases pass, including the default-CLI regression case; existing task-state tests remain green.
- [ ] No raw SQLITE error and no silent success on the refused paths — refusals are typed.

**Validation:**
```bash
bun test src/lib/v5/task-state.test.ts src/term-commands/v5-task.test.ts && bun run check:fast && bun test
```
Scope: focused behavior tests on the changed module and its sole production caller first, then the full gate — the tasks table is shared core state consumed by CLI, MCP, and multi-process workers.

**depends-on:** ready-fixes

---

### Group 3: Delete the dead wish-group machinery

**Goal:** Remove the unwired wish-group execution machinery and its documentation while leaving the live schema and task grouping untouched.

**Deliverables:**
1. Precondition check: grep `.genie/` for any in-flight wish or brainstorm depending on wish-group orchestration; record the (expected-empty) result.
2. Deletion by exact symbol list, no line ranges: `assertWishSignature`, `startWishGroup`, `completeWishGroup`, `promoteReadyGroups`, `getWishGroups`, `getWishGroup`, `mapWishGroup`, `createWishGroups`, `computeGroupsSignature`, `wishSigKey`, `validateGroups`, `validateGroupRefs`, `detectGroupCycles`, the wish-group typed-error classes (`WishGroupStateError` and relatives), the `importState` insert branch for `wish_groups` (replaced by tolerate-and-drop), and the mcp-tools read branches (`resolveWishBranch` wish-group case, `genieWishStatus` group query). `WishGroupRow` survives — `WishStatusPayload.groups` still types against it.
3. Contract preservation: `genieWishStatus` keeps `groups: []` in `WishStatusPayload`; `exportState` keeps emitting `wish_groups: []` and `SNAPSHOT_TABLE_KEYS` keeps the key (older binaries' `validateSnapshot` hard-fails on missing listed keys); the `resolveWishBranch` behavior change is recorded as safe because no production writer exists so the table is always empty; `importState` tolerates-and-drops a legacy `wish_groups` snapshot array; `listWishSlugs` (with its UNION read at task-state.ts:1167), `hasOperationalState`, and `wipeAllTables` untouched.
4. Test rework: the four test files importing `createWishGroups` (src/lib/v5/task-state.test.ts, src/term-commands/mcp.test.ts, src/term-commands/ui-bridge.test.ts, src/term-commands/v5-task.test.ts) updated — the ui-bridge export-parity assertion seeds `wish_groups` via direct SQL against the surviving table (the exported field remains, empty).
5. Docs: `src/lib/v5/TAXONOMY.md` loses the state-machine sentence (:131) and the drift-guard paragraph (:146–149); the wish_groups column reference stays, annotated vestigial-pending-drop. DDL annotated the same; no schema version bump; `group_name` on tasks untouched.

**Acceptance Criteria:**
- [ ] No references to the deleted symbols remain in `src/` (tests included).
- [ ] A legacy snapshot with a `wish_groups` array imports cleanly with zero rows inserted; `exportState` emits `wish_groups: []`.
- [ ] `genieWishStatus` responses are shape-identical (`groups: []`); the `resolveWishBranch` semantics note is recorded.
- [ ] Schema version and `wish_groups` DDL unchanged; TAXONOMY column reference intact with the vestigial note.

**Validation:**
```bash
bun test src/lib/v5/ src/term-commands/ && bun run check:fast && bun test
```
Scope: targeted tests over the deletion's real blast radius (three of the four reworked test files live in `src/term-commands/`), then the full gate because knip/typecheck/biome (`noUnusedVariables: "error"`) must confirm the deletion left no dangling exports or orphans and the MCP surface is a cross-runtime contract.

**depends-on:** ready-fixes

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: `genie shortcuts install` then `uninstall` on a scratch HOME leaves rc files byte-identical; an edited block is refused with a warning, not guess-deleted.
- [ ] Functional: `genie task import` of a legacy snapshot (stage_log rows, no task_events) lands the history in the timeline on next open.
- [ ] Integration: two concurrent workers claim/complete — the non-claimant's `genie task done` is refused with a typed error message; a plain no-env checkout→done still succeeds.
- [ ] Integration: `genie mcp` wish-status responses parse identically for existing consumers (`groups` field present, empty).
- [ ] Regression: full gate (`bun run check:fast && bun test`) green on a fresh clone under bun >=1.3.10.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Some of the 13 codex-delivery failures survive gate zero on clean HEAD | Medium | They become a separate logged finding/trace task; this wish proceeds — they are explicitly OUT. |
| The unified identity resolver changes what `claimed_by` stores for existing rows | High | Reconciliation documents the migration story for in-flight claims (e.g., fence tolerates the legacy `'cli'` value) before the SQL lands; the default-CLI regression test locks the happy path. |
| An MCP consumer reads `WishStatusPayload.groups` | Low | Field is preserved as a literal `[]`. |
| The bun 1.3.9→1.3.10 upgrade itself shifts test outcomes | Low | Gate zero baselines clean HEAD under the new runtime before the working tree is measured. |

---

## Review Results

### Plan review #1 — 2026-08-06 — genie:reviewer — FIX-FIRST

- CRITICAL (Group 2): pinned fence SQL compared two identity namespaces — claim side writes `worker` (`opts.worker ?? GENIE_AGENT_NAME ?? 'cli'`, v5-task.ts:318), complete side binds `resolveEventAuthor().author` (`GENIE_AGENT_NAME ?? GENIE_AGENT_ID ?? null`, v5-task.ts:284) — refusing plain `checkout`→`done`. **Addressed:** Group 2 rebuilt around an identity reconciliation that precedes and emits the SQL; default-CLI regression case added; Decision 3 corrected (`author?.author == null`, sole production caller v5-task.ts:253 always passes the wrapper).
- HIGH (Group 3): cited line range 1036–1145 contained none of the named functions (they live at :1174–1266) while containing `createWishGroups` + validators the wish implicitly kept, though four test files import them. **Addressed:** deletion redefined by exact symbol list including `createWishGroups`/validators/cycle detection/typed errors; four-test rework named as a deliverable.
- MEDIUM (Group 1): stash-based baseline would run the untracked `shortcuts.test.ts` against un-stashed sources or delete this wish directory. **Addressed:** baseline pinned to a temporary clean-HEAD worktree; no stashing.
- MEDIUM (Group 3): TAXONOMY path was wrong (`src/lib/v5/TAXONOMY.md`) and the criterion would have deleted column docs for the retained table. **Addressed:** path corrected; deletion scoped to :131 and :147–149; column reference kept with vestigial note.
- LOW: `groups` lives on `genieWishStatus`/`WishStatusPayload` (mcp-tools.ts:328–339), not board/task responses; `resolveWishBranch` change is resolution-semantics, safe only because the table has no production writer — now recorded. Stale refs corrected (claimed_by DDL at genie-db.ts:518; branch does not exist yet — noted in header).
- Reviewer confirmations retained: working-tree diffs match the wish (7 modified + 2 untracked); 111/111 tests pass on the four affected files; `completeTask` UPDATE unfenced at task-state.ts:764–785; wish-group functions have zero production callers; `group_name` live; `createWishGroups` has no production caller so `wish_groups` is empty in production.

### Plan review #2 — 2026-08-06 — genie:reviewer — FIX-FIRST (narrow)

- Both round-1 blockers re-verified as genuinely fixed (identity chains cited correctly; symbol-list dependency closure coherent; worktree baseline sound; docs/naming corrections accurate).
- MEDIUM: dropping `wish_groups` from `exportState` would hard-fail older binaries — `SNAPSHOT_TABLE_KEYS` (task-state.ts:1436–1445) is enforced by `validateSnapshot` (:1457–1461) on every listed key. **Addressed:** export keeps emitting `wish_groups: []`, key stays in `SNAPSHOT_TABLE_KEYS`, mirroring the `groups: []` preservation.
- MEDIUM: keep-list named a phantom symbol (`knownWishSlugs`); real readers are `listWishSlugs` (:1161, UNION at :1167), `hasOperationalState` (:1478), `wipeAllTables` (:1583). **Addressed:** all three named untouched.
- LOW ×4, all addressed: test-file paths corrected to `src/term-commands/`; drift-guard paragraph is :146–149; Group 3 targeted validation widened to `src/lib/v5/ src/term-commands/`; `getWishGroup`/`mapWishGroup` added to the kill list with `WishGroupRow` explicitly surviving; `bun install` added to the scratch-worktree baseline.

### Plan review #3 — 2026-08-06 — genie:reviewer — SHIP

- All six round-2 deltas verified applied and correct against the repo (export query untouched by the narrowed kill list; `SNAPSHOT_TABLE_KEYS` satisfied both directions; keep-list symbols real; TAXONOMY :146–149 exact; validation scope covers all four reworked files; `bun install` in scratch worktree).
- Non-blocking executor note (recorded, no wish edit required): Deliverable 4's "seed via direct SQL" wording, followed literally, makes ui-bridge.test.ts:293–301's cross-comparison red by construction — after Group 3 the MCP side is a hardcoded `[]` while `exportState` reads the real table. The correct rework, dictated by the `groups: []` criterion: assert `groups` is `[]` and drop the cross-comparison rather than seeding rows. `bun test src/term-commands/` surfaces this on first run.
- Self-correcting orphans: `WishGroupDef` (task-state.ts:186) dies with its consumers; `WishGroupStatus` (:184) survives with `WishGroupRow`. biome `noUnusedVariables: "error"` + strict tsc inside `check:fast` catch either mistake deterministically.

---

## Files to Create/Modify

```
src/lib/v5/genie-db.ts              # already modified in tree (Group 1); vestigial DDL note (Group 3)
src/lib/v5/genie-db.test.ts         # already modified in tree (Group 1)
src/lib/v5/task-state.ts            # already modified in tree (Group 1); fence (Group 2); deletion (Group 3)
src/lib/v5/task-state.test.ts       # already modified in tree (Group 1); three-case test (Group 2); rework (Group 3)
src/term-commands/v5-task.ts        # unified identity resolver (Group 2)
src/term-commands/v5-task.test.ts   # default-CLI regression case (Group 2); rework (Group 3)
src/hooks/handlers/freshness.ts     # already modified in tree (Group 1)
src/hooks/handlers/__tests__/freshness.test.ts  # already modified in tree (Group 1)
src/term-commands/shortcuts.ts      # already modified in tree (Group 1)
src/term-commands/shortcuts.test.ts # new, untracked in tree (Group 1)
src/lib/v5/mcp-tools.ts             # wish-group read branches, groups: [] preservation (Group 3)
src/term-commands/mcp.test.ts       # rework (Group 3)
src/term-commands/ui-bridge.test.ts # export-parity rework (Group 3)
src/lib/v5/TAXONOMY.md              # state-machine prose removal, vestigial notes (Group 3)
.genie/wishes/harness-audit-landing/WISH.md          # this document
.genie/wishes/harness-audit-landing/council-report.md # council deliberation evidence
```
