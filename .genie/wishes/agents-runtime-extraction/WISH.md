# Wish: Agents Runtime Extraction

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `agents-runtime-extraction` |
| **Date** | 2026-04-21 |
| **Design** | _No brainstorm — direct wish_ (origin: `agent-row-unification` council deliberation 2026-04-21; see `_archive/agent-row-unification-rejected-2026-04-21/council-report.md` Finding #1 and architect's Round 1 + Round 2 positions) |

## Summary

Move runtime state columns (`pane_id`, `session`, `state`, `claude_session_id`, `window_id`, `window_name`, `sub_panes`, `suspended_at`, `resume_attempts`, `last_resume_attempt`, `pane_color`, `transport`, `current_executor_id`) off the `agents` table onto `executors`, completing what `src/db/migrations/012_executor_model.sql:3` explicitly promised but never delivered ("Slims: agents (to durable identity only)"). After this wish, `agents` is a cold identity table (write once at spawn, read for display); `executors` is the single source of truth for runtime state; turnClose and reconcile loops target a schema where "which row carries state?" is unambiguous by construction.

## Context

The `agent-row-unification` council (2026-04-21, full report preserved at `_archive/agent-row-unification-rejected-2026-04-21/council-report.md`) unanimously concluded that dual-row collapse addresses a symptom, not the root cause. The root cause is that `005_pg_state.sql:10-47` put 46 runtime columns on `agents`, and `012_executor_model.sql:11-33` later duplicated them onto `executors` with the stated intent of slimming `agents` — a slimming that never happened. Every subsequent wish (turn-session-contract, agent-row-unification) has been patching over this duplication. This wish is the actual fix.

This wish is the sequel to the minimalist predicate fix for turn-session-contract Gap #1 + Gap #2 (filed separately at `.genie/wishes/fix-turn-close-row-targeting/`) — that fix closes the immediate ghost-resume regression; this wish removes the architectural debt that made the regression possible.

## Scope

### IN
- Extract 13 runtime columns from `agents` onto `executors`, consolidating all current duplication
- Migration strategy: measurement-first. Baseline captured before any schema change. No code written until data justifies it.
- New helper `getAgentRuntime(agentId)` that reads from `executors` via `agents.current_executor_id` join
- Rewire reconcile loops (`scheduler-daemon.ts`, `agent-registry.ts`) to read runtime state from the executor, not the agent row
- Rewire spawn paths to write runtime state only to executors (`agents` row is identity-only post-spawn)
- Migration drops the now-unused runtime columns from `agents` in a final phase gated on soak
- Backwards compat contract: `agents.id` remains string (stable), all external consumers unaffected

### OUT
- The minimalist turn-close predicate fix (filed at `fix-turn-close-row-targeting/`) is prerequisite, not in scope
- Any dual-row collapse work (deferred indefinitely — council determined it may become unnecessary post-extraction)
- Web UI changes
- Executor schema changes beyond adding columns to receive the extracted state

## Decisions (placeholder — requires baseline data)

| ID | Decision | Rationale |
|----|----------|-----------|
| D1 | Baseline measurement precedes any code change | Council P0: "Data should justify the operation." Rejected wish failed because it asserted problems without cardinality data. |
| D2 | If baseline shows zero readers of `agents.state` outside the reconcile loops, extraction is a simple INSERT-shadow + DROP pattern, no flag required | Council P0: dual-PATH is worse than dual-row when the scope is small |
| D3 | `executors.agent_id` FK remains authoritative direction; `agents.current_executor_id` stays as reverse pointer for convenience | Preserves existing consumer expectations |

## Success Criteria (placeholder — finalized post-baseline)

Six core criteria, expandable to nine post-baseline:

- [ ] **C1** Baseline captured: for each runtime column, count of readers (grep `agents\.\<col\>` in `src/`), count of writers, avg writes/hour on production fixture
- [ ] **C2** Runtime columns present on `executors` with types matching current `agents` columns
- [ ] **C3** Every reader of `agents.<runtime_col>` rewritten to read from `executors` via join helper (grep returns zero matches post-change)
- [ ] **C4** Every writer of `agents.<runtime_col>` rewritten to write to `executors` instead
- [ ] **C5** Reconcile loops (`scheduler-daemon.ts:runAgentRecoveryPass`, `handleDeadPane`, `reconcileDeadPaneZombies`) read state from executor row
- [ ] **C6** Drop column migration: `agents` loses the 13 runtime columns; remaining columns are identity-only
- [ ] **C7** (conditional — only if baseline shows cross-team consumers) Stable read-helper exposed at `src/lib/agent-runtime.ts` and documented for external callers
- [ ] **C8** (conditional — only if baseline shows >100 live agents touched by reconcile/tick) Performance baseline shows equal or faster `agents` read latency post-extraction
- [ ] **C9** (conditional — only if council P1 observability minimums weren't merged separately) Golden signal `agents_runtime_column_read_count` gauge at zero post-migration (regression canary)

## Execution Strategy

**Wave 0 (before anything else):** Baseline. Zero code changes. Output: `.genie/wishes/agents-runtime-extraction/baseline.md` with column-reader/writer inventory, row count, peak write rate.

**Wave 1+:** populated after baseline. Council's warning: do not write execution groups before measurement.

## Execution Groups

### Group 0: Baseline measurement

**Goal:** Answer two questions with data before any code change: (1) where are the runtime columns read/written, (2) what's the production volume.

**Deliverables:**
1. `scripts/baseline-agents-runtime.ts` that greps source + queries live PG + produces a markdown inventory
2. `.genie/wishes/agents-runtime-extraction/baseline.md` committed with the output

**Acceptance Criteria:**
- [ ] Inventory lists every file:line that reads any of the 13 runtime columns
- [ ] Inventory lists every file:line that writes them
- [ ] Inventory records per-column row count and age distribution on dev + (if accessible) prod PG
- [ ] Output is committed to the wish dir

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bun run scripts/baseline-agents-runtime.ts && test -f .genie/wishes/agents-runtime-extraction/baseline.md
```

**depends-on:** none

---

### Groups 1–N: TBD

Populated after Group 0. Council's discipline: one wish per abstraction change; do not write execution groups before evidence.

Expected shape (provisional, to be validated against baseline):

- **Group 1** — schema migration: add 13 columns to `executors` (nullable, additive only)
- **Group 2** — dual-write (writes go to both agents + executors); measure read-match rate
- **Group 3** — flip readers to executors one at a time, with metrics per swap
- **Group 4** — stop writing to agents runtime columns; drop columns migration
- **Group 5** — cleanup: remove dual-write code, remove compat shims
- **Group 6** — soak + observability steady-state verification

Each group is a separate PR, revertible independently. No feature flag unless baseline shows external/unknown writers (council's rule from rejected wish).

## Dependencies

- **depends-on:** `fix-turn-close-row-targeting` — the minimalist fix that closes turn-session-contract Gap #1+#2. Ships BEFORE this wish begins.
- **depends-on:** `unified-executor-layer` (already merged) — established the `executors` table.
- **blocks:** follow-on wishes that would otherwise add more runtime columns to `agents`.

## QA Criteria

_Verified on dev after each group merges._

- [ ] No reader of `agents.<runtime_col>` remains in `src/` post-extraction (grep returns zero)
- [ ] Reconcile correctly identifies live/dead agents using only `executors.state`
- [ ] turnClose atomically flips `executors.state='done'` + `agents.current_executor_id=NULL`
- [ ] Spawn creates one identity row + one executor row; no runtime state written to agents row after spawn
- [ ] Column drop migration applies cleanly to fresh and populated DBs
- [ ] `bun run check` passes at every group boundary

## Assumptions / Risks

| ID | Risk | Severity | Mitigation |
|----|------|----------|------------|
| R1 | Baseline shows the runtime columns are read from many external/unknown callers (plugins, other repos) | MEDIUM | Group 0 output decides; if true, add compat shim + flag. If false, delete flag from scope. |
| R2 | Moving `current_executor_id` is more invasive than other fields (it's a FK) | MEDIUM | Keep `current_executor_id` on `agents` as reverse pointer; only move the true-runtime fields. Refine decision post-baseline. |
| R3 | Existing `agents.state` history is implicitly an audit trail for some observers | LOW-MEDIUM | Baseline surfaces this; if true, preserve via `audit_events` mirror before drop. |
| R4 | Migration runtime on DBs with many historic agent rows | LOW | Drop column is O(rows) but background-runnable; not online-blocking. |
| R5 | Council-identified over-engineering pattern recurs | HIGH | Explicit discipline: this wish's Group 1+ are unwritten until baseline (Group 0) produces data. No ceremony pre-planned. |

## Review Results

_Populated by `/review` after execution completes. First review is a plan-review after Group 0 completes — NOT before._

## Files to Create/Modify (provisional)

```
Will create:
  scripts/baseline-agents-runtime.ts
  .genie/wishes/agents-runtime-extraction/baseline.md
  src/db/migrations/NNNN_executors_add_runtime_cols.sql       (Group 1)
  src/db/migrations/NNNN_agents_drop_runtime_cols.sql         (Group 4)
  src/lib/agent-runtime.ts                                    (Group 3)

Will modify (partial, refined post-baseline):
  src/lib/agent-registry.ts            (reconcile reads from executors)
  src/lib/scheduler-daemon.ts          (reconcile + auto-resume read executors)
  src/lib/turn-close.ts                (already fixed by prerequisite wish; may need minor alignment)
  src/term-commands/agent/spawn.ts     (write runtime only to executors)
  src/__tests__/*                      (fixtures updated per Group 3)
```

## Council Acknowledgement

This wish owes its existence to the `agent-row-unification` council (preserved at `_archive/agent-row-unification-rejected-2026-04-21/council-report.md`). Specifically:

- **architect's** "wrong layer" diagnosis (Round 1 + Round 2)
- **questioner's** "data before migration" discipline applied via Group 0
- **measurer's** "baseline-before-approval" principle hardened into Decision D1
- **simplifier's** "delete the flag unless justified" applied via Decision D2
- **operator's** "name the tripwire" preserved via Success Criterion C9

If any decision here diverges from the council's converged recommendation, the divergence must be explicit in a Decision table row with rationale.
