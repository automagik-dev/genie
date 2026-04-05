# Cross-Repo Integration Context: Turn-Based Execution Mode

## From: Omni orchestrator (omni-agentic-cli wish)
## To: Genie engineer working on unified-omni-bridge
## Date: 2026-04-05

---

## TL;DR

Omni's `omni-agentic-cli` wish (READY, reviewed) defines turn-based as a THIRD provider mode on Omni's IAgentProvider — not a Genie-specific bridge hack. Omni owns the turn lifecycle in PG (durable state), NATS events (real-time signals), and the `omni done` command. Genie owns executor-level activity detection, nudge injection into agents, and env var propagation from NATS payload to process.

Your wish (unified-omni-bridge) and our wish overlap on several points. This document flags what's aligned, what conflicts, and what needs resolution so both repos ship a clean integration.

---

## 1. NATS EVENT CONTRACT — NEEDS ALIGNMENT

### Omni will emit these 4 events (plain NATS, not JetStream):

| Event | Topic | Payload |
|-------|-------|---------|
| Turn opened | `omni.turn.open.{instanceId}.{chatId}` | `{ turnId, messageId, agentId, timestamp }` |
| Turn done | `omni.turn.done.{instanceId}.{chatId}` | `{ turnId, action, messageId?, emoji?, reason?, duration, nudgeCount }` |
| Turn nudge | `omni.turn.nudge.{instanceId}.{chatId}` | `{ turnId, nudgeCount, idleSec, message }` |
| Turn timeout | `omni.turn.timeout.{instanceId}.{chatId}` | `{ turnId, duration, nudgeCount, fallbackSent }` |

### Your wish expects:
- Subscribe to `omni.turn.done.>` with payload `{ action, messageId?, emoji?, reason?, timestamp }`

### Mismatch:
- Omni includes `turnId`, `duration`, `nudgeCount` in turn.done. Your wish expects `timestamp` but not `turnId`.
- **Resolution:** Omni will include ALL fields including `timestamp`. Genie can ignore fields it doesn't need. But we should agree on the canonical schema now.

### Proposed canonical turn.done payload:
```json
{
  "turnId": "uuid",
  "action": "message" | "react" | "skip" | "timeout",
  "messageId": "string?",
  "emoji": "string?",
  "reason": "string?",
  "duration": 12345,
  "nudgeCount": 0,
  "timestamp": "2026-04-05T12:00:00Z"
}
```

---

## 2. DUAL NUDGE/TIMEOUT — WHO OWNS WHAT

### The problem:
Both wishes implement nudging and timeout independently:

| Mechanism | Omni (turn-monitor) | Genie (bridge) |
|-----------|-------------------|----------------|
| Activity signal | API calls from scoped key (`lastUsedAt`) | Executor activity (SDK tool calls, tmux pane output) |
| Nudge at 60s | Emits `omni.turn.nudge` NATS event | Injects text into executor directly |
| Fallback at 300s | Sends fallback message to user | Sends fallback message to user |
| Force-close at 900s | Closes turn in PG, emits `turn.timeout` | Closes turn in-memory, sends fallback |

### Why both exist (and it's correct):
- **Genie's nudge is PRIMARY** — it's closest to the agent. It can inject text into the executor context (SDK system message or tmux send-keys). The agent actually sees this.
- **Omni's turn-monitor is the SAFETY NET** — it catches the case where Genie's bridge itself crashes, disconnects, or has a bug. If no one closes the turn and no API calls come in, Omni's monitor ensures the turn doesn't hang forever and the user gets a fallback.

### Proposed ownership split:
| Responsibility | Owner | Mechanism |
|---------------|-------|-----------|
| Agent nudging (inject into context) | **Genie** | Bridge's inactivity monitor → inject into executor |
| API inactivity detection | **Omni** | auth middleware `lastUsedAt` + turn-monitor |
| Fallback message to user | **Omni** | turn-monitor at 300s (Genie should NOT send its own — let Omni handle user-facing comms) |
| Force-close turn | **Omni** | turn-monitor at 900s closes in PG + emits turn.timeout |
| Detect turn.timeout + clean up | **Genie** | Subscribe to `omni.turn.timeout.>`, clean up session |

### Key change for your wish:
- Genie should NOT send its own fallback message to the user. Omni owns user-facing messaging.
- Genie SHOULD subscribe to `omni.turn.nudge.>` and use those events as triggers to inject nudge text into the executor. This way Omni's turn-monitor drives the timing, Genie handles the delivery to the agent.
- Alternatively, Genie does its own 60s detection (it's faster since it's in-process) and Omni's nudge is the backup. Both work. But we should pick one to avoid double-nudging.

---

## 3. GROUP 1 OVERLAP — OMNI DONE IS OURS

Your wish Group 1 says "Omni repo: create `omni done` command + NATS event."

Our wish Group 7 does exactly this, but MORE:
- `omni done` hits `POST /v2/turns/close` API endpoint
- That endpoint closes the turn in PG `turns` table
- Then emits NATS `omni.turn.done` event
- Supports: `done "text"`, `done --media`, `done --react`, `done --skip`

