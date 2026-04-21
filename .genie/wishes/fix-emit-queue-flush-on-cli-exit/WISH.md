# Wish: Flush Emit Queue on CLI Exit

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `fix-emit-queue-flush-on-cli-exit` |
| **Date** | 2026-04-21 |
| **Design** | _Observed via PR #1253 (Bug E resolver fallback) live-server verification: `rot.executor-ghost.detected` fired correctly from `turnClose` but never persisted to `genie_runtime_events`._ |

## Summary

`emitEvent` enqueues rows into an in-memory buffer that drains on a background `setInterval` timer. The timer is `.unref()`-marked so it does not keep the Node process alive. Short-lived CLI verbs (`genie done`, `genie spawn`, `genie send`, etc.) exit between timer ticks, and every queued event is silently dropped. There is already a `postAction` hook in `src/genie.ts` that calls `await flushNow()` — but it's **gated behind `isWideEmitEnabled()`** (line 362). With `GENIE_WIDE_EMIT` unset (the default), the gate bails out before the flush call. Result: every runtime event emitted during a CLI command is lost unless the timer happens to tick before exit. Bug E's ghost-detector event demonstrated this live: `genie done` succeeded, stderr warning fired, audit row was written — but zero rows landed in `genie_runtime_events`. This wish removes the gate (events queued during a command should always reach their table) with a three-line change plus a regression test.

## Scope

### IN
- **Bug G — CLI flush gate.** Remove the `isWideEmitEnabled()` early-return from the `postAction` flush path, so the flush fires on every command exit regardless of the wide-emit feature flag. Keep the flush inside a `try/catch` so it stays best-effort.
- **Regression test** in `src/genie.test.ts` (or nearest existing CLI-level test) asserting that an event emitted during a command reaches `genie_runtime_events` before process return. Uses the `__resetEmitForTests` hook already exported from `emit.ts`.

