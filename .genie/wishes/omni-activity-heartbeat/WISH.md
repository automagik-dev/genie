# Wish: Omni Activity Heartbeat — measurable agent-busy signal

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `omni-activity-heartbeat` |
| **Date** | 2026-04-30 |
| **Author** | felipe@namastex.ai |
| **Appetite** | medium |
| **Branch** | `wish/omni-activity-heartbeat` |
| **Repos touched** | `automagik-genie/genie`, `automagik/omni` |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Omni's turn monitor decides "idle" by counting authenticated API calls from the scoped key (`auth.ts:90`). Real Claude Code work — tool calls, file edits, internal SDK loops — does not call back to omni, so 120s of genuine work looks like 120s of idleness and a `Turn idle for Ns. Are you still working?` nudge gets injected into the running agent's prompt. This wish replaces that broken proxy with a measurable signal: while a Claude Code session is busy, genie publishes `omni.agent.heartbeat.{instanceId}.{chatId}` events; omni consumes them and calls the existing `turnService.recordActivity(turnId)`. The current 120s nudge timer naturally never trips for actively-working agents; genuinely idle sessions still nudge as before.

## Scope

### IN

- New genie service `src/services/agent-heartbeat.ts` — publishes `omni.agent.heartbeat.*` on a configurable cadence (default 30s) while a session is "busy"; stops within 5s of settle.
- "Busy" detection on both executors: claude-sdk (active streaming query) and claude-code/tmux (recent PTY stdout, fall-back to "session has open turn").
- Wiring into `omni-bridge` so the heartbeat publisher starts on `turn.open` and stops on `turn.done` / executor shutdown.
- New omni service `packages/api/src/services/agent-heartbeat.ts` — subscribes to `omni.agent.heartbeat.>`, validates payload, calls `turnService.recordActivity(turnId)`.
- Heartbeat event schema documented in `packages/api/src/services/turn-events.ts` (or a new `agent-events.ts`) with `AgentHeartbeatEvent { turnId, instanceId, chatId, timestamp }`.
- Unit tests on both sides + one end-to-end test that proves a 200s busy session emits zero `turn.nudge` events.
- Docs update: omni `event types` table, omni-reference.md, and a one-line note in genie's executor docs.

### OUT

- Removing genie's `omni.turn.nudge.>` subscription / `injectNudge` path (separate Option-A wish; this wish makes the nudge harmless without removing it).
- Per-tool hook events from claude-agent-sdk (Option C — generality not yet justified).
- Activity tracking for non-claude executors (codex, gemini, custom). Heartbeat publisher is claude-only in v1; the omni consumer is executor-agnostic so other executors can opt in later without omni-side changes.
- Changing nudge thresholds, message format, or the `turn.stalled`/`turn.timeout` paths.
- Backporting to omni or genie versions older than the current `dev` branch.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Transport: plain NATS (not JetStream, not HTTP) | Mirrors `omni.turn.*` convention. Omni already runs NATS; cheaper and lower-latency than an HTTP round-trip every 30s. Loss-tolerant: a missed heartbeat at 30s cadence still leaves three more chances before the 120s nudge threshold. |
| 2 | Topic shape: `omni.agent.heartbeat.{instanceId}.{chatId}` | Matches the existing `omni.turn.*.{instanceId}.{chatId}` pattern so subscribers can use the same routing logic. |
| 3 | Cadence: 30s while busy, zero while idle | Comfortably under the 120s threshold with margin. No traffic when nothing is happening. Configurable via env var `OMNI_HEARTBEAT_INTERVAL_MS` for ops tuning. |
| 4 | Source of "busy": executor-owned, not externally probed | Genie owns the executor and already tracks session lifecycle (`turnTracker`, `executor.injectNudge`, `executor.spawn`). Externalizing the probe (e.g. omni querying genie) would require new request-reply protocol and tighter coupling. |
| 5 | Heartbeat carries `turnId`, omni calls `recordActivity(turnId)` directly | Reuses the existing source-of-truth for activity tracking (`turns.ts:69-72`). Omni does not grow new state; the field that already gates nudges is the field that gets reset. |
| 6 | Backward compatibility: missing heartbeats = current behavior | Older genie clients (pre-this-wish) keep working exactly as today — they just keep tripping nudges. No flag day. New clients suppress their own false nudges by emitting heartbeats. |
| 7 | Wish lives in genie repo, omni-side change shipped as a separate PR in lockstep | Genie is the primary owner (executor + bridge). Omni-side change is small (~30 LOC) and isolated to a new file + one wire-in. Cross-repo dependency declared via `blocks` on the omni PR. |