**Resolution:** Your wish Group 1 should be marked as "handled by Omni's omni-agentic-cli wish Group 7" and removed from your execution plan. You depend on it, not implement it.

Update your wish:
```
depends-on: omni/omni-agentic-cli Group 7 (done command)
```

---

## 4. TURN STATE — DUAL TRACKING IS CORRECT

- **Omni:** `turns` table in PG (durable, survives restarts, auditable)
- **Genie:** `TurnTracker` in-memory Map (fast, per-session, ephemeral)

This is fine. Omni is source of truth for turn state. Genie's in-memory tracker is an optimization for fast local decisions. Genie's tracker syncs via NATS events:
- `turn.done` → close in-memory tracker
- `turn.timeout` → clean up session

---

## 5. ENV VARS — ALIGNED

Both wish agree on the contract:

```
OMNI_API_KEY    = scoped API key (locked to one instance)
OMNI_INSTANCE   = instance UUID that received the message
OMNI_CHAT       = chat JID the human wrote in
OMNI_MESSAGE    = trigger message ID (for --reply/react)
```

### Flow:
1. Omni dispatcher opens turn → packs env vars into NATS payload
2. Genie bridge receives NATS message → extracts env vars → sets on executor spawn
3. Agent process has env vars → `omni say/done/etc` use them for routing

### Important Omni-side detail your wish may not know:
Omni's dispatcher (Group 13) will include these env vars in the NATS trigger message:
```typescript
// In NatsGenieProvider.trigger() for turn-based mode:
const payload = {
  ...existingPayload,
  env: {
    OMNI_API_KEY: scopedKey.key,
    OMNI_INSTANCE: context.instanceId,
    OMNI_CHAT: context.chatId,
    OMNI_MESSAGE: context.messageId,
  }
};
nats.publish(`omni.message.${instanceId}.${chatId}`, payload);
```

Your bridge should extract `payload.env` and pass to executor. This is cleaner than the bridge having to look up the API key itself.

---

## 6. `done` TOOL (SDK) — IMPLEMENTATION DETAIL

Your wish Group 3 adds a `done` tool to SDK executor. The tool handler should call `omni done` via Bash (CLI). This means:

```
SDK executor → done tool called → Bash: omni done "text" → Omni API → PG turn close → NATS turn.done event → Bridge receives → in-memory tracker close
```

This is clean. The NATS event is the universal signal regardless of executor type (SDK calls tool → CLI, tmux agent calls CLI directly).

---

## 7. WHAT OMNI NEEDS FROM GENIE

For the integration to work, we need these from the bridge:

1. **Extract `payload.env` from NATS message** and pass to executor spawn
2. **Subscribe to `omni.turn.done.>` and `omni.turn.timeout.>`** for turn lifecycle
3. **Open turn on Omni side** — when bridge receives a message and opens a turn locally, it should also call `POST /v2/turns/open` (or Omni's dispatcher does this before publishing to NATS — TBD)
4. **Don't send fallback messages directly** — let Omni's turn-monitor handle user-facing fallbacks

---

## 8. EXECUTION ORDER

Recommended:
1. **Omni ships first:** Groups 1-5 (Wave 1 foundation), then Group 7 (done command)
2. **Genie ships Group 2** (turn tracker) in parallel with Omni Wave 1
3. **Genie ships Group 3** (wire executors) after Omni Group 7 lands
4. **Integration test** with both sides on dev

The `omni done` command + NATS events must exist before Genie can wire executors. But Genie's turn tracker (Group 2) has zero Omni dependencies — it's pure logic.

---

## 9. FILES TOUCHED (Omni side, for your reference)

```
# Turn infrastructure (Group 5)
packages/db/src/schema.ts                    # turns table
packages/api/src/services/turns.ts           # turn service
packages/api/src/services/turn-monitor.ts    # stale turn poller
packages/api/src/routes/v2/turns.ts          # POST /v2/turns/close
packages/api/src/middleware/auth.ts           # activity tracking

# Done command (Group 7)
packages/cli/src/commands/done.ts            # omni done CLI

# Dispatcher integration (Group 13)
packages/core/src/providers/types.ts         # mode: 'turn-based'
packages/core/src/providers/nats-genie-provider.ts  # env vars in payload
packages/api/src/plugins/agent-dispatcher.ts # turn open on trigger
```

---

## ACTION ITEMS FOR YOUR WISH

1. **Remove Group 1** (omni done) — Omni handles this in Group 7 of omni-agentic-cli
2. **Align NATS event payload** — use the canonical schema above (superset of both)
3. **Clarify nudge ownership** — recommend: Genie nudges agent (primary), Omni nudges via NATS event as backup, Omni sends user-facing fallback
4. **Extract env from NATS payload** — `payload.env.OMNI_*` will be there
5. **Subscribe to `omni.turn.timeout.>`** — clean up sessions on Omni-forced timeout
6. **Don't send user fallback** — Omni's turn-monitor handles user-facing "still processing"
