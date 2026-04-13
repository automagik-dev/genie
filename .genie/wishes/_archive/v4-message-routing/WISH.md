# Wish: v4 Stability — Message Routing + Delivery Fixes

| Field | Value |
|-------|-------|
| **Status** | SHIPPED — PR #966 (v4 Stability Sprint, 2026-04-02) |
| **Slug** | `v4-message-routing` |
| **Date** | 2026-03-31 |
| **Design** | _Design not recovered — this wish pre-dates the brainstorm-commit convention (see #1132)._ |

## Summary
Fix 3 P0 and 4 P1 bugs in the protocol router that cause silent agent death on spawn failure, duplicate workers from cleanup races, and messages marked as delivered when delivery actually failed. These are the root cause of "messages disappearing" and "agents not responding" reports.

## Scope
### IN
- Fix silent spawn failure in `protocol-router.ts:163-164` — log error, mark worker as failed, retry (P0)
- Add mutex/lock around dead worker cleanup + respawn in `protocol-router.ts:137-166` (P0)
- Add lock around executor guard in `protocol-router-spawn.ts:105-117` to prevent duplicate executors (P0)
- Fix pane liveness check to re-verify before delivery in `protocol-router.ts:72-90` (P1)
- Fix false delivery success in `protocol-router.ts:226` — only mark delivered on confirmed success (P1)
- Fix native inbox write error handling in `protocol-router-spawn.ts:257-264` (P1)
- Fix resume context injection to surface errors in `protocol-router-spawn.ts:272` (P1)

### OUT
- Message retry queue with persistence (future — needs design)
- Cross-team message routing (P2)
- Trace ID propagation (P2)
- Stale resume session ID validation (P2)

## Decisions
| Decision | Rationale |
|----------|-----------|
| Use PG advisory locks keyed on agent ID hash | `pg_advisory_xact_lock(hashtext(agent_id))` — scoped to transaction, auto-released on commit/rollback, no schema changes |
| Re-verify pane alive right before injection | Small latency cost but prevents delivering to dead panes |
| Mark delivery as failed on any error | Better to show "not delivered" than silently lose messages |
| "Confirmed success" = tmux send-keys returns 0 OR native inbox write succeeds | Mailbox.send is not delivery — it's queuing. Only mark delivered after actual injection |
| Resume context errors: log warning, continue delivery | Resume context is best-effort enhancement, not critical path — losing it shouldn't block message delivery |

## Success Criteria
- [ ] Spawn failures are logged and worker state reflects the failure
- [ ] Concurrent dead-worker cleanup doesn't create duplicate workers
- [ ] Messages are only marked delivered when delivery succeeds
- [ ] Pane is re-checked alive immediately before message injection
- [ ] `bun test src/lib/protocol-router.test.ts` passes
- [ ] `bun test src/lib/protocol-router-spawn.test.ts` passes (add spawn guard test)

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix spawn failure handling + duplicate worker race |
| 2 | engineer | Fix delivery confirmation + pane re-verify |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Fix inbox write + resume context error surfacing |
| review | reviewer | Review all groups |

## Execution Groups

### Group 1: Spawn Guard + Dedup
**Goal:** Prevent silent spawn failures and duplicate workers.
**Deliverables:**
1. Add error logging and worker state update in `protocol-router.ts:163-164` catch block
2. Add PG advisory lock around cleanup+respawn cycle in `protocol-router.ts:137-166`: use `pg_advisory_xact_lock(hashtext(worker.agentId))` inside a `sql.begin()` transaction. Critical section: from `cleanupDeadWorkers()` through `spawnWorkerFromTemplate()` return. Lock released automatically on transaction commit/rollback.
3. Add same advisory lock pattern around executor guard in `protocol-router-spawn.ts:105-117`: lock on agent ID before terminating old executor, hold through new executor creation.
4. Add test for concurrent spawn attempts: use `Promise.all([sendMessage(...), sendMessage(...)])` to same dead worker, assert only one spawn occurs (mock `spawnWorkerFromTemplate` to track call count)

**Acceptance Criteria:**
- [ ] Spawn failure sets worker state to 'failed' and logs the error
- [ ] Two concurrent messages to dead worker produce exactly one respawn
- [ ] Advisory lock is released on both success and failure paths

**Validation:**
```bash
bun test src/lib/protocol-router.test.ts
```

**depends-on:** v4-session-executor (Group 1 — atomic executor ops)

---

### Group 2: Delivery Confirmation
**Goal:** Ensure delivery status accurately reflects reality.
**Deliverables:**
1. Add `isPaneAlive()` check immediately before `deliverToWorker()` call
2. Fix `delivered` flag logic in `protocol-router.ts:220-226` — only true on confirmed success
3. Add delivery failure logging with worker ID and message excerpt

**Acceptance Criteria:**
- [ ] Messages to dead panes return `delivered: false`
- [ ] Mailbox only marked delivered on confirmed success
- [ ] Failed deliveries are logged with context

**Validation:**
```bash
bun test src/lib/protocol-router.test.ts
```

**depends-on:** Group 1 (spawn guard must be in place before delivery changes)

---

### Group 3: Error Surfacing
**Goal:** Stop swallowing errors in inbox writes and resume context.
**Deliverables:**
1. Add try/catch with logging around native inbox write in `protocol-router-spawn.ts:257-264`
2. Surface `injectResumeContext()` errors as warnings in `protocol-router-spawn.ts:379` — `console.warn('[protocol-router] Resume context injection failed: <msg>')`, then continue (don't throw — resume context is best-effort)

**Acceptance Criteria:**
- [ ] Failed inbox writes are logged with team name and target
- [ ] Failed resume context injection is logged as a warning

**Validation:**
```bash
bun test src/lib/protocol-router-spawn.test.ts 2>&1 | tail -5
```

**depends-on:** Group 1

---

## Files to Create/Modify

```
src/lib/protocol-router.ts
src/lib/protocol-router-spawn.ts
src/lib/protocol-router.test.ts (add concurrent spawn + delivery tests)
src/lib/protocol-router-spawn.test.ts (new — spawn guard + error surfacing tests)
```
