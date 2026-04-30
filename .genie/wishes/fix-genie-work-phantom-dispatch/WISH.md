# Wish: Fix `genie work` phantom dispatch (#1589)

| Field | Value |
|-------|-------|
| **Status** | IMPLEMENTED |
| **Slug** | `fix-genie-work-phantom-dispatch` |
| **Date** | 2026-04-30 |
| **Author** | felipe (root cause), genie (wish + impl) |
| **Appetite** | small |
| **Branch** | `wish/fix-genie-work-phantom-dispatch` |
| **Repos touched** | `automagik-genie` |
| **Design** | _No brainstorm — direct wish driven by investigation in #1589_ |

## Summary

`genie work <slug>` advances PG state to `in_progress` but never spawns a real worker — the dispatched engineer either lands in the wrong worktree (the team's, not the wish's) or fails silently inside `awaitAgentReadiness`, leaving the wish blocked. This wish lands three surgical fixes: route wish dispatches into the wish worktree, make the spawn pipeline raise instead of warn on readiness timeout (with a dispatch-level event for visibility), and correlate `wish status` "Active Executors" by wish-slug instead of role-name match. Together they restore deterministic `/work` dispatch on `4.260430.23+` and unblock `tui-bottom-bar-opentui` (and every future wish).

## Scope

### IN

- Add a `cwd` override to `SpawnOptions` and have `dispatch.ts` pass the current working directory (the wish worktree) when invoking `handleWorkerSpawn` for wish dispatches.
- Make `agents.ts:2392-2395` honor `options.cwd` ahead of `teamConfig.worktreePath` so the wish worktree is not silently overridden.
- Emit a `wish.dispatch.work` audit event in `dispatch.ts:runWorkDispatch` immediately before `handleWorkerSpawn` so dispatch is visible in `genie events list` even when spawn no-ops.
- Convert `awaitAgentReadiness` timeout from warning → throwing error so dispatch surfaces failures instead of pretending success.
- In `state.ts:printWishExecutors`, filter the displayed "Active Executors" list to executors whose `assignment.wishSlug === slug` (drop unrelated team-mate agents that shared a role name).
- Tests covering: cwd override, dispatch event emission, readiness timeout raising, wish-status filtering.

### OUT

- Refactoring the `effectiveRole` `<name>-<group>` scheme or the canonical/parallel identity machinery (separate concern).
- Fixing the unrelated "Wave 1 fails-fast on first dependency error" sub-bug A from the issue body (Sub-bug B is the P0 blocker; Sub-bug A is a separate, smaller wish).
- Backfilling missing `dispatch.work` events into historical wish state.
- Changing pgserve discovery / pool-reuse behavior.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Add `cwd` to `SpawnOptions` and gate the team-worktree override on `!options.cwd` | Minimal surface, additive, preserves existing behavior for free-form spawns; wish dispatch (the only caller that knows the right cwd) opts in explicitly. |
| 2 | Throw on `awaitAgentReadiness` timeout, surfaced through `dispatchSpawn` | Silent warning is what made #1589 latent for two releases; loud failure is the only thing that surfaces phantom dispatch. |
| 3 | Emit `wish.dispatch.work` event before `handleWorkerSpawn`, distinct from `worker.spawn` | Lets users see "I attempted to dispatch group N to role R" even when spawn fails to register; matches the investigation's surface (4) suggestion. |
| 4 | Wish-status executor list filters to `assignment.wishSlug === slug` rather than match by role-name | The current code already calls `getActiveAssignment(executor.id)`; we just need to filter (not relabel) by the result. Removes the dog-fooder false-positive without touching the registry. |
| 5 | Implement directly (not via sub-engineer) | ~80 LOC across 4 files, surgical fixes pre-specified by the investigation; spawning an engineer adds context-window overhead without value. |

## Success Criteria

