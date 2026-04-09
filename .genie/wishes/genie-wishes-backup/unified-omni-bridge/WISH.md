# Wish: Unified Omni Bridge — Genie Side of Turn-Based Execution

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `unified-omni-bridge` |
| **Date** | 2026-04-05 |
| **Priority** | P1 |
| **Repo** | `automagik-dev/genie` |
| **Issues** | #1035, #1036 |
| **depends-on** | `fix-omni-bridge-hardening` (SHIPPED), PR #1062 unified-executor (MERGED), Omni `omni-agentic-cli` Groups 5+7+13 (turn infrastructure + done command + dispatcher) |
| **coordinates-with** | Omni `omni-agentic-cli` wish (READY) — see `INTEGRATION-FROM-OMNI.md` for cross-repo contract |

## Summary

Genie is the first consumer of Omni's turn-based execution mode. Omni owns the turn lifecycle (PG state, `omni done` command, NATS events, user-facing fallbacks, inactivity timing). Genie owns agent execution (spawn with env vars, activity detection, nudge delivery into executor, session cleanup on turn close/timeout, SDK `done` tool). The contract between them: 4 env vars in the NATS payload + 4 NATS event topics for turn signals.

## Ownership Split (agreed with Omni orchestrator)

| Responsibility | Owner | Mechanism |
|---------------|-------|-----------|
| Turn state (durable) | **Omni** | PG `turns` table, opened by dispatcher |
| `omni done` command | **Omni** | CLI → API → PG close → NATS event |
| Inactivity timing (60s/120s/300s/900s) | **Omni** | turn-monitor polls `api_keys.lastUsedAt` |
| Nudge delivery to agent | **Genie** | Bridge receives `omni.turn.nudge` → injects into executor |
| User-facing fallback ("still processing") | **Omni** | turn-monitor sends to chat at 300s |
| Force-close turn | **Omni** | turn-monitor at 900s → PG close → `omni.turn.timeout` |
| Session cleanup on timeout | **Genie** | Bridge receives `omni.turn.timeout` → evicts session |
| Env var injection | **Genie** | Bridge extracts `payload.env` from NATS trigger → passes to executor spawn |
| SDK `done` tool | **Genie** | Tool handler calls `omni done` CLI with agent's env vars |

## NATS Event Contract (canonical, agreed with Omni)

Genie subscribes to these 4 topics (plain NATS, not JetStream):

| Topic | When | Bridge action |
|-------|------|---------------|
| `omni.turn.open.{instanceId}.{chatId}` | Omni dispatcher opens turn | Extract `turnId`, record in local tracker |
| `omni.turn.done.{instanceId}.{chatId}` | Agent calls `omni done` | Close local turn, session goes idle |
| `omni.turn.nudge.{instanceId}.{chatId}` | 60s/120s no API activity | Inject nudge text into executor |
| `omni.turn.timeout.{instanceId}.{chatId}` | 900s force-close | Evict session, shut down executor |

**Canonical payloads:**

```typescript
// turn.open
{ turnId: string, messageId: string, agentId: string, timestamp: string }

// turn.done
{ turnId: string, action: 'message' | 'react' | 'skip', messageId?: string, emoji?: string, reason?: string, duration: number, nudgeCount: number, timestamp: string }

// turn.nudge
{ turnId: string, nudgeCount: number, idleSec: number, message: string }

// turn.timeout
{ turnId: string, duration: number, nudgeCount: number, fallbackSent: boolean }
```

## Env Var Contract

Omni's dispatcher packs these into the NATS trigger payload under `payload.env`:

```typescript
{
  OMNI_API_KEY:   string,  // scoped key, locked to one instance
  OMNI_INSTANCE:  string,  // instance UUID
  OMNI_CHAT:      string,  // chat JID
  OMNI_MESSAGE:   string,  // trigger message ID
  OMNI_TURN_ID:   string,  // turn UUID (for local tracking)
}
```

Bridge extracts and passes to executor spawn. Agent process inherits them — all `omni say/done/send` commands auto-route via these env vars.

## Scope

### IN
- Extract `payload.env` from NATS trigger message, pass to executor spawn
- Subscribe to `omni.turn.{open,done,nudge,timeout}.>` events
- Local TurnTracker (in-memory, fast lookups, synced via NATS events)
- Nudge delivery: on `turn.nudge`, inject nudge text into executor (SDK: system message, tmux: send-keys)
- Session cleanup: on `turn.timeout`, evict session + shut down executor
- `done` tool for SDK executor: calls `omni done` CLI
- Remove `omni-reply.ts` and all `sendViaOmniCli` calls from executors
- Clean shutdown: close all open turns on bridge stop