## Success Criteria

- [ ] Genie publishes `omni.agent.heartbeat.{instanceId}.{chatId}` every 30 ± 2s while a Claude Code session is mid-turn (verified via `nats sub 'omni.agent.heartbeat.>'`).
- [ ] Heartbeats cease within 5s of `turn.done` / executor settle (verified by subscribing and observing no events for 10s after a turn closes).
- [ ] Omni resets `lastActivityAt` on every heartbeat receipt (unit test asserts DB row `lastActivityAt` advances).
- [ ] End-to-end: a 200s busy claude-code session emits zero `omni.turn.nudge.*` events (integration test).
- [ ] Regression: a session with an open turn but zero heartbeats still emits a nudge at 120 ± 5s (integration test — proves the existing path still works for genuinely idle sessions).
- [ ] No new error-level log lines in steady state on either side.
- [ ] `bun test` green on genie. `bun test` green on omni.
- [ ] `bun run typecheck` clean on both repos.
- [ ] Docs updated: omni-reference.md event-types table includes `agent.heartbeat`; genie omni-bridge docstring mentions the heartbeat publisher.

## Execution Strategy

### Wave 1 (parallel)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Omni: heartbeat consumer service + wire-in + unit tests |
| 2 | engineer | Genie: heartbeat publisher service + bridge wire-in + unit tests |

Wave 1 groups are independent — they meet only on the wire (NATS subject + payload schema), which is fixed by Decision 2 and the schema in IN scope. Either group can ship first; the system stays correct because of Decision 6 (missing heartbeats = current behavior).

### Wave 2 (sequential, after Wave 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | qa | End-to-end integration test exercising both sides on a real local NATS |

### Wave 3 (sequential, after Wave 2)

| Group | Agent | Description |
|-------|-------|-------------|
| 4 | docs | Docs + observability updates (omni-reference.md, event types table, runbook note) |

## Execution Groups

### Group 1: Omni — heartbeat consumer

**Goal:** Add a NATS subscriber that converts incoming `omni.agent.heartbeat.*` events into `turnService.recordActivity(turnId)` calls so the existing 120s nudge threshold never trips for actively-working agents.

**Deliverables:**
1. `packages/api/src/services/agent-heartbeat.ts` — new service exposing `start({ natsConnection, turnService })` / `stop()`. Subscribes to `omni.agent.heartbeat.>`, validates payload (Zod or hand-rolled), calls `turnService.recordActivity(payload.turnId).catch(...)`. Logs at `debug` on success, `warn` on validation failure.
2. New `AgentHeartbeatEvent` interface in `packages/api/src/services/turn-events.ts` (or a sibling `agent-events.ts` if the file is getting long): `{ turnId: string; instanceId: string; chatId: string; timestamp: string }`.
3. Wire the new service into API startup next to `initTurnEvents` so it shares the same NATS connection lifecycle.
4. Unit tests in `packages/api/src/services/__tests__/agent-heartbeat.test.ts`:
   - Heartbeat with valid `turnId` → `recordActivity` called once with that id.
   - Malformed payload → `recordActivity` NOT called, warning logged.
   - Unknown `turnId` → `recordActivity` rejection swallowed, no crash.

**Acceptance Criteria:**
- [ ] Subscribing process receives heartbeats on `omni.agent.heartbeat.>` and calls `turnService.recordActivity(turnId)` exactly once per event.
- [ ] Malformed events (missing `turnId`, non-JSON) do not crash the consumer.
- [ ] Service starts/stops cleanly with the API lifecycle (no dangling subscription on shutdown).
- [ ] Unit tests cover happy path, malformed payload, and unknown turn id.

**Validation:**
```bash
cd /home/genie/workspace/repos/omni && bun test packages/api/src/services/__tests__/agent-heartbeat.test.ts
```

**depends-on:** none

---