- [x] `genie work <wish-slug>` from inside the wish worktree spawns an engineer whose `/proc/<pid>/cwd` matches the wish worktree. _(Group 1 — verified by source-grep regression guard; awaiting empirical post-merge verification on dev/.24)_
- [x] `genie events list --since 5m` after a wish dispatch shows a `wish.dispatch.work` event with `wish_slug`, `group_name`, `agent_role` attributes. _(Group 2 — `recordAuditEvent` call lands before `handleWorkerSpawn`; covered by regression test)_
- [x] If `awaitAgentReadiness` times out, `dispatch.ts` exits non-zero with a clear error referencing the role that failed. _(Group 2 — `AgentReadinessTimeoutError` raised in strict mode; covered by regression test)_
- [x] `genie wish status <slug>` "Active Executors" shows only executors whose active assignment is for `<slug>` (no dog-fooder/cross-wish bleed-through). _(Group 3 — `if (assignment?.wishSlug !== slug) continue` filter applied in both render paths)_
- [x] `bun test src/term-commands` passes (579 pass, 0 fail). Existing `dispatch.test.ts` 70 tests still pass; 7 new regression-guard tests for #1589 added. `bun run typecheck` clean (only pre-existing TUI keymap errors). `bun run lint` clean (only pre-existing `team-manager.ts:617` + `buildSpawnParams` complexity, both untouched).

## Execution Strategy

### Wave 1 (sequential — single engineer)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Spawn cwd correction (root cause) |
| 2 | engineer | Observability — `dispatch.work` event + raise on readiness timeout |
| 3 | engineer | wish-status display filtering |

All three groups will be executed by the genie agent directly given the small scope (~80 LOC) and surgically pre-specified surfaces from the investigation. A reviewer pass follows.

## Execution Groups

### Group 1: Spawn cwd correction

**Goal:** Wish dispatches must land workers in the wish's worktree, not the team's worktree.

