# Wish: Omni Session Control

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `omni-session-control` |
| **Date** | 2026-04-04 |
| **Design** | [DESIGN.md](../../brainstorms/omni-session-control/DESIGN.md) |

## Summary

Add persistent session management to the genie omni bridge. Sessions survive bridge restarts via PG, are resumed lazily on next message, and are fully manageable via `genie omni` CLI. PG is mandatory — no fallback to memory.

## Scope

### IN
- `omni_sessions` PG table with migration
- Bridge persists `claudeSessionId` per chat in PG after each deliver
- Bridge reads session from PG on-demand (lazy resume) when message arrives
- Bridge refuses to start if PG is unreachable
- `genie omni sessions` — list active sessions from PG
- `genie omni sessions kill <chatId>` — kill session (PG + in-memory)
- `genie omni sessions reset <agentName>` — kill all sessions for agent
- `genie omni status` — expanded with PG sessions
- `genie omni logs` — PM2 bridge logs
- `genie omni config` — show bridge config

### OUT
- `genie omni instances` (instance management stays in omni CLI)
- Warm start / proactive session restore on boot
- PG fallback to memory
- Session history / message replay
- Cost tracking per session (future: metadata JSONB field is there for it)

## Decisions

| Decision | Rationale |
|----------|-----------|
| PG mandatory, no fallback | Sessions must survive restarts. Memory-only is the bug we're fixing. |
| Lazy resume, no warm start | On-demand is simpler, avoids spawning idle sessions on boot |
| Session key = `agentName:chatId` | Matches current in-memory Map key |
| CLI reads from PG directly | Works even when bridge is stopped |
| `sessions kill` = PG delete + in-memory abort | No orphan rows or queries |

## Success Criteria

- [ ] `genie omni sessions` lists sessions from PG with chatId, agentName, instanceId, idle time, sessionId
- [ ] `genie omni sessions kill <chatId>` removes from PG and aborts in-memory query
- [ ] `genie omni sessions reset <agentName>` kills all sessions for that agent
- [ ] Bridge persists `claudeSessionId` in PG after each deliver
- [ ] Bridge reads session from PG on-demand when message arrives (lazy resume)
- [ ] Bridge refuses to start if PG is not reachable
- [ ] `genie omni status` shows sessions from PG
- [ ] `genie omni logs` shows PM2 bridge logs
- [ ] `genie omni config` shows current bridge config
- [ ] Migration creates `omni_sessions` table with indexes

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | PG migration + session CRUD module |
| 2 | engineer | CLI commands (sessions, logs, config) |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Bridge integration (persist + lazy resume + PG gate) |

### Wave 3 (after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Tests |
| review | reviewer | Review all groups |

## Execution Groups

### Group 1: PG Migration + Session CRUD

**Goal:** Create the `omni_sessions` table and a module for CRUD operations.

**Deliverables:**
1. Migration `NNN_omni_sessions.sql` creating the table with indexes
2. `src/services/omni-sessions.ts` — upsertSession, getSession, listSessions, deleteSession, deleteByAgent, touchSession

**Acceptance Criteria:**
- [ ] Migration creates table `omni_sessions` with columns: id, agent_name, chat_id, instance_id, claude_session_id, created_at, last_activity_at, metadata
- [ ] Indexes on agent_name and instance_id
- [ ] CRUD functions work against PG

**Validation:**
```bash
bun run typecheck
```

**depends-on:** none

---

### Group 2: CLI Commands

**Goal:** Add `sessions`, `logs`, `config` subcommands to `genie omni`.

**Deliverables:**
1. `genie omni sessions` — queries PG, prints table with agent, chatId, instanceId, idle time, sessionId
2. `genie omni sessions kill <chatId>` — deletes from PG, signals bridge to abort if running
3. `genie omni sessions reset <agentName>` — deletes all sessions for agent from PG
4. `genie omni logs` — runs `pm2 logs genie-omni-bridge`
5. `genie omni config` — prints current bridge config from env/defaults

**Acceptance Criteria:**
- [ ] `sessions` lists from PG even when bridge is stopped
- [ ] `sessions kill` deletes row
- [ ] `sessions reset` deletes all rows for agent
- [ ] `logs` shows PM2 output
- [ ] `config` shows executor type, nats url, idle timeout, max concurrent

**Validation:**
```bash
bun run typecheck
```

**depends-on:** Group 1

---

### Group 3: Bridge Integration

**Goal:** Wire session persistence into the SDK executor and bridge startup.

**Deliverables:**
1. Bridge `start()` connects to PG and fails hard if unreachable
2. `ClaudeSdkOmniExecutor.spawn()` checks PG for existing session — if found, stores `claudeSessionId` for resume
3. `ClaudeSdkOmniExecutor._processDelivery()` writes `claudeSessionId` to PG after each query completes
4. Idle timeout deletes session from PG
5. `sessions kill` from CLI triggers abort of in-memory query via IPC or PG polling

**Acceptance Criteria:**
- [ ] Bridge refuses to start without PG
- [ ] Session created in PG on first message for a chat
- [ ] `claudeSessionId` updated in PG after deliver
- [ ] Next message after bridge restart resumes session from PG
- [ ] Idle timeout removes PG row
- [ ] `sessions kill` removes PG row and aborts in-memory query

**Validation:**
```bash
bun run typecheck
```

**depends-on:** Group 1

---

### Group 4: Tests

**Goal:** Unit + integration tests for session CRUD, CLI commands, and bridge persistence.

**Deliverables:**
1. `src/services/__tests__/omni-sessions.test.ts` — CRUD operations
2. `src/term-commands/__tests__/omni-sessions-cli.test.ts` — CLI output parsing
3. `src/services/executors/__tests__/claude-sdk-sessions.test.ts` — persist + lazy resume flow

**Acceptance Criteria:**
- [ ] Session CRUD: create, read, update, delete, deleteByAgent
- [ ] CLI: sessions list, kill, reset produce correct output
- [ ] Bridge: session persisted after deliver, resumed on next message

**Validation:**
```bash
bun test && bun run typecheck && bun run lint
```

**depends-on:** Group 1, Group 2, Group 3

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Claude Code session expires on disk | Low | Create new session on resume failure, log warning |
| PG down at runtime after boot | Medium | Catch write errors, continue serving, retry on next deliver |
| Multiple bridges writing same table | Low | Single-instance assumption; document |

---

## Files to Create/Modify

```
CREATE  src/db/migrations/NNN_omni_sessions.sql
CREATE  src/services/omni-sessions.ts
CREATE  src/services/__tests__/omni-sessions.test.ts
CREATE  src/term-commands/__tests__/omni-sessions-cli.test.ts
CREATE  src/services/executors/__tests__/claude-sdk-sessions.test.ts
MODIFY  src/term-commands/omni.ts                    — add sessions/logs/config commands
MODIFY  src/services/executors/claude-sdk.ts          — persist + lazy resume from PG
MODIFY  src/services/omni-bridge.ts                   — PG gate on start
```