### OUT
- `omni done` command (Omni `omni-agentic-cli` Group 7)
- Turn state in PG (Omni `turns` table — Omni is source of truth)
- Inactivity timing logic (Omni turn-monitor owns when to nudge/timeout)
- User-facing fallback messages (Omni sends "still processing" at 300s)
- Force-close logic (Omni turn-monitor at 900s)
- Instance→agent mapping (Omni auto-provisions scoped API keys)
- Omni verb commands — say, send, speak, imagine, etc. (separate wish)
- `@omni/sdk` dependency (agents use CLI, bridge uses NATS)
- Bridge startup in `genie serve` (already implemented — lines 515-533 of `serve.ts`)
- Deprecating `genie omni start/stop` (already done in `omni.ts`)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Genie nudges the AGENT, Omni nudges the USER | Genie is closest to the executor — can inject into SDK context or tmux pane. Omni is closest to the channel — handles user-facing messaging. No double-nudge to user. |
| Genie does NOT send user-facing fallbacks | Omni owns the messaging channel. If agent is silent for 300s, Omni's turn-monitor sends "still processing." Genie duplicating this would confuse the user. |
| Extract env from NATS payload, don't look up keys | Omni's dispatcher packs `payload.env` with the scoped API key + routing vars. Bridge just passes through — simpler, no extra API calls, no key knowledge needed. |
| In-memory TurnTracker synced via NATS events | Omni's PG `turns` table is source of truth. Genie's in-memory tracker is an optimization for fast local decisions. NATS events keep them in sync. No PG dependency for turn tracking. |
| `done` tool calls `omni done` via Bash | Universal: same CLI command regardless of executor type. NATS event flows naturally (Omni API → PG close → NATS event → bridge receives). No SDK dependency. |
| Delete `omni-reply.ts`, replace with env-var routing | Current `sendViaOmniCli()` (87 lines) passes instanceId/chatId explicitly. In turn-based mode, agents handle their own messaging via env vars. The bridge doesn't relay — agents send directly. |
| Group 3 (serve integration) removed — already done | `serve.ts` already starts bridge on `GENIE_NATS_URL` (lines 515-533). `omni.ts` already deprecated `start`/`stop`. No work needed. |
| Build on #1062 foundation | Keep executor-registry, safePgCall, audit events, lazy resume. Layer turn protocol on top. |

## Success Criteria

- [ ] Bridge extracts `payload.env` from NATS trigger and passes to executor spawn
- [ ] Agent process has `OMNI_API_KEY`, `OMNI_INSTANCE`, `OMNI_CHAT`, `OMNI_MESSAGE` env vars
- [ ] Agent can run `omni say "text"` during execution — message delivered to user
- [ ] Agent can send multiple intermediate messages before calling `omni done`
- [ ] On `omni.turn.open` event: bridge records turnId in local tracker
- [ ] On `omni.turn.nudge` event: bridge injects nudge text into executor context
- [ ] On `omni.turn.done` event: bridge closes local turn tracker, session goes idle
- [ ] On `omni.turn.timeout` event: bridge evicts session, shuts down executor
- [ ] SDK executor: `done` tool available, calls `omni done` via Bash
- [ ] `omni-reply.ts` deleted — grep confirms zero `sendViaOmniCli` references
- [ ] Genie does NOT send user-facing fallback messages (Omni handles that)
- [ ] Bridge shutdown closes all open turns gracefully
- [ ] Backwards compatible: works if `payload.env` not present (falls back to message fields)
- [ ] `bun run check` passes

## Execution Strategy

### Wave 1 (parallel, no dependencies between groups)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Turn event handling: NATS subscriptions + TurnTracker + nudge injection |
| 2 | engineer | Env var extraction + `done` tool + delete reply workarounds |

### Wave 2
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Full review against criteria |

## Execution Groups

### Group 1: Turn Event Handling + Nudge Delivery

**Goal:** Bridge subscribes to Omni's 4 turn NATS events and acts on them: track turn state locally, deliver nudges into executor, clean up on timeout.

**Deliverables:**

