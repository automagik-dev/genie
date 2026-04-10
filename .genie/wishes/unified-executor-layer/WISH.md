# Wish: Unified Executor Layer

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `unified-executor-layer` |
| **Date** | 2026-04-04 |
| **Supersedes** | `automagik-dev/genie#1042` (close, do not merge) |
| **Reconciles** | `genie-omni-marriage` (adds explicit bridge-process footnote) |
| **Repo** | `automagik-dev/genie` |

## Summary

Genie has two parallel session/executor subsystems. "World A" is the mature registry (`agents`, `executors`, `sessions`, `session_content`, `audit_events`, `executor-registry.ts`, `session-capture.ts`, `genie sessions` CLI, PG LISTEN/NOTIFY). "World B" is the omni bridge (`services/executor.ts`, `services/omni-bridge.ts`, `services/executors/claude-sdk.ts`) — it never touches World A. This wish **merges World B into World A**: the omni bridge becomes a thin NATS subscriber that calls `createAndLinkExecutor`, the SDK executor registers in the `executors` table with transport `'api'`, session content is emitted inline by the SDK executor (since it has no JSONL filewatch source), and the backend becomes a runtime flip switch via `GENIE_EXECUTOR=tmux|sdk`. Result: one CLI surface (`genie ls`, `genie sessions`, `genie kill`, `genie events timeline`), one observability pipeline (audit_events), one transparent USB between Claude Code and Claude Agent SDK.

PR #1042 attempted a similar goal but added a third registry (`omni_sessions` table) inside World B. This wish closes #1042 and extracts only its legitimately salvageable ideas (lazy resume via stored `claude_session_id`) into the right files.

## Scope

### IN

1. **Merge World B into World A's executor registry**
   - `services/executors/claude-sdk.ts` calls `lib/executor-registry.createAndLinkExecutor()` on spawn with `transport='api'`
   - State transitions (`spawning → running → idle → working → …`) go through `updateExecutorState()`
   - `shutdown()` calls `terminateExecutor()` and updates agent's `current_executor_id`
   - Metadata JSONB carries `{ source: 'omni', chat_id, instance_id }`
2. **Emit session content from SDK executor inline**
   - As Claude SDK streams response messages, write `session_content` rows (turn index, role, content, tool_name, timestamp)
   - Write `audit_events` for `spawn`, `deliver_start`, `deliver_end`, `tool_use`, `shutdown` so OTel pipeline sees the session
   - Mirror what `session-capture.ts` produces for tmux sessions — same shape, same tables, same queries
