# Wish: v4 Stability — Session/Executor Lifecycle Fixes

| Field | Value |
|-------|-------|
| **Status** | SHIPPED — PR #956 (v4 Stability Sprint, 2026-04-02) |
| **Slug** | `v4-session-executor` |
| **Date** | 2026-03-31 |
| **Design** | _Design not recovered — this wish pre-dates the brainstorm-commit convention (see #1132)._ |

## Summary
Fix 4 P0 and 6 P1 bugs in session creation, executor lifecycle, and tmux state management. These cause running agents to be killed on session attach, orphaned executor records, and DB-tmux state desynchronization. This is the most critical stability surface — every agent reboot triggers these code paths.

## Scope
### IN
- Remove unconditional `terminateActiveExecutor()` from `registerSessionInRegistry()` (P0 — kills running agents)
- Add atomic check-and-create for tmux sessions to eliminate TOCTOU race (P0)
- Wrap executor creation + agent FK linking in a DB transaction (P0)
- Fix `handleReset()` to clean up executor state in DB (P1)
- Fix `terminateActiveExecutor()` to use atomic `UPDATE WHERE current_executor_id = $1` (P1)
- Add logging to all silent catch blocks in session.ts and tmux.ts (P1)
- Fix window rename race with automatic-rename (set option BEFORE rename) (P1)
- Fix `capturePanePid()` timing — wait for Claude Code process, not bash shell (P1)
- Add tmux server crash recovery with retry+backoff in `ensureTeamWindow()` (P1)
- Distinguish dead-pane vs dead-tmux in `isPaneAlive()` (P1)

### OUT
- TUI rendering/layout changes (separate concern)
- Pane color persistence (P2 — cosmetic)
- Window base-index assumption (P2 — edge case)
- GENIE_CWD persistence to DB (P2 — deferred)

## Decisions
| Decision | Rationale |
|----------|-----------|
| Guard on spawn, not on attach | The executor kill belongs at spawn time (prevent duplicates) not at session registration (prevent attach) |
| Use `tmux new-session -d` with error check instead of find-then-create | Eliminates TOCTOU entirely — tmux itself handles atomicity |
| Wrap executor ops in SQL transactions | Prevents orphaned records from partial failures |
| Add structured logging, not just console.error | Silent catch blocks are the #1 debugging obstacle |

## Success Criteria
- [ ] Attaching to a running agent session does NOT kill the agent process
- [ ] Two concurrent `genie session` calls for the same team don't create duplicate sessions
- [ ] Executor records are cleaned up when sessions are reset
- [ ] No orphaned executor records after normal session lifecycle
- [ ] All catch blocks in session.ts and tmux.ts include `console.warn` with context (no comment-only catches)
- [ ] `bun test src/genie-commands/__tests__/session.test.ts` passes
- [ ] `bun test src/lib/executor-registry.test.ts` passes (add new tests for atomicity)

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix terminateActiveExecutor guard + atomic executor ops |
| 2 | engineer | Fix TOCTOU race + tmux recovery |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Fix silent catches + handleReset cleanup + PID capture timing |
| review | reviewer | Review all groups |

## Execution Groups

### Group 1: Executor Lifecycle Atomicity
**Goal:** Prevent executor kills on attach and orphaned records.
**Deliverables:**
1. Remove `terminateActiveExecutor()` from `registerSessionInRegistry()` in `session.ts:127`
2. Add executor guard at spawn time only (in `createSession()`)
3. Wrap executor creation + `current_executor_id` linking in SQL transaction in `executor-registry.ts`
4. Fix `terminateActiveExecutor()` to use `UPDATE agents SET current_executor_id = NULL WHERE id = $1 AND current_executor_id = $2`

**Acceptance Criteria:**
- [ ] `registerSessionInRegistry()` no longer calls `terminateActiveExecutor()`
- [ ] Executor creation and FK link are atomic (single transaction)
- [ ] Concurrent executor creation doesn't orphan records

**Validation:**
```bash
bun test src/lib/executor-registry.test.ts && bun test src/genie-commands/__tests__/session.test.ts
```

**depends-on:** none

---

### Group 2: Session Creation Race + Tmux Recovery
**Goal:** Eliminate TOCTOU on session creation and handle tmux server crashes.
**Deliverables:**
1. Replace find-then-create pattern in `tmux.ts:309-312` with atomic create (catch "duplicate" error)
2. Same fix in `team-auto-spawn.ts:61-65`
3. Add retry with backoff in `ensureTeamWindow()` for "no server running" errors
4. Fix `isPaneAlive()` to return `{ alive: boolean, tmuxReachable: boolean }` or throw on tmux unreachable

**Acceptance Criteria:**
- [ ] Concurrent session creation doesn't produce duplicates or errors
- [ ] Tmux server restart during session creation retries gracefully
- [ ] `isPaneAlive()` distinguishes pane death from tmux death

**Validation:**
```bash
bun test src/lib/tmux.test.ts && bun test src/lib/team-auto-spawn.test.ts
```

**depends-on:** none

---

### Group 3: Silent Failures + Reset Cleanup + PID Capture
**Goal:** Eliminate silent error swallowing and fix session reset DB pollution.
**Deliverables:**
1. Add `console.warn('[genie-session] <context>: <error.message>')` to all catch blocks in `session.ts` and `tmux.ts` that currently have only comments (e.g. `/* best-effort */`). The goal is debuggability — every catch should log what failed and why, not just silently continue.
2. Fix `handleReset()` in `session.ts:330-343` to set executor state='terminated' and NULL `current_executor_id`
3. Fix window rename order: set `automatic-rename off` BEFORE rename-window
4. Fix `capturePanePid()` to wait for Claude Code process with short poll (up to 5s)

**Acceptance Criteria:**
- [ ] Every catch block in session.ts and tmux.ts logs a warning with context
- [ ] After `genie --reset`, executors table has no stale 'spawning'/'working' records for that session
- [ ] Window name persists after creation (automatic-rename is off before rename)

**Validation:**
```bash
# Verify no catch blocks with only comments (no console.warn)
grep -A2 'catch' src/genie-commands/session.ts src/lib/tmux.ts | grep -c 'console.warn' | head -1  # should be > 0
bun test src/genie-commands/__tests__/session.test.ts
```

**depends-on:** Group 1, Group 2

---

## Files to Create/Modify

```
src/genie-commands/session.ts
src/lib/executor-registry.ts
src/lib/tmux.ts
src/lib/team-auto-spawn.ts
src/lib/executor-registry.test.ts (new tests)
```