1. **`src/services/omni-turn.ts`** (NEW, ~80 lines) — local turn tracker:
   ```typescript
   interface Turn {
     turnId: string;          // from omni.turn.open payload
     sessionKey: string;
     messageId: string;
     startedAt: number;
     closed: boolean;
     closedAction?: 'message' | 'react' | 'skip' | 'timeout';
   }

   export class TurnTracker {
     private turns = new Map<string, Turn>();  // sessionKey → turn

     open(sessionKey: string, turnId: string, messageId: string): void;
     close(sessionKey: string, action: string): void;
     isOpen(sessionKey: string): boolean;
     getTurnId(sessionKey: string): string | undefined;
     getByTurnId(turnId: string): Turn | undefined;  // reverse lookup for NATS events
   }
   ```
   Lightweight — Omni PG is source of truth. This is for fast local lookups only.

2. **`src/services/omni-bridge.ts`** (MOD) — NATS subscriptions for turn events. Add after existing `omni.message.>` subscription in `start()`:
   ```typescript
   // Turn lifecycle events from Omni
   this.nc.subscribe('omni.turn.open.>');
   this.nc.subscribe('omni.turn.done.>');
   this.nc.subscribe('omni.turn.nudge.>');
   this.nc.subscribe('omni.turn.timeout.>');
   ```
   Route to handlers:
   - `turn.open` → `turnTracker.open(sessionKey, payload.turnId, payload.messageId)` — maps turnId to the active session for this instanceId+chatId
   - `turn.done` → `turnTracker.close(sessionKey, payload.action)` + emit audit event + session goes idle
   - `turn.nudge` → `this.injectNudge(sessionKey, payload.message)` — calls executor's `injectNudge()`
   - `turn.timeout` → evict session: call `executor.shutdown(session)`, delete from executor-registry, log audit

3. **`src/services/executor.ts`** (MOD) — add `injectNudge` to IExecutor interface:
   ```typescript
   interface IExecutor {
     spawn(agentName: string, chatId: string, env: Record<string, string>): Promise<OmniSession>;
     deliver(session: OmniSession, message: OmniMessage): Promise<void>;
     shutdown(session: OmniSession): Promise<void>;
     isAlive(session: OmniSession): Promise<boolean>;
     injectNudge(session: OmniSession, text: string): Promise<void>;  // NEW
   }
   ```

4. **`src/services/executors/claude-sdk.ts`** (MOD) — implement `injectNudge()`:
   - Queue system message for next query: `this.pendingNudge = text`
   - In `_processDelivery()`, prepend nudge as system message if `this.pendingNudge` is set
   - If a query is currently streaming, do NOT interrupt — queue for next delivery

5. **`src/services/executors/claude-code.ts`** (MOD) — implement `injectNudge()`:
   - Inject via `tmux send-keys`: same mechanism as `deliver()` but with nudge text
   - Prefix with `[system]` marker so agent recognizes it as a system nudge