3. **Refactor `services/omni-bridge.ts`**
   - Remove in-memory session Map; look up sessions via `executor-registry` queries filtered by metadata `source='omni'`
   - On NATS inbound message: find-or-create executor via `createAndLinkExecutor`, then call `executor.deliver()`
   - Idle timeout and max concurrency logic stays in the bridge (it's a dispatcher concern, not an executor concern)
4. **Delete or demote `services/executor.ts`**
   - If it's fully subsumed by World A's interface, delete the file
   - Otherwise reduce to a ≤20-line adapter that re-exports World A types
   - `OmniSession` interface (with hardcoded `tmuxSession`, `tmuxPaneId`, `paneId` fields) is replaced by World A's `Executor` type
5. **Restore NATS reply path**
   - Revert PR #1042's `execFile('omni', 'send', …)` change
   - `ClaudeSdkOmniExecutor` publishes reply via `nc.publish('omni.reply.<instance>.<chat>', …)` as before
   - `setNatsPublish(fn)` hook is restored on the executor
6. **PG optional, degraded mode**
   - Bridge start does not `process.exit(1)` if PG is unavailable
   - Falls back to in-memory executor tracking (no session recovery across restarts)
   - Logs `[omni-bridge] PG unavailable — session recovery disabled` on startup
   - Executor registry calls are wrapped in PG-available guard; no-ops in degraded mode
7. **Lazy resume via executor lookup** (PR #1042's good idea, correct placement)
   - On spawn, before creating a new executor, query `executors` table for `WHERE metadata->>'source'='omni' AND metadata->>'chat_id'=<chat> AND agent_id=<agent> AND ended_at IS NULL` ordered by `started_at DESC LIMIT 1`
   - If found, reuse its `claude_session_id` for SDK resume; update existing executor row rather than creating new
   - If not found OR Claude backend rejects resume, create fresh executor and log the fallback to audit_events
8. **Flip switch: `GENIE_EXECUTOR=tmux|sdk`**
   - Env var controls which executor the bridge uses
   - `genie omni start --executor sdk|tmux` CLI flag override
   - `genie config set executor <value>` for persistent config
   - Optional: extend to `genie spawn --executor sdk` for human/team spawns (stretch — may defer)
9. **Collapse `genie omni` CLI**
   - Final surface: `genie omni start`, `genie omni stop`, `genie omni status`
   - `start` accepts `--executor sdk|tmux` and passes through
   - `status` shows: bridge process state, NATS connection, active executors (via World A query filtered by metadata `source='omni'`), idle timer, queue depth
   - Delete any `genie omni sessions/logs/config/kill/reset` subcommands if #1042 landed
10. **`source` filter in existing CLIs**
    - `genie ls --source omni` and `genie sessions list --source omni` filter by `executors.metadata->>'source'`
    - No new commands, just a filter flag on existing ones
11. **Close PR #1042**
    - Post a closing comment linking this wish
    - Salvage the lazy-resume concept (reimplemented in Group 7 against executors table, not a new `omni_sessions` table)
    - Do not merge #1042
12. **Reconciliation note on `genie-omni-marriage`**
    - Update `.genie/wishes/genie-omni-marriage/WISH.md` with a short footnote: "The omni-bridge NATS subscriber process exists as of [date]. It is a single optional PM2 service, not a genie daemon. Genie-as-CLI boundary preserved — the bridge is a message source, not a state owner. Sessions live in genie's existing `executors` table."

### OUT

- Renaming `genie omni` to `genie bridge` (user decision: keep `genie omni`, only 3 commands)
- New `omni_sessions` PG table (PR #1042's design — rejected; use existing `executors` table)
- Multi-bridge HA, load balancing, failover (separate wish)
- New message sources beyond terminal/team/omni (no cron/scheduler integration here)
- OTel exporter changes, new metrics dashboards (use existing `audit_events`/`session-capture` pipeline)
- Changes to the Omni server or its API
- Full migration of `sessions.agent_id` → `sessions.executor_id` (deferred per migration 012 comment)
- Worktree isolation for omni-sourced sessions (already shipped in `omni-session-isolation`)
- Deleting the `omni_sessions` table (only relevant if #1042 lands before this wish; handled as Group 0 cleanup if needed)
- `genie send` / `genie kill` / `genie logs` CLI changes — they already work for World A and will cover omni sessions automatically once those sessions register in `executors` table
- Rewriting the tmux executor (it's already partially integrated; Group 4 only verifies it, doesn't refactor it)
- SDK executor support for tools beyond what the existing SDK provider already exposes

## Decisions

| Decision | Rationale |
|----------|-----------|
| Merge World B into World A, not the other way around | World A is mature (8+ migrations, full state machine, capture pipeline, CLI, observability). World B is a thin 400-line duplicate. Merge direction is obvious. |
| SDK executor uses `transport='api'` | The enum already supports `'tmux' \| 'api' \| 'process'`. Zero migration cost. |
| Source carried via `metadata` JSONB, not new column | Additive, no migration. Filterable with `metadata->>'source'='omni'` JSONB operators. Indexed later if hot. |
| SDK executor emits `session_content` inline, not via filewatch | No JSONL files exist for in-process SDK. Replicate capture inline (~200-300 LOC: helper module + deliver() integration + turn indexing + tool event mapping + audit hooks + tests). This is the unavoidable new code. |
| Reply path stays NATS publish | PR #1042's `execFile('omni', …)` is a ~230ms per-reply fork. In-process `nc.publish` is microseconds. No contest. |
| PG optional with degraded mode | Hard-gating PG kills local dev onboarding. Degraded mode (no recovery across restarts) is acceptable for dev. |
| Lazy resume via `executors` table query, not new table | PR #1042 created `omni_sessions` unnecessarily. The `executors.claude_session_id` column already exists on the right table. |
| `GENIE_EXECUTOR` env var as flip switch | Single point of control. Human can override per-invocation with `--executor` flag. Persistable via `genie config set`. |
| Keep `genie omni` namespace | User explicit decision. Only 3 commands (start/stop/status) — all about the bridge **process**, not about sessions. No naming collision because the bridge is a long-lived service. |
| Close PR #1042 without merging | ~75% of its changes are wrong direction (execFile reply, PG mandatory, new CLI commands, new table). Salvaging in-place costs more than rebuilding on World A. |
| Do not rename `OmniSession` to `Executor` in tests | Tests should be rewritten to use World A types directly after refactor, not bridge-and-adapt. Cleaner diff. |

## Success Criteria

- [ ] `genie ls` shows SDK-backed omni sessions alongside tmux-backed genie sessions (confirmed by spawning via both paths and listing)
- [ ] `genie sessions list --source omni` returns only omni-sourced executors, matching what's in `executors` table
- [ ] `genie events timeline <executor-id>` returns audit events for an SDK-backed omni session (spawn, deliver_start, deliver_end, shutdown)
- [ ] `genie kill <executor-id>` terminates an SDK-backed omni session and the bridge stops delivering to it
- [ ] `genie sessions replay <session-id>` shows turn-by-turn content for an SDK-backed omni session
- [ ] Restarting the omni bridge recovers the `claude_session_id` from the `executors` table for in-flight chats (within Claude backend TTL); logs a fallback audit event when TTL is exceeded
- [ ] `GENIE_EXECUTOR=sdk` makes `genie omni start` run the SDK executor; `GENIE_EXECUTOR=tmux` runs the tmux executor; no code changes needed to switch
- [ ] `genie omni start --executor sdk` overrides the env var for that invocation
- [ ] Reply path uses `nc.publish('omni.reply.<inst>.<chat>', …)` — no subprocess forks per reply (verified by tracing `execFile` calls in runtime)
- [ ] Bridge starts successfully when PG is offline, logs a warning, runs in degraded mode (no recovery)
- [ ] `services/executor.ts` is deleted OR reduced to ≤20 lines re-exporting from `lib/executor-types.ts`
- [ ] `services/omni-bridge.ts` no longer maintains an in-memory session Map; all session queries go through `executor-registry`
- [ ] `genie omni` CLI has exactly 3 subcommands: `start`, `stop`, `status` (plus `start`'s `--executor` flag)
- [ ] PR #1042 is closed (not merged) with a comment linking this wish
- [ ] `genie-omni-marriage` wish has a reconciliation footnote
- [ ] Matrix test: all 6 combinations of (tmux \| sdk) × (human \| team \| omni) spawn, appear in `genie ls`, emit audit events, and can be killed via `genie kill`
- [ ] `bun run check` passes (typecheck + lint + all tests, including the bun `mock.module` leak fix)
- [ ] Zero regressions in existing `genie sessions list/replay/search` behavior

## Execution Strategy

### Wave 1 (parallel — foundations, no dependencies)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | trace | Audit all callers/consumers of `services/executor.ts`, `services/omni-bridge.ts`'s session Map, and `services/executors/*.ts`. Produce a deletion/refactor map. |
| 2 | engineer | Restore NATS reply path in `services/executors/claude-sdk.ts` (revert #1042's `execFile` change; restore `setNatsPublish` hook) |
| 3 | engineer | PG-optional bridge startup — replace `process.exit(1)` in `omni-bridge.ts` with warning + degraded mode guard |

### Wave 2 (after Wave 1 — core refactor)

Order within Wave 2 matters: **4 → 5 → 7 → 6**. Group 5 defines the shared audit-event enum and `safePgCall`. Group 7 adds the metadata index and `findLatestByMetadata`. Group 6 then consumes both.

| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Register SDK executor in World A: call `createAndLinkExecutor(agentId, 'claude', 'api', {claudeSessionId, metadata: {source: 'omni', chat_id, instance_id}})` on spawn; `updateExecutorState` on transitions; `terminateExecutor` on shutdown |
| 5 | engineer | Inline `session_content` emission + shared `src/lib/audit-events.ts` enum. As Claude SDK streams, write rows to `sessions` + `session_content` + `audit_events` tables. Match shape produced by `session-capture.ts`. |
| 7 | engineer | Migration 027 (JSONB metadata index) + `findLatestByMetadata` helper + lazy resume: on spawn, query latest un-ended executor for (agent_id, source='omni', chat_id); reuse `claude_session_id` if found; handle SDK resume rejection with fallback + audit log |
| 6 | engineer | Refactor `omni-bridge.ts` to delegate find-or-create to the executor (which uses `findLatestByMetadata` from Group 7). Delete in-memory session Map. No query duplication. |

### Wave 3 (after Wave 2 — CLI + flip switch)

| Group | Agent | Description |
|-------|-------|-------------|
| 8 | engineer | `GENIE_EXECUTOR` flip switch: env var parsing, `genie config set executor <tmux\|sdk>`, `genie omni start --executor <tmux\|sdk>` override, bridge reads resolved value at startup |
| 9 | engineer | Collapse `src/term-commands/omni.ts` to exactly `start` / `stop` / `status`. If PR #1042 landed before this wish, delete its added subcommands. `status` reads executors via World A query. |
| 10 | engineer | Add `--source <name>` filter to `genie ls` and `genie sessions list` via `metadata->>'source'` JSONB filter |

### Wave 4 (after Wave 3 — cleanup + validation)

| Group | Agent | Description |
|-------|-------|-------------|
| 11 | engineer | Delete `services/executor.ts` if fully subsumed (or reduce to ≤20-line adapter). Delete `OmniSession` references; replace with World A `Executor` type. |
| 12 | engineer | Close PR #1042 with closing comment linking this wish. Append reconciliation footnote to `genie-omni-marriage/WISH.md`. |
| qa | qa | Run the 6-combination matrix test: (tmux \| sdk) × (human \| team \| omni). Verify `genie ls`, `genie kill`, audit events for all six. |
| review | reviewer | Review all changes against success criteria |

## Execution Groups

### Group 1: Audit callers

**Goal:** Produce a complete map of what depends on World B so later groups know what to touch.

**Deliverables:**
1. List every import of `services/executor.ts`, `services/executors/claude-code.ts`, `services/executors/claude-sdk.ts`, `services/omni-bridge.ts`
2. Identify tests that assert on `OmniSession` fields (`tmuxSession`, `tmuxWindow`, `paneId`) — these need rewrites
3. List all call sites of the in-memory session Map in `omni-bridge.ts`
4. Identify any CLI commands that import from World B directly (beyond `term-commands/omni.ts`)
5. Output a markdown report at `.genie/wishes/unified-executor-layer/AUDIT.md`

**Acceptance Criteria:**
- [ ] Report lists every file that imports World B modules
- [ ] Report identifies tests with tmux-field assertions
- [ ] Report flags any surprise dependencies (e.g., TUI modules, other services)
- [ ] Report proposes a deletion order (which files can go first without breaking builds)

**Validation:**
```bash
# Report exists and is non-empty
test -s .genie/wishes/unified-executor-layer/AUDIT.md
```

**depends-on:** none

---

### Group 2: Restore NATS reply path

**Goal:** Reply goes back via `nc.publish`, not subprocess fork.

**Deliverables:**
1. In `src/services/executors/claude-sdk.ts`: remove `sendViaOmniCli` / `execFileAsync` / `node:child_process` imports
2. Restore `private natsPublish: ((topic: string, payload: string) => void) \| null = null;`
3. Restore `setNatsPublish(fn)` method
4. Reply path uses `this.natsPublish(topic, payload)` with topic `omni.reply.${message.instanceId}.${message.chatId}`
5. In `src/services/omni-bridge.ts`: restore the `setNatsPublish` wiring inside `start()` when executor is `ClaudeSdkOmniExecutor`
6. Update `claude-sdk.test.ts` to assert `natsPublish` was called with correct topic/payload (revert the `execFile` assertion)

**Acceptance Criteria:**
- [ ] No `execFile`/`execFileAsync`/`node:child_process` import in `claude-sdk.ts`
- [ ] `setNatsPublish` hook exists and is called by bridge
- [ ] Tests assert NATS publish, not execFile
- [ ] Tracing the code path from `deliver()` shows a single in-process publish call, not a subprocess spawn

**Validation:**
```bash
cd genie && bun run typecheck && bun run lint && bun test src/services/executors/__tests__/claude-sdk.test.ts
# Grep must find zero matches
! grep -q "execFile\|child_process" src/services/executors/claude-sdk.ts
```

**depends-on:** none

---

### Group 3: PG optional, degraded mode

**Goal:** Bridge starts without PG. No `process.exit(1)`. Clear error handling strategy for PG failures during runtime.

**PG Error Handling Strategy (explicit):**

| Failure Type | Strategy | Rationale |
|--------------|----------|-----------|
| **Startup connect** (initial `SELECT 1`) | Fail-fast with graceful degradation: log warning, set `pgAvailable=false`, continue in degraded mode | Never block bridge startup; a dev without PG must still be able to run omni |
| **Runtime write** (executor state update, audit event insert, session_content insert) | Try once, log error with context, continue; do NOT retry inline, do NOT crash the delivery loop | A single failed write should never drop a user-visible message. Dropped observability is recoverable; dropped replies are not. |
| **Runtime read** (lazy resume lookup) | Try once with 2s query timeout; on failure or timeout, fall back to "no prior session" path and log; do NOT block message delivery | Slow PG must not slow human replies |
| **Connection loss mid-run** | On any write error classified as connection-level (ECONNREFUSED, connection terminated), set `pgAvailable=false` and log `[omni-bridge] PG connection lost — switching to degraded mode`; do not try to reconnect (operator restarts bridge) | Simple and predictable. Reconnect logic belongs in a later wish. |
| **Migration missing / schema mismatch** | Fail-fast on startup with clear error message pointing at migration command | Silent data corruption is worse than noisy failure |

All strategies: log at `warn` level with `executor_id` (when known), `chat_id`, and the operation name. Never log PG error stack traces at `info`.

**Deliverables:**
1. In `src/services/omni-bridge.ts` `start()`:
   - Remove the `process.exit(1)` on failed `SELECT 1`
   - Wrap the check in a boolean `this.pgAvailable`
   - Log `[omni-bridge] PG unavailable — session recovery disabled` when false
2. Expose `pgAvailable` on `BridgeStatus` interface
3. All downstream executor calls that write to PG check `this.pgAvailable` and no-op (with a trace log) when false
4. Wrap each PG call site in a helper `safePgCall<T>(op: string, fn: () => Promise<T>, fallback: T): Promise<T>` that implements the runtime write/read strategy above (single attempt, log on failure, return fallback, flip `pgAvailable=false` on connection-level errors)
5. Unit test: start a bridge with a broken PG connection string; assert `start()` succeeds and `status().connected === true` for NATS but `status().pgAvailable === false`
6. Unit test: inject a mid-run PG error; assert `safePgCall` returns fallback and `pgAvailable` flips to `false`; assert delivery loop continues

**Acceptance Criteria:**
- [ ] Bridge starts with PG offline, no exit
- [ ] `BridgeStatus` exposes `pgAvailable` boolean
- [ ] Runtime PG errors never drop a user reply
- [ ] `safePgCall` helper is the only way downstream code touches PG
- [ ] Tests cover: degraded startup, mid-run connection loss, slow query fallback

**Validation:**
```bash
bun test src/services/__tests__/omni-bridge.test.ts
```

**depends-on:** none

---

### Group 4: SDK executor registers in World A

**Goal:** SDK-backed omni sessions appear in the `executors` table with `transport='api'`.

**Deliverables:**
1. In `src/services/executors/claude-sdk.ts`:
   - Import `createAndLinkExecutor`, `updateExecutorState`, `terminateExecutor`, `getExecutor` from `lib/executor-registry.js` (real API — verified against `origin/dev:src/lib/executor-registry.ts` lines 84, 137, 151, 119)
   - Import `findOrCreateAgent` (or equivalent) from `lib/agent-registry.js`
   - On `spawn(agentName, chatId, env)`:
     - Call `agent-registry.findOrCreateAgent(agentName, …)` to get `agentId`
     - Call `createAndLinkExecutor(agentId, 'claude', 'api', { claudeSessionId: undefined, metadata: { source: 'omni', chat_id: chatId, instance_id: env.OMNI_INSTANCE_ID } })`
     - Store the returned `Executor` in place of the ad-hoc in-memory state (or alongside it during transition)
   - On state transitions (before/after query): call `updateExecutorState(executorId, 'running' \| 'working' \| 'idle')`
   - On `shutdown`: call `terminateExecutor(executorId)` (which sets `ended_at` and state `'terminated'`) and clear agent's `current_executor_id` link
   - Guard all calls with `this.pgAvailable` from Group 3 — no-op in degraded mode
2. Remove the `SdkSessionState` Map approach where possible (keep AbortController tracking but source executor data from PG)
3. `OmniSession` fields that don't apply (`tmuxSession`, `tmuxWindow`, `paneId`) are stubbed with empty strings for now — full removal in Group 11
4. Update `claude-sdk.test.ts` to mock `executor-registry` calls and assert they happen

**Acceptance Criteria:**
- [ ] `spawn()` creates a row in `executors` with `transport='api'` and metadata `{source, chat_id, instance_id}`
- [ ] State transitions are reflected in `executors.state`
- [ ] `shutdown()` sets `ended_at` and state `'terminated'`
- [ ] Tests mock the registry and assert the right calls
- [ ] Code runs in degraded mode (no PG) without errors

**Validation:**
```bash
bun run typecheck && bun test src/services/executors/__tests__/claude-sdk.test.ts
# Manual: start bridge, send one WhatsApp message, query `SELECT * FROM executors WHERE transport='api'`
```

**depends-on:** Group 3

---

### Group 5: Inline session content capture for SDK

**Goal:** SDK-backed sessions produce the same `session_content` + `audit_events` rows that `session-capture.ts` produces for tmux sessions.

**Shared Audit Event Type Enum (used by Groups 5 and 7):**

Defined in `src/lib/audit-events.ts` as a single source of truth. Groups 5 and 7 MUST use these exact strings — no ad-hoc variants.

```typescript
export type AuditEventType =
  // Lifecycle (Group 5)
  | 'executor.spawn'
  | 'executor.shutdown'
  | 'executor.state_transition'
  // Delivery (Group 5)
  | 'deliver.start'
  | 'deliver.end'
  | 'deliver.error'
  | 'deliver.tool_use'
  // Resume (Group 7)
  | 'session.resumed'
  | 'session.resume_rejected'
  | 'session.created_fresh';
```

Naming convention: `<domain>.<event>` dotted. All new audit events for this wish live in this enum; no string literals elsewhere. Existing audit event strings in the codebase stay as-is unless a group explicitly touches them.

**Deliverables:**
1. New `src/lib/audit-events.ts` with the `AuditEventType` union above and a `recordAuditEvent(type: AuditEventType, attrs: Record<string, unknown>)` helper that wraps the existing audit_events insert with `safePgCall` (from Group 3)
2. Helper module `src/services/executors/sdk-session-capture.ts`:
   - `startSession(executorId, claudeSessionId, agentId, team, role, wishSlug?)` → creates a row in `sessions` table
   - `recordTurn(sessionId, turnIndex, role, content, toolName?, timestamp)` → writes `session_content`
   - `recordToolEvent(sessionId, turnIndex, toolName, inputRaw, outputRaw, timestamp)` → writes to tool events table (reuse whatever `session-capture.ts` writes to)
   - `endSession(sessionId, status)` → updates `sessions.ended_at`, `sessions.status`
   - All writes go through `safePgCall`
3. In `claude-sdk.ts` `deliver()`:
   - Call `startSession` on first message for the executor (or during spawn if the Claude session is pre-created)
   - As the SDK query streams, iterate messages and call `recordTurn` / `recordToolEvent` per turn
   - Call `recordAuditEvent('executor.spawn' | 'deliver.start' | 'deliver.end' | 'deliver.tool_use' | 'executor.shutdown', attrs)` with consistent attribute keys: `{ executor_id, agent_id, chat_id, instance_id, session_id }`
   - Update `sessions.total_turns` and `sessions.last_ingested_offset` (use turn count as pseudo-offset since there's no JSONL file)
4. All writes guarded by `pgAvailable` via `safePgCall`
5. Test: deliver two messages to a fake SDK session, assert `session_content` has 2 rows and `audit_events` has `deliver.start`/`deliver.end` pairs with expected attrs

**Acceptance Criteria:**
- [ ] `sessions` row exists for every SDK-backed omni session
- [ ] `session_content` rows mirror the shape produced by tmux filewatch (same columns, same roles)
- [ ] `audit_events` rows exist for spawn/deliver/shutdown
- [ ] `genie sessions replay <id>` works against an SDK session end-to-end
- [ ] No writes happen in degraded mode

**Validation:**
```bash
bun test src/services/executors/__tests__/sdk-session-capture.test.ts
# Manual end-to-end:
GENIE_EXECUTOR=sdk genie omni start &
# send a test WhatsApp message
genie sessions replay <session-id>  # should show the content
```

**depends-on:** Group 4

---

### Group 6: Refactor omni-bridge to use World A

**Goal:** `omni-bridge.ts` has no in-memory session Map. All session state comes from PG.

**Deliverables:**
1. Delete the `sessions: Map<string, SessionEntry>` field in `OmniBridge`
2. On inbound NATS message:
   - Parse `agent`, `chatId`, `instanceId` from the message
   - Resolve `agentId` via `agent-registry.findOrCreateAgent(agent)`
   - Delegate lookup to the executor: call `executor.spawn(agentName, chatId, env)` which internally uses `executor-registry.findLatestByMetadata({ agentId, source: 'omni', chatId })` (the same helper added in Group 7) to find-or-create
   - The bridge does NOT duplicate the query logic — it delegates to the executor, which owns the find-or-create contract. This keeps one query path shared between spawn-on-new-message and restart-resume, so Group 7's index covers both.
   - Call `executor.deliver()` with the message
3. Idle timeout logic:
   - Keep an in-memory Map of `executorId → idleTimer` (small, timer-only, not session state)
   - On timer fire: call `executor.shutdown()` which updates PG state
4. Queue depth and max concurrency logic stays but queries active executor count from PG (cached with short TTL)
5. Replace `BridgeStatus.sessions` with a PG query at status time
6. Degraded mode: if PG unavailable, fall back to in-memory Map (current behavior) with a clear warning

**Acceptance Criteria:**
- [ ] No `Map<string, SessionEntry>` for session state in `omni-bridge.ts`
- [ ] NATS inbound handler does find-or-create via PG
- [ ] `genie omni status` shows correct active count, matching what `SELECT count(*) FROM executors WHERE ended_at IS NULL AND metadata->>'source'='omni'` returns
- [ ] Degraded mode works — bridge processes messages without PG
- [ ] Existing idle timeout and concurrency limit tests pass

**Validation:**
```bash
bun test src/services/__tests__/omni-bridge.test.ts
```

**depends-on:** Group 4, Group 5, Group 7 (find-or-create helper + metadata index live in Group 7; Group 6 consumes them)

---

### Group 7: Lazy resume via executors table + metadata index

**Goal:** Bridge restart recovers in-flight Claude sessions by looking up `executors.claude_session_id`. Lookup stays fast even as executor count grows.

**Deliverables:**
1. New migration `src/db/migrations/027_executors_omni_metadata_index.sql` — indexes the JSONB metadata fields that Group 6's find-or-create and Group 7's lazy resume both query on every inbound message:
   ```sql
   CREATE INDEX IF NOT EXISTS executors_omni_lookup
     ON executors (
       agent_id,
       (metadata->>'source'),
       (metadata->>'chat_id')
     )
     WHERE ended_at IS NULL;

   -- Optional covering index if resume path becomes hot:
   -- CREATE INDEX IF NOT EXISTS executors_omni_resume
   --   ON executors (agent_id, (metadata->>'source'), (metadata->>'chat_id'), started_at DESC)
   --   INCLUDE (claude_session_id, state)
   --   WHERE ended_at IS NULL;
   ```
2. Add `executor-registry.findLatestByMetadata(filter: { agentId: string; source: string; chatId: string }): Promise<Executor | null>` — queries ordered by `started_at DESC LIMIT 1` with `ended_at IS NULL`. Signature is explicit (not a generic `Record<string, unknown>`) so the index above is always used.
3. In `claude-sdk.ts` `spawn()`:
   - Before calling `createAndLinkExecutor`, call `findLatestByMetadata({ agentId, source: 'omni', chatId })`
   - If found AND `claudeSessionId` is set, **reuse** this executor (do not create new). Update `last_activity_at` via `updateExecutorState(executor.id, 'running')`. Write `recordAuditEvent('session.resumed', …)`.
   - If found but `claudeSessionId` is null, still reuse — the Claude session will be set when first query returns
   - If not found, create new executor and write `recordAuditEvent('session.created_fresh', …)`
4. In `deliver()`:
   - Pass `state.claudeSessionId` to `runQuery` as the `resume` parameter
   - After query returns, if SDK returned a different session ID (Claude rejected resume), update `executors.claude_session_id` via registry and write `recordAuditEvent('session.resume_rejected', { old_session_id, new_session_id, executor_id })`
5. All new audit events use the shared enum from Group 5's `src/lib/audit-events.ts` — no string literals.

**Acceptance Criteria:**
- [ ] Migration 027 applies cleanly; `EXPLAIN` on the find-latest-by-metadata query shows index use
- [ ] Restarting the bridge mid-conversation and sending another WhatsApp message resumes the same Claude session (within TTL)
- [ ] When Claude rejects resume (TTL expired), a fresh session is created and `session.resume_rejected` audit event is written
- [ ] `genie events timeline <executor-id>` shows `session.resumed` / `session.resume_rejected` / `session.created_fresh` events clearly
- [ ] Test: mock Claude SDK to alternate resume success/fail and verify both paths

**Validation:**
```bash
bun run migrate:test  # ensure migration 027 applies
bun test src/services/executors/__tests__/claude-sdk-resume.test.ts
# Verify index is used:
psql -c "EXPLAIN SELECT * FROM executors WHERE agent_id='<id>' AND metadata->>'source'='omni' AND metadata->>'chat_id'='<chat>' AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1" | grep "executors_omni_lookup"
```

**depends-on:** Group 4, Group 5 (for the shared audit event enum)

---

### Group 8: `GENIE_EXECUTOR` flip switch

**Goal:** One env var picks the executor.

**Deliverables:**
1. `src/lib/executor-config.ts`: `resolveExecutorType(override?: string): 'tmux' \| 'sdk'` — reads override > env `GENIE_EXECUTOR` > persisted config > default `'tmux'`
2. `omni-bridge.ts` constructor calls `resolveExecutorType(config.executorType)` — no change to existing flag, just use this helper
3. `genie config set executor <tmux\|sdk>` subcommand — persists to genie's config file (wherever existing `genie config` writes)
4. `genie omni start --executor <tmux\|sdk>` flag — passes to `resolveExecutorType` as override
5. `genie omni status` shows resolved executor type
6. Documentation in `.genie/wishes/unified-executor-layer/FLIP-SWITCH.md` explaining precedence

**Acceptance Criteria:**
- [ ] `GENIE_EXECUTOR=sdk genie omni start` runs SDK executor
- [ ] `genie omni start --executor tmux` overrides env var
- [ ] `genie config get executor` returns persisted value
- [ ] Precedence order is tested

**Validation:**
```bash
bun test src/lib/__tests__/executor-config.test.ts
```

**depends-on:** Group 6

---

### Group 9: Collapse `genie omni` CLI

**Goal:** `genie omni` has exactly 3 subcommands.

**Deliverables:**
1. `src/term-commands/omni.ts` contains only `start`, `stop`, `status`
2. `start` accepts `--executor <tmux\|sdk>` (Group 8)
3. `status` reads active executors from PG (if available) + bridge process state
4. Delete any `sessions`/`logs`/`config`/`kill`/`reset` subcommands if present from PR #1042
5. File size should drop back to ~100-150 lines (from 300+ after #1042)

**Acceptance Criteria:**
- [ ] `genie omni --help` lists exactly: `start`, `stop`, `status`
- [ ] Removed commands are gone from the file
- [ ] `status` query shape matches World A (via `executor-registry`)

**Validation:**
```bash
genie omni --help | grep -E "^\s+(start|stop|status|sessions|logs|config)" | sort
# Expected: only start/stop/status
```

**depends-on:** Group 6, Group 8

---

### Group 10: `--source` filter on existing CLIs

**Goal:** `genie ls --source omni` and `genie sessions list --source omni` work.

**Deliverables:**
1. Add `--source <name>` option to `genie ls` (`term-commands/agent/list.ts` or wherever the ls handler lives)
2. Add `--source <name>` option to `genie sessions list` (`term-commands/sessions.ts`)
3. Both filter `executors` rows via `WHERE metadata->>'source' = <value>`
4. When no source is specified, return all (current behavior)
5. Add `--source` to `--help` output
6. Test: spawn executors with different metadata sources; verify filter returns correct subset

**Acceptance Criteria:**
- [ ] `genie ls --source omni` returns only omni-sourced executors
- [ ] `genie sessions list --source omni` returns only omni sessions
- [ ] No source filter preserves existing output
- [ ] Tests cover the filter path

**Validation:**
```bash
bun test src/term-commands/__tests__/sessions.test.ts
```

**depends-on:** Group 4

---

### Group 11: Delete or demote `services/executor.ts`

**Goal:** World B's parallel interface is gone.

**Deliverables:**
1. Audit (from Group 1) tells us what still imports `services/executor.ts`
2. Option A: if nothing imports it, delete the file
3. Option B: if small surface still needed, reduce to ≤20 lines re-exporting World A types (`Executor`, `ExecutorState`, etc.)
4. Update `services/executors/claude-code.ts` and `claude-sdk.ts` to import from `lib/executor-types.js`, not `../executor.js`
5. Remove `OmniSession` interface; replace with `Executor` from World A (may require renaming variables in `omni-bridge.ts`)
6. `OmniMessage` can stay — it's a NATS payload shape, not a session shape

**Acceptance Criteria:**
- [ ] `services/executor.ts` is either deleted or ≤20 lines
- [ ] No references to `OmniSession` in `src/`
- [ ] `bun run check` passes
- [ ] `bun run knip` shows no new unused exports

**Validation:**
```bash
bun run check
! grep -r "OmniSession" src/ --include="*.ts" | grep -v ".test.ts"
```

**depends-on:** Group 6, Group 9

---

### Group 12: Close PR #1042 + reconciliation

**Goal:** Cleanup. PR #1042 is closed with context. `genie-omni-marriage` wish reflects reality.

**Deliverables:**
1. Post a closing comment on `automagik-dev/genie#1042` with a summary of why and a link to this wish:
   > This PR tackled a real problem (session persistence across bridge restarts) but added a third session registry (`omni_sessions` table) alongside two existing ones in genie core. We've opted to unify the layers instead — see wish `unified-executor-layer`. The lazy-resume idea is preserved, reimplemented against the existing `executors` table with `transport='api'`. Reply path stays NATS publish (the `execFile('omni', …)` change would have introduced a ~230ms per-reply fork). Thanks for the push on making this visible — closing in favor of the unified path.
2. `gh pr close 1042 --comment "..."`
3. Append reconciliation note to `.genie/wishes/genie-omni-marriage/WISH.md`:
   > **2026-04-04 footnote:** The `omni-bridge` NATS subscriber process exists as a single optional PM2 service. It is a message source, not a state owner — all session state lives in genie's existing `executors`/`sessions` tables. The "Genie = CLI, never a server" boundary is preserved: the bridge is a CLI subcommand (`genie omni start`) that happens to be long-lived, not a genie daemon with its own state store.
4. If any docs under `docs/` reference the removed CLI commands, update them

**Acceptance Criteria:**
- [ ] PR #1042 is closed (state = CLOSED, not MERGED)
- [ ] Closing comment is posted with wish link
- [ ] `genie-omni-marriage` wish has the footnote
- [ ] Docs are updated if needed

**Validation:**
```bash
gh pr view 1042 --repo automagik-dev/genie --json state | jq -r '.state'
# Expected: "CLOSED"
```

**depends-on:** Group 11

---

### QA Group: 6-combination matrix test

**Goal:** Prove the unified layer works for every (executor × source) combination.

**Deliverables:**
1. Test plan at `.genie/wishes/unified-executor-layer/QA-MATRIX.md`
2. Execute all 6:
   - tmux × human (`genie spawn engineer` in terminal)
   - tmux × team (`genie team create foo --repo ... --wish ...`)
   - tmux × omni (WhatsApp → `GENIE_EXECUTOR=tmux genie omni start`)
   - sdk × human (`GENIE_EXECUTOR=sdk genie spawn engineer` — if supported; else skip with note)
   - sdk × team (if supported; else skip)
   - sdk × omni (WhatsApp → `GENIE_EXECUTOR=sdk genie omni start`)
3. For each: verify `genie ls` shows it, `genie sessions list` shows it, `genie events timeline <id>` returns audit events, `genie kill <id>` terminates cleanly

**Acceptance Criteria:**
- [ ] All supported combinations verified
- [ ] Unsupported combinations explicitly skipped with reasoning
- [ ] Evidence captured in QA-MATRIX.md

**Validation:**
```bash
cat .genie/wishes/unified-executor-layer/QA-MATRIX.md
# Should contain PASS/SKIP per row
```

**depends-on:** Group 11

---

## Dependencies

```
Wave 1 (parallel foundations)
Group 1 (audit)     ──┐
Group 2 (nats reply) ─┤
Group 3 (pg optional) ┤
                      │
Wave 2 (core refactor, strict order inside)
                      └──→ Group 4 (register SDK in World A)
                                │
                                ├──→ Group 5 (inline capture + audit enum)
                                │          │
                                │          └──→ Group 7 (metadata index + lazy resume)
                                │                     │
                                │                     └──→ Group 6 (refactor bridge, delegates to 7)
                                │
                                └──────────────────────────→ Group 10 (--source filter)
                                                                      │
Wave 3 (CLI + flip switch)                                            │
  Group 8 (GENIE_EXECUTOR) ←── Group 6                                │
  Group 9 (collapse omni CLI) ←── Group 6 + Group 8                   │
                                                                      │
Wave 4 (cleanup + validation)                                         │
  Group 11 (delete World B) ←── Group 6 + Group 9                     │
  Group 12 (close PR #1042 + reconcile) ←── Group 11                  │
  QA matrix ←── Group 11                                              │
  Review ←── all                                                      │
```

---

## QA Criteria

_What must be verified on dev after merge. QA agent tests each criterion._

### Functional
- [ ] `genie omni start` (with default or `GENIE_EXECUTOR=tmux`) works as before
- [ ] `GENIE_EXECUTOR=sdk genie omni start` starts the SDK-backed bridge
- [ ] A WhatsApp message to an SDK-backed agent gets a reply
- [ ] A WhatsApp message to a tmux-backed agent gets a reply
- [ ] Bridge restart mid-conversation: next WhatsApp message resumes the same Claude context (when TTL permits)
- [ ] `genie ls` shows all sessions regardless of source
- [ ] `genie ls --source omni` filters correctly
- [ ] `genie sessions replay <id>` shows content for omni sessions (both tmux and sdk backed)
- [ ] `genie events timeline <executor-id>` shows full audit trail
- [ ] `genie kill <executor-id>` terminates the session and bridge stops delivering to it

### Integration
- [ ] Bridge process is managed by PM2 (unchanged)
- [ ] PG-optional: bridge starts and processes messages with PG offline
- [ ] `omni.reply.<inst>.<chat>` NATS messages are published by the bridge (no subprocess forks)
- [ ] `session-capture.ts` filewatch still works for tmux sessions (unchanged)
- [ ] SDK sessions produce `session_content` rows via the inline capture path
- [ ] `audit_events` contains spawn/deliver/shutdown rows for both tmux and SDK sessions

### Regression
- [ ] `genie spawn`, `genie team create`, `genie send` work as before
- [ ] `genie sessions list/replay/search` existing behavior unchanged
- [ ] `genie events` existing output shape unchanged
- [ ] TUI (if it reads sessions) unchanged or updated to handle the new source filter
- [ ] `bun run check` passes
- [ ] Existing tests all pass, including across-file test runs (not just individually — the bun `mock.module` leak from #1042 must be fixed or avoided)

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| World A `executors` schema doesn't perfectly fit SDK metadata needs | Medium | Use `metadata` JSONB for anything not in the column set. No migration needed. |
| `session-capture.ts` shape is tightly coupled to JSONL structure | Medium | Group 5 produces a minimal subset of that shape that downstream queries need. Verify `genie sessions replay` works against SDK-produced rows before merging Group 5. |
| Claude SDK resume TTL is shorter than operators expect | Low | Document the TTL in FLIP-SWITCH.md. Audit events make fallback visible. Not a correctness issue, just an expectations issue. |
| PR #1042 lands before this wish does | Medium | Group 9 explicitly handles the "if landed" case by deleting the added CLI commands. Group 11 handles the `omni_sessions` table if it was created (add a `DROP TABLE IF EXISTS` migration in a Group 11 sub-step). |
| `executor-registry` queries against `metadata->>'source'` / `metadata->>'chat_id'` hit on every inbound message | Resolved in wish | Group 7 ships migration 027 (`executors_omni_lookup` partial index on `(agent_id, metadata->>'source', metadata->>'chat_id') WHERE ended_at IS NULL`). Validation runs `EXPLAIN` to confirm index use. |
| Refactoring `omni-bridge.ts` introduces subtle concurrency bugs (queue depth, idle timer) | High | Wave 2 + Wave 3 keep existing tests passing. Group 6 explicitly preserves idle timer Map structure. QA matrix test exercises concurrency scenarios. |
| Tmux executor in World B may already be partially in World A | Low | Group 1 audit resolves this. If tmux is already registered via another code path, Group 4 touches only SDK and Group 11 has less to delete. |
| `genie config set executor` may require new config file plumbing | Low | If persistent config doesn't support it yet, just honor env var + flag; skip `genie config set` (acceptance criterion downgraded). |
| Deleting `services/executor.ts` breaks imports we missed | Medium | Group 1 audit catches this. Group 11 runs `bun run check` before merging. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# In automagik-dev/genie (target repo)
src/lib/audit-events.ts                                       (new — Group 5, shared enum)
src/lib/executor-config.ts                                    (new — Group 8)
src/lib/executor-registry.ts                                  (modify — add findLatestByMetadata, Group 7)
src/db/migrations/027_executors_omni_metadata_index.sql       (new — Group 7, JSONB index)
src/services/executors/claude-sdk.ts                          (modify — Groups 2, 4, 5, 7)
src/services/executors/sdk-session-capture.ts                 (new — Group 5)
src/services/executors/__tests__/claude-sdk.test.ts           (modify — Groups 2, 4)
src/services/executors/__tests__/claude-sdk-resume.test.ts    (new — Group 7)
src/services/executors/__tests__/sdk-session-capture.test.ts  (new — Group 5)
src/services/executor.ts                                      (delete or demote — Group 11)
src/services/omni-bridge.ts                                   (modify — Groups 3, 6)
src/services/__tests__/omni-bridge.test.ts                    (modify — Groups 3, 6)
src/term-commands/omni.ts                                     (rewrite — Group 9)
src/term-commands/agent/list.ts                               (modify — Group 10)
src/term-commands/sessions.ts                                 (modify — Group 10)
docs/sdk-executor-guide.md                                    (update — Group 12)
.genie/wishes/genie-omni-marriage/WISH.md                     (append footnote — Group 12)

# In this workspace (planning artifacts)
.genie/wishes/unified-executor-layer/WISH.md                  (this file)
.genie/wishes/unified-executor-layer/AUDIT.md                 (Group 1 output)
.genie/wishes/unified-executor-layer/FLIP-SWITCH.md           (Group 8 docs)
.genie/wishes/unified-executor-layer/QA-MATRIX.md             (QA Group output)

# GitHub actions
Close PR automagik-dev/genie#1042 with closing comment      (Group 12)
```