### Group 2: Genie — heartbeat publisher

**Goal:** Publish `omni.agent.heartbeat.{instanceId}.{chatId}` every 30s while a Claude Code session is busy, and stop within 5s of settle, so omni's `lastActivityAt` stays fresh during real work.

**Deliverables:**
1. `src/services/agent-heartbeat.ts` — new service exposing `HeartbeatPublisher` class with `start(sessionKey, ctx)` / `stop(sessionKey)` and an internal 30s `setInterval` per active session. `ctx` includes `{ instanceId, chatId, turnId, natsConnection }`. Cadence configurable via `OMNI_HEARTBEAT_INTERVAL_MS` env var (default 30000, clamped 5000–60000).
2. "Busy" predicate per executor:
   - `claude-sdk`: query active = streaming response in flight (existing state in `claude-sdk.ts`).
   - `claude-code` (tmux): bytes written to PTY in the last `2 * intervalMs` window (cheap pane stdout poll, or hook the existing tmux observer if one exists).
3. `omni-bridge.ts` wire-in:
   - On `turn.open` (`routeTurnEvent` line 838): `heartbeatPublisher.start(sessionKey, { instanceId, chatId, turnId, natsConnection })`.
   - On `turn.done` / `turn.timeout` / executor disposal: `heartbeatPublisher.stop(sessionKey)`.
   - Defensive: stop on `handleSessionReset` and on bridge shutdown so heartbeats can never outlive the executor.
4. Unit tests in `src/services/__tests__/agent-heartbeat.test.ts`:
   - Fake clock + fake NATS — `start` triggers a heartbeat at every interval.
   - `stop` cancels the interval; no further publishes.
   - Busy=false skips a publish (no NATS message that tick).
   - Multiple concurrent sessions each get independent intervals.

**Acceptance Criteria:**
- [ ] `nats sub 'omni.agent.heartbeat.>'` shows one event every 30 ± 2s while a session is busy.
- [ ] No events emitted while the session is idle (busy predicate returns false).
- [ ] Heartbeat stream stops within 5s of `turn.done` / executor settle.
- [ ] No leaked intervals after bridge shutdown (`clearInterval` called on every active publisher).
- [ ] Multiple concurrent sessions emit independent heartbeat streams without interference.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/services/__tests__/agent-heartbeat.test.ts
```

**depends-on:** none

---

### Group 3: End-to-end integration test

**Goal:** Prove the wire-level contract: a 200s busy claude session causes zero `turn.nudge` events; a 200s idle session still produces a nudge at 120s.

**Deliverables:**
1. New test file (likely in genie since it owns the orchestration): `src/services/__tests__/heartbeat-e2e.test.ts`. Spins up a local NATS test container or in-process NATS, stubs the omni `recordActivity` via a fake `TurnService`, drives the genie heartbeat publisher with a "busy" mock executor, asserts zero `turn.nudge` over 200s of simulated time.
2. Mirror test in omni or shared fixture: a 200s window with no heartbeats → one `turn.nudge` at ~120s (regression guard).
3. Fixtures and helpers shared via the existing testing utilities; no new top-level deps.

**Acceptance Criteria:**
- [ ] Busy-session test: zero `omni.turn.nudge.*` events captured over a simulated 200s window.
- [ ] Idle-session test: exactly one `omni.turn.nudge.*` event captured at 120 ± 5s.
- [ ] Tests run under 10s wall-clock (use fake timers).
- [ ] Tests pass on both genie and omni CI.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/services/__tests__/heartbeat-e2e.test.ts
```

**depends-on:** group 1, group 2

---

### Group 4: Docs and observability

**Goal:** Make the heartbeat protocol discoverable so future maintainers and consumers do not re-invent it.