### OUT
- Restructuring the emit pipeline or changing queue semantics — the existing `flushNow()` function is correct; we're just calling it.
- Flipping the `GENIE_WIDE_EMIT` default — that's a separate rollout decision (phase 3 of the observability wish).
- Per-subject flush policies — every event type benefits from the flush; no reason to discriminate.
- Worker-pane (non-CLI) emit paths — long-running workers hit timer ticks naturally and don't need this change.
- Renaming `isWideEmitEnabled` or touching the `endSpan` path — those still gate correctly (wide-emit is about whether to emit the span at all; flushing what's already queued is orthogonal).

## Dependencies & Prerequisites

None. This is a standalone fix. Sibling to `fix-executor-ghost-on-reinstall` (PR #1252 merged, #1253 Bug E merged) only in that #1253 surfaced the bug during live verification.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Always flush, regardless of wide-emit flag | Events already enqueued represent real telemetry the caller intended to record. The feature flag governs whether wide-emit rows are emitted at all, not whether queued rows get persisted. Dropping queued rows is always wrong. |
| Use `flushNow()` not `shutdownEmitter()` | `shutdownEmitter` tears down all timers, which is wrong for `postAction` (the process may continue with more commands in test contexts; timers should stay live). `flushNow` drains the queue without touching the background infrastructure. |
| Keep the flush inside a `try/catch` that swallows errors | Matches the existing best-effort policy of the surrounding hook — observability failures must never break CLI commands. |
| No new public API | `flushNow` is already exported from `emit.ts` (line 812) for tests. We just call it. |
| Regression test at the CLI level, not the emit-internal level | An emit-internal test can't reproduce the `.unref()` + `setInterval` + process-exit race; only a CLI-level test asserts the event actually persists before process return. |

## Success Criteria

- [ ] Running any CLI command that calls `emitEvent` internally produces a row in `genie_runtime_events` before the process exits — verified by a regression test.
- [ ] Live reproduction path (today's incident): `GENIE_EXECUTOR_ID=<ghost> GENIE_AGENT_NAME=<agent> genie done` → `rot.executor-ghost.detected` row appears in `genie_runtime_events` within 2s of command exit.
- [ ] `isWideEmitEnabled()` early-return removed from the `postAction` flush path only; the `endSpan` wide-emit branch still gates correctly (wide-emit-specific span still does not fire when flag is off).
- [ ] `bun run typecheck`, `bun run lint`, `bun test` — all green.
- [ ] No regression on command latency — `flushNow()` on an empty queue is a micro-cost; on a populated queue it replaces the silent drop with a correct write.

## Execution Groups

### Group 1: Remove the gate + add regression test

**Goal:** Every CLI command drains its emit queue before exit, and a test proves it.

**Deliverables:**
1. `src/genie.ts` postAction hook — restructure so `flushNow()` is always called (its own `try { await flushNow() } catch {}` block), and the existing wide-emit-gated `endSpan` + `flushNow` block only handles the span closure. Two try-blocks instead of one:
   - Try-block 1 (unconditional): drain any queued events via `flushNow()`.
   - Try-block 2 (gated on `isWideEmitEnabled()`): close the CLI command span with `endSpan`.
2. `src/genie.test.ts` (or create if absent) — test: stub a minimal command that calls `emitEvent('state_transition', ...)` with a known payload, run it through the CLI program, assert `SELECT count(*) FROM genie_runtime_events WHERE ...` returns ≥ 1 immediately after return.
3. Manual verification on live server: run the same `genie done` ghost-fallback scenario used to surface this bug, confirm the `rot.executor-ghost.detected` row lands.

**Acceptance Criteria:**
- [ ] postAction has two independent try-blocks; flush always runs, endSpan runs only when wide-emit enabled.
- [ ] Regression test passes and would have caught this bug before merge.
- [ ] Live server `genie done` ghost-fallback scenario deposits the runtime-events row within ≤2s.

**Validation:**
```bash
bun run typecheck
bun run lint
bun test src/genie.test.ts
# Live reproduction (server):
GENIE_EXECUTOR_ID=$(python3 -c 'import uuid; print(uuid.uuid4())') \
  GENIE_AGENT_NAME=genie-configure genie done
sleep 2
genie db query "SELECT count(*) FROM genie_runtime_events WHERE subject='rot.executor-ghost.detected'"
# Expect incremented count.
```

**depends-on:** none.

---

## QA Criteria

_Tested on dev after merge before declaring the wish done._

- [ ] Live server: `GENIE_WIDE_EMIT` is unset; emit any runtime event via a CLI verb; row appears in `genie_runtime_events` within 2s.
- [ ] Live server: `GENIE_WIDE_EMIT=1` is set; wide-emit span AND queued events both land (no regression on the wide-emit path).
- [ ] No measurable latency regression on CLI commands that emit zero events (empty-queue flush is a no-op path).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `flushNow()` on a command that dispatches many events adds perceptible latency | Low | The existing pipeline caps per-batch size; `flushNow` drains synchronously but each batch INSERT is already the hot path. If latency matters in practice, promise.race with a small timeout — not expected for the current event volume. |
| PG unavailable during flush → hook throws | Low | try/catch already swallows — same policy as the pre-existing endSpan try-block. |
| Wide-emit-gated behavior users relied on | Very low | Wide-emit gates which events get enqueued in the first place (at the call site), not whether queued events drain. Removing the flush gate doesn't change what gets enqueued. |
| Test flakiness — async queue → DB insert may take variable time | Low | `flushNow()` returns after the INSERT completes; the post-CLI assertion can be synchronous. |

---

## Review Results

### Plan Review — DRAFT (awaiting first review)

**Open questions for reviewer:**
- Should the unconditional flush ALSO apply to the `preAction` hook, or is post-only enough? (Post-only should suffice — commands emit during execution, not before.)
- If we expand scope to ship a `shutdownEmitter()`-on-SIGTERM handler for graceful kills, is that in scope for this wish or a sibling? (Scoped OUT here; separate wish if needed.)

_Execution review — populated after `/work` completes._

---

## Files to Create/Modify

```
Modify:
  src/genie.ts                  # split postAction into two try-blocks; flush unconditionally

Create:
  src/genie.test.ts             # (or append to existing CLI-level test file)
  .genie/wishes/fix-emit-queue-flush-on-cli-exit/WISH.md   # this file
```

---

## Live Incident Reference

**Surfaced during PR #1253 verification on `genie-stefani`, 2026-04-21 ~04:55 UTC.**

Scenario: Bug E resolver fallback test — fresh open executor for `genie-configure`, ghost UUID in env, call `genie done`.

Observed:
- ✅ Stderr warning fired: `[turn-close] executor <ghost> not found, falling back to agent_id='genie-configure' → <new>`
- ✅ `turn_close.done` audit row recorded
- ✅ Executor transitioned `running → done`
- ❌ `rot.executor-ghost.detected` row in `genie_runtime_events`: **0 rows** (expected 1 per call)

Independent check: direct emit via `bun -e '...emitEvent(...); await new Promise(r => setTimeout(r, 500))'` → row persists (event pipeline is healthy).

Root cause: `src/genie.ts:361-362` early-returns before calling `flushNow()` when `GENIE_WIDE_EMIT` is unset. `flushTimer` is `.unref()`-marked so process exits before the next tick. Queue drops all entries.

Fix: the three-line restructure described in Group 1.