6. **`src/services/__tests__/omni-turn.test.ts`** (NEW) — unit tests:
   - open → isOpen returns true
   - close → isOpen returns false
   - close is idempotent (double-close doesn't error)
   - getByTurnId reverse lookup works
   - open overwrites stale turn on same sessionKey

**Acceptance Criteria:**
- [ ] Bridge subscribes to `omni.turn.{open,done,nudge,timeout}.>` events
- [ ] `turn.open` event records turnId in local tracker
- [ ] `turn.done` event closes local turn, session goes idle
- [ ] `turn.nudge` event injects nudge text into executor
- [ ] `turn.timeout` event evicts session + shuts down executor
- [ ] `IExecutor.injectNudge()` implemented in both executors
- [ ] TurnTracker unit tests pass
- [ ] `bun run typecheck` clean

**Validation:**
```bash
bun test --filter "omni-turn" && bun run typecheck
```

**depends-on:** none (NATS events are just messages — can build and test with mocks before Omni ships)

---

### Group 2: Env Var Extraction + `done` Tool + Remove Reply Workarounds

**Goal:** Bridge extracts env vars from NATS payload. SDK executor gets `done` tool. All legacy reply routing removed.

**Deliverables:**

1. **`src/services/omni-bridge.ts`** (MOD) — extract env from NATS trigger payload:
   ```typescript
   // In message handler, after parsing the NATS message:
   const env = payload.env ?? {};
   // Pass to executor spawn with fallbacks for backwards compat:
   const spawnEnv = {
     OMNI_API_KEY: env.OMNI_API_KEY ?? process.env.OMNI_API_KEY ?? '',
     OMNI_INSTANCE: env.OMNI_INSTANCE ?? message.instanceId,
     OMNI_CHAT: env.OMNI_CHAT ?? message.chatId,
     OMNI_MESSAGE: env.OMNI_MESSAGE ?? message.messageId ?? '',
     OMNI_TURN_ID: env.OMNI_TURN_ID ?? '',
   };
   const session = await this.executor.spawn(agentName, chatId, spawnEnv);
   ```
   Backwards compatible: works if `payload.env` is not present (pre-turn-based dispatcher).

2. **`src/services/omni-bridge.ts`** (MOD) — remove legacy reply wiring:
   - Delete `import { sendViaOmniCli, checkOmniAvailable } from './omni-reply.js'`
   - Delete any `checkOmniAvailable()` calls
   - Delete any `sendViaOmniCli()` calls from message processing

3. **`src/services/executors/claude-sdk.ts`** (MOD) — add `done` tool + remove reply routing:
   - Delete `import { sendViaOmniCli } from '../omni-reply.js'`
   - Delete `sendViaOmniCli()` call in `_processDelivery()` (~line 202)
   - Add `done` tool to query options:
     ```typescript
     {
       name: 'done',
       description: 'Close this turn. REQUIRED after processing the user message. ' +
         'Sends a final response, reacts, or skips. Call exactly once per turn.',
       input_schema: {
         type: 'object',
         properties: {
           text: { type: 'string', description: 'Final message to the user' },
           media: { type: 'string', description: 'File path for media (image/doc/audio)' },
           caption: { type: 'string', description: 'Caption for media attachment' },
           react: { type: 'string', description: 'Emoji reaction (instead of text)' },
           skip: { type: 'boolean', description: 'Close turn without sending anything' },
           reason: { type: 'string', description: 'Internal reason for skipping' },
         },
       },
     }
     ```
   - Tool handler builds CLI args and executes:
     ```typescript
     async function handleDoneTool(params: DoneParams, env: Record<string, string>) {
       const args = ['done'];
       if (params.skip) {
         args.push('--skip');
         if (params.reason) args.push('--reason', params.reason);
       } else if (params.react) {
         args.push('--react', params.react);
       } else if (params.media) {
         args.push('--media', params.media);
         if (params.caption) args.push('--caption', params.caption);
       } else if (params.text) {
         args.push(params.text);
       }
       await execFile('omni', args, { env: { ...process.env, ...env } });
     }
     ```
   - `deliver()` stays void — agent communicates via tools + CLI

4. **`src/services/executors/claude-code.ts`** (MOD) — verify env vars pass through:
   - Ensure `spawn()` passes all `env` params to `tmux new-session` environment
   - Agent calls `omni say/done` directly via Bash — turn close detected via NATS event

5. **Delete `src/services/omni-reply.ts`** (87 lines) — fully replaced by env-var-based routing

6. **Update `src/services/executors/__tests__/claude-sdk.test.ts`**:
   - Remove `sendViaOmniCli` mock
   - Add `done` tool mock + assertions
   - Verify env vars passed through to tool handler

**Acceptance Criteria:**
- [ ] Bridge extracts `payload.env` from NATS message and passes to executor spawn
- [ ] Agent process has `OMNI_INSTANCE`, `OMNI_CHAT`, `OMNI_MESSAGE`, `OMNI_API_KEY` env vars
- [ ] SDK executor: `done` tool available in query, calling it runs `omni done` CLI
- [ ] SDK executor: zero `sendViaOmniCli` references — `grep -r sendViaOmniCli src/` returns nothing
- [ ] Tmux executor: env vars available in pane
- [ ] `src/services/omni-reply.ts` deleted
- [ ] `deliver()` is void — no reply routing in executors
- [ ] Backwards compatible: works if `payload.env` not present (falls back to message fields)
- [ ] `bun run check` passes

**Validation:**
```bash
grep -r "sendViaOmniCli\|omni-reply" src/ && echo "FAIL: stale references" || echo "PASS: clean"
bun run check
```

**depends-on:** none (can build before Omni ships `omni done` — tool call will fail gracefully, turn times out via Omni's fallback at 900s)

---

## QA Criteria

_End-to-end verification on dev after BOTH repos merge (requires Omni `omni-agentic-cli` Groups 5+7+13)._

- [ ] Omni dispatcher opens turn → NATS trigger includes `payload.env` → Genie bridge extracts → executor has env vars
- [ ] Agent runs `omni say "working..."` → intermediate message delivered to WhatsApp
- [ ] Agent runs `omni done "here's my answer"` → final message delivered → `turn.done` event → bridge closes turn
- [ ] Agent runs `omni done --react ✅` → reaction on trigger message → turn closed
- [ ] Agent runs `omni done --skip` → no outbound → turn closed silently
- [ ] Agent forgets `omni done` → Omni nudges at 60s → bridge injects nudge into executor → agent calls `omni done`
- [ ] Agent fully idle → Omni fallback to user at 300s → force-close at 900s → bridge evicts session
- [ ] Two users on same instance → two separate turns, no interference
- [ ] Bridge restart → sessions resume from PG (#1062 executor-registry)
- [ ] Genie sends ZERO user-facing messages (Omni handles all outbound)
- [ ] Multi-message turn: agent sends text + image + voice via `omni say/send/speak`, then `omni done "summary"` → all delivered in order

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Omni `omni done` not shipped before Genie side | Medium | Genie Groups 1-2 can build and test with mocks. SDK `done` tool calls `omni done` CLI — if not installed, call fails gracefully, turn times out at 900s via Omni's fallback. No data loss. |
| NATS event delivery is at-most-once | Low | If `turn.done` event is lost, Omni's turn-monitor force-closes at 900s and emits `turn.timeout`. Bridge handles both events identically. |
| `payload.env` not yet present in NATS messages | Low | Bridge falls back to message fields. Works with current and future Omni dispatchers. |
| SDK executor custom tool injection | Medium | Claude Agent SDK docs confirm tools can be added to queries. If API changes, fall back to system prompt instruction + bridge calls `omni done --skip` on session idle. |
| `injectNudge` for SDK may interrupt streaming query | Medium | Queue nudge for next query if in-flight. Don't interrupt active generation — agent is working, not idle. |
| `omni.turn.open` may arrive after trigger message | Low | Bridge creates local turn on trigger receipt (from `payload.env.OMNI_TURN_ID`). `turn.open` event confirms it. If open arrives first, bridge has turnId ready. Either order works. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files

```
# New
src/services/omni-turn.ts                  (TurnTracker — local state, synced via NATS)
src/services/__tests__/omni-turn.test.ts   (unit tests)

# Modify
src/services/omni-bridge.ts               (NATS turn subs, env extraction, nudge routing, remove sendViaOmniCli)
src/services/executor.ts                   (add injectNudge to IExecutor interface)
src/services/executors/claude-sdk.ts       (done tool, remove sendViaOmniCli, injectNudge)
src/services/executors/claude-code.ts      (env var pass-through, injectNudge via send-keys)
src/services/executors/__tests__/claude-sdk.test.ts  (update mocks)

# Delete
src/services/omni-reply.ts                (replaced by env var routing + omni done)
```

---

## Integration Checklist (from INTEGRATION-FROM-OMNI.md)

- [x] ~~Old Group 1 (omni done)~~ → removed, depends on Omni `omni-agentic-cli` Group 7
- [x] NATS payload aligned — canonical schema with turnId, duration, nudgeCount, timestamp
- [x] Nudge ownership split — Genie nudges agent (inject), Omni nudges user (fallback at 300s)
- [x] Env vars from `payload.env` — bridge extracts and passes through with fallbacks
- [x] Subscribe to all 4 turn events — open, done, nudge, timeout
- [x] Genie does NOT send user-facing fallbacks — Omni turn-monitor handles it
- [x] `sendViaOmniCli` / `omni-reply.ts` → deleted, replaced by env-var-based agent routing
- [x] Bridge-in-serve already done — no Group 3 needed (verified: `serve.ts` lines 515-533)
- [x] `OMNI_TURN_ID` added to env var contract for local tracker seeding

## Cross-Repo Dependency Map

```
Omni omni-agentic-cli                    Genie unified-omni-bridge
─────────────────────                    ─────────────────────────
Group 5: turns table + service           
Group 7: omni done + POST /turns/close ──→ Group 2: done tool calls omni done CLI
Group 13: dispatcher env vars in NATS  ──→ Group 2: bridge extracts payload.env
Group 5: turn-monitor nudge events     ──→ Group 1: bridge injects nudge into executor
Group 5: turn-monitor timeout events   ──→ Group 1: bridge evicts session
                                         
Both: NATS event contract (4 topics, canonical payloads)
Both: Env var contract (5 vars: API_KEY, INSTANCE, CHAT, MESSAGE, TURN_ID)
```