**Deliverables:**
1. `omni-reference.md` (in this server's `agents/genie-configure/.claude/rules/`) — append `agent.heartbeat` to the Event Types table with one-line description.
2. Genie `omni-bridge.ts` JSDoc — mention the publisher and link to the wish slug.
3. Omni `turn-monitor.ts` docstring — add a sentence explaining that activity is now reset by both authenticated API calls AND incoming `agent.heartbeat` events, so the "MUST NEVER reach the user channel" invariant is now self-enforcing for compliant consumers.
4. Operational note in `omni-reference.md`: example `nats sub 'omni.agent.heartbeat.>'` for live debugging.

**Acceptance Criteria:**
- [ ] Event types table updated in omni reference docs.
- [ ] Source-level docstrings in `omni-bridge.ts` and `turn-monitor.ts` updated.
- [ ] One-paragraph runbook entry explaining how to verify heartbeats are flowing.
- [ ] No broken links; no stale "120s = idle" claim left anywhere.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun run docs:check 2>/dev/null || echo "no docs:check script — manual review"
```

**depends-on:** group 1, group 2, group 3

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: open a real chat that dispatches a Claude Code task running 3+ minutes. Tail `omni events --type turn.nudge --since 5m` while it runs — expect zero entries for that turn.
- [ ] Integration: with the heartbeat publisher disabled (env override `OMNI_HEARTBEAT_INTERVAL_MS=0` or feature flag), the same task triggers a nudge at ~120s — confirms the gate works and falls back gracefully.
- [ ] Regression: a chat with an open turn but no agent activity (e.g. orphaned session) still emits the nudge at 120s — confirms genuinely idle sessions are unaffected.
- [ ] Observability: `nats sub 'omni.agent.heartbeat.>'` produces events at ~30s cadence during the test task and stops within 5s of completion.
- [ ] No memory growth on the genie process over a 30-minute soak test (rule out interval leaks).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| NATS message loss at 30s cadence drops every heartbeat for 120s | Low | Plain NATS in a local infra has near-zero loss. Even pessimistically, 4 missed heartbeats in a row is below the 120s threshold but well above background failure rate. If observed in production, drop cadence to 20s. |
| Heartbeat publisher leaks if executor crashes without emitting `turn.done` | Medium | Tie publisher lifecycle to bridge teardown (shutdown handler clears all intervals) and to `handleSessionReset`. Add a watchdog that auto-stops a publisher if its session is missing from `this.sessions` for two consecutive ticks. |
| Tmux PTY busy-predicate is heuristic and may misclassify (e.g. waiting on user permission prompt looks idle) | Medium | Permission-prompt state IS effectively idle — we WANT the nudge in that case so the user gets reminded. So this is correct behavior, not a bug. Document it. |
| Cross-repo lockstep: genie ships heartbeat without omni consumer | Low | By Decision 6, it is safe — heartbeats are dropped on the floor, current behavior preserved. Same in reverse. The order of merging does not matter. |
| `turnService.recordActivity` is not idempotent or has unexpected side effects at 30s cadence | Low | Verified at `packages/api/src/services/turns.ts:69-72`: a single SQL UPDATE setting `lastActivityAt = now()`. Cheap and idempotent. Confirm during Group 1. |
| Heartbeat traffic floods NATS on hosts with many concurrent sessions | Low | One event per session every 30s is trivial: 1000 active sessions = ~33 events/second. NATS handles >10⁵/s. Quotable in the docs. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
genie repo (automagik-genie/genie):
  CREATE  src/services/agent-heartbeat.ts
  CREATE  src/services/__tests__/agent-heartbeat.test.ts
  CREATE  src/services/__tests__/heartbeat-e2e.test.ts
  MODIFY  src/services/omni-bridge.ts                   (start/stop publisher in routeTurnEvent + shutdown)
  MODIFY  src/services/executors/claude-sdk.ts          (expose isBusy() predicate)
  MODIFY  src/services/executors/claude-code.ts         (expose isBusy() predicate)
  MODIFY  src/services/executor.ts                       (add isBusy() to interface)

omni repo (automagik/omni):
  CREATE  packages/api/src/services/agent-heartbeat.ts
  CREATE  packages/api/src/services/__tests__/agent-heartbeat.test.ts
  MODIFY  packages/api/src/services/turn-events.ts       (add AgentHeartbeatEvent interface OR new agent-events.ts)
  MODIFY  packages/api/src/index.ts (or wherever initTurnEvents is wired) — add initAgentHeartbeat
  MODIFY  packages/api/src/services/turn-monitor.ts      (docstring: activity reset now also via heartbeat)

docs (this server):
  MODIFY  /home/genie/workspace/agents/genie-configure/.claude/rules/omni-reference.md   (event types table)
```
