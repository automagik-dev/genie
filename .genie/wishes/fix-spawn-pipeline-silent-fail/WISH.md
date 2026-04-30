# Wish: Fix `genie work` spawn pipeline silent failure (#1600)

| Field | Value |
|-------|-------|
| **Status** | IMPLEMENTED |
| **Slug** | `fix-spawn-pipeline-silent-fail` |
| **Date** | 2026-04-30 |
| **Author** | felipe (#1600 evidence), genie (wish + impl) |
| **Appetite** | small |
| **Branch** | `wish/fix-spawn-pipeline-silent-fail` |
| **Repos touched** | `automagik-genie` |
| **Design** | _No brainstorm — direct wish driven by #1600 evidence_ |

## Summary

PR #1599 fixed the three documented surfaces of #1589 (cwd plumbing, dispatch event, display filter), but `genie work` STILL produces phantom dispatches on `4.260430.24`: the dispatch event fires with the right cwd, but no engineer process appears in `pgrep`, no tmux pane appears in `tmux list-panes -a`, and no consumed context-file process exists. The silent-fail surface lives BETWEEN `createTmuxPane` returning a paneId and the spawn pipeline's exit — the pane is either created and immediately exits (script failure), or `tmux split-window` succeeds at the API but the pane process dies before `awaitAgentReadiness` can probe it. Currently this failure mode is invisible to operators (no audit event, no error log, dispatch reports success). This wish lands post-spawn validation + a `worker.spawn.failed` audit event family + loud dispatch-level failure surfacing, so the next phantom dispatch produces structured evidence instead of silence.

## Scope

### IN

- Post-spawn validation in `launchTmuxSpawn`: immediately after `createTmuxPane` returns a paneId, verify (a) the pane exists in tmux's pane list and (b) the captured PID is alive (`kill -0 <pid>` semantics). If either check fails, throw a typed `SpawnPaneVanishedError`.
- New audit-event family in `agents.ts`:
  - `worker.spawn.failed` — emitted at every error point in the spawn pipeline (createTmuxPane catch, post-spawn validation failure, awaitAgentReadiness timeout) with a structured `reason` field.
  - `worker.spawn.ok` — emitted when `launchTmuxSpawn` completes successfully (after readiness probe passes), with `pane_id`, `pid`, `cwd`, `executor_id` for correlation.
- Dispatch-level surfacing in `autoOrchestrateCommand`: when any group's `workDispatchCommand` rejects, the failure summary must include the structured reason (not just the JS error string), AND must fire its own audit-event correlated with the wish slug.
- Tests covering: post-spawn validation throws on a vanished pane, `worker.spawn.failed` event payload shape, `worker.spawn.ok` event correlation.

### OUT

- Diagnosing the ROOT cause of why panes vanish (that's the next iteration — this wish makes the failure VISIBLE so the next dispatch run produces concrete evidence).
- Auto-resume short-circuit (separate concern documented as a follow-up risk).
- Refactoring the wave-dispatch parallel-promise path or its summary print logic.
- Touching the SDK provider spawn path (`launchSdkSpawn`) — TUI-only failure surface for now.
- Backfilling missing audit events into historical dispatch state.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Post-spawn validation lives inside `launchTmuxSpawn`, between `createTmuxPane` and `capturePanePid` | Closest to the failure surface; single chokepoint catches both "pane never existed" (createTmuxPane returned a paneId for a pane that exited before we got control) and "pane existed transiently". |
| 2 | Throw a typed `SpawnPaneVanishedError` instead of a generic `Error` | Lets the caller distinguish silent-pane-death from other spawn errors and decide whether to retry; aligns with `AgentReadinessTimeoutError` from #1599. |
| 3 | Three distinct audit events: `worker.spawn` (attempted, existing), `worker.spawn.ok` (success), `worker.spawn.failed` (failure with reason) | Keeps the existing `worker.spawn` event as "I attempted a spawn" (already used by analytics) and adds two terminal-state events so operators can `genie events list --type worker.spawn.failed --since 5m` to see exactly what broke. |
| 4 | Dispatch-level audit at autoOrchestrateCommand boundary | Wave dispatch failures currently print to stderr only; an audit event makes them queryable in `genie events` for the dog-fooder smoke loop. |
| 5 | Implement directly (not via sub-engineer) | Same reasoning as #1599 — surgical fixes pre-specified by the issue, ~100 LOC, single coordinated change across 2 files. |

## Success Criteria

- [x] After this wish lands, running `genie work tui-bottom-bar-opentui` from a felipe-style session reproduces the phantom-dispatch failure but now produces a `worker.spawn.failed` event in `genie events list --since 5m` with a structured reason that pinpoints which step in the pipeline broke (createTmuxPane catch, pane-vanished, readiness-timeout, etc.). _(Group 1+2 — emitFailed wires all 3 surfaces; covered by regression test)_
- [x] When the spawn DOES succeed (post-fix on healthy environment), a `worker.spawn.ok` event appears with pane_id, pid, cwd, executor_id. _(Group 2 — terminal-state event; covered by regression test)_
- [x] `bun test src/term-commands/dispatch.test.ts` and `src/term-commands/agents` tests pass with new regression-guard coverage. _(85 pass / 0 fail in dispatch.test.ts; 587 / 0 in full term-commands)_
- [x] `bun run typecheck` and `bun run lint` clean (only pre-existing warnings unchanged). _(typecheck clean; lint clean except pre-existing `buildSpawnParams` and `team-manager.ts:617`)_

## Execution Strategy

### Wave 1 (sequential — single agent)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Post-spawn validation + SpawnPaneVanishedError |
| 2 | engineer | worker.spawn.failed / worker.spawn.ok audit events |
| 3 | engineer | Dispatch-level failure surfacing in autoOrchestrateCommand |

All three groups will be executed by the genie agent directly.

## Execution Groups

### Group 1: Post-spawn validation + SpawnPaneVanishedError

**Goal:** Detect and surface the case where `createTmuxPane` returns a paneId for a pane that has already exited (script failure) or exits between the createTmuxPane call and the readiness probe.

**Deliverables:**
1. New exported error class `SpawnPaneVanishedError` in `agents.ts` (mirrors `AgentReadinessTimeoutError` from #1599).
2. Helper `validateSpawnedPane(paneId, expectedPid)` that:
   - Queries `tmux list-panes -a -F '#{pane_id}'` and verifies `paneId` is present.
   - If `expectedPid` is provided and > 0, checks `kill(pid, 0)` (i.e. process exists).
   - Throws `SpawnPaneVanishedError` with `paneId`, `expectedPid`, and a structured reason on failure.
3. Call `validateSpawnedPane` inside `launchTmuxSpawn` immediately after `capturePanePid` returns. If the pane vanished, the error propagates up through `dispatchSpawn` → `handleWorkerSpawn` → `runWorkDispatch` and bubbles to `autoOrchestrateCommand`'s `Promise.allSettled`, which already collects rejections.

**Acceptance Criteria:**
- [ ] `SpawnPaneVanishedError` exported from `agents.ts` with `paneId`, `expectedPid`, `reason` fields.
- [ ] `validateSpawnedPane` throws when paneId is not in tmux's pane list.
- [ ] `validateSpawnedPane` throws when PID is not alive.
- [ ] `launchTmuxSpawn` calls `validateSpawnedPane` between `capturePanePid` and `createTmuxExecutor`.
- [ ] Test mocking tmux to return an empty pane list confirms the error is raised.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/term-commands/agents 2>&1 | tail -5
```

**depends-on:** none

---

### Group 2: worker.spawn.failed / worker.spawn.ok audit events

**Goal:** Make every spawn pipeline failure produce a structured audit event with reason, so operators can `genie events list --type worker.spawn.failed --since 5m` and see exactly what broke.

**Deliverables:**
1. Add `worker.spawn.failed` emission at all spawn pipeline error points:
   - `launchTmuxSpawn` catch around `createTmuxPane` (line ~1051) — reason `createTmuxPane_threw`.
   - After `validateSpawnedPane` throws — reason `pane_vanished`.
   - After `awaitAgentReadiness` throws `AgentReadinessTimeoutError` — reason `readiness_timeout`.
   - Any other catchable failure inside `launchTmuxSpawn`.
2. Add `worker.spawn.ok` emission as the last step of `launchTmuxSpawn` (after `awaitAgentReadiness` succeeds and registry update). Payload: `pane_id`, `pid`, `cwd`, `executor_id`, `agent_role`, `wish_correlation` (if available via env GENIE_WISH_SLUG or similar).
3. The existing `worker.spawn` event (line ~2501) stays untouched as the "attempt" record; the new events are terminal-state.

**Acceptance Criteria:**
- [ ] `worker.spawn.failed` fires at every catchable error point in `launchTmuxSpawn` with a structured `reason` enum.
- [ ] `worker.spawn.ok` fires only after the full pipeline succeeds.
- [ ] Each event carries `worker_id`, `pane_id` (when known), `cwd`, `agent_role`, and `reason` (failed only).
- [ ] Source-grep regression test confirms event names + payload keys.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/term-commands/dispatch.test.ts 2>&1 | tail -5
```

**depends-on:** Group 1

---

### Group 3: Dispatch-level failure surfacing in autoOrchestrateCommand

**Goal:** When a wish-dispatch wave fails, operators see structured failure context — not just a one-line stderr message that may be invisible in the orchestrator's output.

**Deliverables:**
1. In `dispatch.ts:autoOrchestrateCommand`, when `Promise.allSettled` returns rejections, emit a `wish.dispatch.failed` audit event per failed group with `wish_slug`, `group_name`, `agent_name`, `reason` (the rejection's error message).
2. Improve the stderr summary print to include the rejected error's class name (e.g. `SpawnPaneVanishedError: ...`) so operators can pattern-match without reading the audit log.

**Acceptance Criteria:**
- [ ] `wish.dispatch.failed` event emitted per failed group on wave dispatch.
- [ ] stderr summary includes error class name + message.
- [ ] Source-grep regression test confirms the event name and key payload fields.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/term-commands/dispatch.test.ts 2>&1 | tail -5
```

**depends-on:** Group 2

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] **Functional:** Running `genie work tui-bottom-bar-opentui` from the wish worktree on the post-merge build either produces a live engineer process (success path — `worker.spawn.ok` event present) OR produces a `worker.spawn.failed` event with a concrete reason (failure path — never silent).
- [ ] **Observability:** `genie events list --since 5m --type worker.spawn.failed` returns rows when dispatches fail; `--type worker.spawn.ok` returns rows when they succeed; the existing `--type worker.spawn` continues to return spawn-attempt rows (no regression).
- [ ] **Loud failure:** `genie work` exit and stderr clearly show `SpawnPaneVanishedError` / `AgentReadinessTimeoutError` if dispatch fails, including which group + role.
- [ ] **Regression:** Existing `agents.spawn-autosync.test.ts` + `dispatch.test.ts` pass; full `bun run check` only emits pre-existing warnings.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `validateSpawnedPane` adds latency on every spawn (tmux list-panes is fast but not free) | Low | The validation is one execSync call; tmux list-panes returns in <10ms typically. The cost is negligible vs. the cost of a silent phantom dispatch. |
| Some legitimate fast-finishing panes (e.g. inline mode) trip the validation | Low | The function is gated on `paneId !== 'inline'` and only runs in tmux mode. Inline spawns bypass this codepath. |
| Adding more audit events bloats `audit_events` table | Low | Three new event types per spawn (attempt + ok-or-failed) is a 1.5x increase; the partition-drain (#055) and indices handle it. |
| Auto-resume short-circuit returns a paneId that points at an already-running pane (wrong window) | Out of scope | `validateSpawnedPane` will report ok because the pane DOES exist; the deeper auto-resume bug is a separate wish (#TBD follow-up). |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/term-commands/agents.ts        # Group 1: SpawnPaneVanishedError, validateSpawnedPane, callsite
                                    # Group 2: worker.spawn.failed / worker.spawn.ok emissions
src/term-commands/dispatch.ts      # Group 3: wish.dispatch.failed emission + improved stderr
src/term-commands/dispatch.test.ts # Regression-guard tests for all 3 groups
```