**Deliverables:**
1. Add optional `cwd?: string` to `SpawnOptions` in `src/term-commands/agents.ts` (or wherever `SpawnOptions` is declared).
2. In `agents.ts:handleWorkerSpawn` around line 2388-2395, change the override condition so `options.cwd` (when set) takes precedence over `teamConfig.worktreePath`. Keep the existing fallback for callers that don't pass `cwd`.
3. In `src/term-commands/dispatch.ts:runWorkDispatch` around line 698-711, pass `cwd: process.cwd()` in the `handleWorkerSpawn` options. Add an inline comment explaining why (wish dispatch must land in wish worktree, see #1589).
4. Same fix in the `bareDispatchCommand` path (`runBareDispatch`) if it shares the same surface.

**Acceptance Criteria:**
- [ ] `SpawnOptions.cwd` is optional and documented in the type definition.
- [ ] `agents.ts` cwd resolution prefers `options.cwd` → `agent.entry.dir` → `teamConfig.worktreePath` (in that order).
- [ ] `dispatch.ts` passes `cwd: process.cwd()` for wish dispatches.
- [ ] Empirical: `genie work tui-bottom-bar-opentui` from `~/.genie/worktrees/tui-bottom-bar-opentui` spawns engineer with `/proc/<pid>/cwd` pointing at the wish worktree.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/term-commands/dispatch.test.ts && bun test src/term-commands/agents.test.ts
```

**depends-on:** none

---

### Group 2: Observability — dispatch event + raise on readiness timeout

**Goal:** Make phantom dispatch impossible to ship undetected.

**Deliverables:**
1. In `src/term-commands/dispatch.ts:runWorkDispatch`, emit a `wish.dispatch.work` audit event (via `recordAuditEvent` or the existing trace-span machinery) immediately before `handleWorkerSpawn`. Attributes: `wish_slug`, `group_name`, `agent_role` (the `effectiveRole`), `wish_path`.
2. In `src/term-commands/agents.ts:awaitAgentReadiness` (around line 984-992), throw a structured error on timeout instead of `console.log` warning. Include role name + elapsed time in the error message.
3. Caller (`launchTmuxSpawn` line 1030) must propagate the error so `handleWorkerSpawn` returns failure rather than appearing successful. Update `dispatch.ts` to surface the error and exit non-zero.
4. Tests verifying:
   - `wish.dispatch.work` event is emitted with the expected attributes.
   - Readiness timeout throws and `genie work` exits non-zero with the role name in the message.

**Acceptance Criteria:**
- [ ] `wish.dispatch.work` event appears in `genie events list` for every successful wish dispatch (and every failed one).
- [ ] Readiness timeout raises a typed error containing the agent role.
- [ ] `genie work` exits non-zero on readiness timeout with the role name in stderr.
- [ ] No new unhandled-rejection warnings.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/term-commands/dispatch.test.ts && bun test src/term-commands/agents.test.ts
```

**depends-on:** Group 1

---

### Group 3: wish-status display correlation

**Goal:** "Active Executors" shows only the wish's actual workers — never dog-fooder or other cross-wish team-mates.

**Deliverables:**
1. In `src/term-commands/state.ts:printWishExecutors` (around line 512-542), change the loop so executors whose `assignment.wishSlug !== slug` are SKIPPED (not just relabeled with `'-'`).
2. Apply the same filter in `src/term-commands/task/status.ts:51` (the parallel "Active Executors" rendering for task status).
3. Test verifying that an unrelated team agent (e.g. dog-fooder engineer running on a different wish) does not appear in `wish status <slug>`.

**Acceptance Criteria:**
- [ ] `printWishExecutors` only emits rows where `assignment.wishSlug === slug`.
- [ ] `task/status.ts` mirrors the same filter.
- [ ] Test added covering the filter.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/term-commands/state.test.ts 2>/dev/null || bun test src/term-commands/state
```

**depends-on:** none

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] **Functional:** From any orchestrator session with `GENIE_TEAM=genie`, run `genie work <wish-slug>` from inside the wish worktree → engineer process appears in `pgrep -af engineer-<group>` AND `/proc/<pid>/cwd` is the wish worktree.
- [ ] **Observability:** `genie events list --since 5m` after the dispatch contains a `wish.dispatch.work` event referencing the wish slug and group.
- [ ] **Error path:** Force a readiness timeout (e.g. by sabotaging the launch command) → `genie work` exits non-zero with a clear error; PG state for the group rolls back to `ready` (or remains `in_progress` with a clearly-failed assignee that operators can `wish reset`).
- [ ] **Display:** `genie wish status <slug>` after a successful dispatch shows only the wish's engineers under "Active Executors", not unrelated team agents.
- [ ] **Regression:** Existing `dispatch.test.ts` and `agents.test.ts` pass; full `bun run check` is green; existing free-form `genie spawn engineer` (without wish) still respects team worktree as before.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Throwing on readiness timeout breaks legitimate slow-start agents | Medium | Keep the warning-and-proceed behavior reachable via an opt-in flag (`options.tolerateReadinessTimeout`) for callers that genuinely want fire-and-forget; wish dispatch opts into the strict mode. |
| Other callers of `handleWorkerSpawn` pass `team` but not `cwd` and now silently change behavior | Low | The change is additive (`cwd` defaults to undefined → existing path); only wish dispatch opts in. Documented in the new field's JSDoc. |
| `wish.dispatch.work` event clobbers an existing event name | Low | Grep confirms no prior usage of `wish.dispatch.work`. Existing dispatch span uses `wish.dispatch` (no `.work` suffix). |
| Display filter hides legitimate cross-wish helpers | Low | The `assignment` table is authoritative for "this executor is working on this wish" — unrelated executors should not appear under "Active Executors for wish X". |
| Branch is on `wish/fix-genie-work-phantom-dispatch` (off origin/dev), not the team worktree | Low | This is the canonical genie repo at `/home/genie/workspace/repos/genie`; wish branches always work here per project convention. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/term-commands/dispatch.ts          # Group 1: cwd option; Group 2: dispatch.work event + propagate readiness error
src/term-commands/agents.ts            # Group 1: SpawnOptions.cwd + override precedence; Group 2: throw on readiness timeout
src/term-commands/state.ts             # Group 3: filter Active Executors by wishSlug
src/term-commands/task/status.ts       # Group 3: same filter
src/term-commands/dispatch.test.ts     # New tests for cwd, dispatch.work event, readiness timeout
src/term-commands/state.test.ts        # New test for executor filter (or extend existing)
```
