# Wish: pg-state-migration

> Migrate agent registry, team configs, and mailbox from crash-unsafe JSON files to PostgreSQL. Scale target: thousands of agents.

**GitHub Issue:** #775
**Related:** #774 (P0: resume fails after crash)
**Priority:** P0

## Scope

Move the three remaining critical filesystem state stores to PostgreSQL:

1. **Agent Registry** (`workers.json` → `agents` + `agent_templates` tables)
2. **Team Configs** (`teams/*.json` → `teams` table)
3. **Mailbox** (`mailbox/*.json` → `mailbox` table)

Also: delete legacy state files already superseded by PG.

## Non-Goals

- Config migration (`config.json`) — Tier 2, separate wish
- Auto-approve migration (YAML files) — Tier 2, separate wish
- QA results cache — optional, not critical
- Claude Code session storage (upstream CC concern)

## Acceptance Criteria

1. Migration `005_pg_state.sql` creates all 4 tables with indexes and LISTEN/NOTIFY
2. `agent-registry.ts` uses PG for all reads/writes (no `workers.json`)
3. `team-manager.ts` uses PG for all reads/writes (no `teams/*.json`)
4. `mailbox.ts` uses PG for all reads/writes (no per-worker JSON)
5. `genie resume --all` recovers agents after kill -9 of agent processes (crash simulation)
6. `genie ls`, `genie spawn`, `genie status` work against PG backend
7. All existing tests pass
8. Performance: registry operations <10ms at 1000 agents
9. Legacy files cleaned up: `state/*.json`, `tasks.json`, `state.json`
10. Existing data migrated: JSON files → PG on first run (one-time seed)

## Constraints

- **PG is a hard dependency.** No filesystem fallback. If PG is down, genie doesn't work — that's the deal.
- **Public API signatures must not change.** All exported functions in the 3 modules are already async. Callers (25 for registry, 6 for team-manager, 8 for mailbox) should require zero changes.
- **PostgreSQL is the source of truth.** PG is already running via pgserve with WAL-based crash recovery. This is an extension of the existing pattern, not a new dependency.

## Execution Groups

### Group 1: Schema + Migration + Data Seed (no dependencies)

**Tasks:**
- Create `src/db/migrations/005_pg_state.sql` with:
  - `agents` table (mirrors `Agent` interface from `agent-registry.ts`)
  - `agent_templates` table (mirrors `WorkerTemplate`)
  - `teams` table (mirrors team config shape from `team-manager.ts`)
  - `mailbox` table (from/to/body/read/delivered)
  - Indexes on hot-path columns (state, team, to_worker+is_read)
  - LISTEN/NOTIFY triggers for agent state changes + mailbox delivery
- Add one-time data seed: on first PG-backed startup, if tables are empty AND JSON files exist, import `workers.json` → `agents`/`agent_templates`, `teams/*.json` → `teams`, `mailbox/*.json` → `mailbox`
- Verify migration runs clean on fresh DB and existing DB

**Validation:** `bun run build && psql -p 19642 -d genie -c '\dt' | grep -E 'agents|teams|mailbox'`

### Group 2: Agent Registry Migration (depends on Group 1)

**Tasks:**
- Refactor `src/lib/agent-registry.ts` (402 lines, 16 exported functions):
  - Replace internal file read/write + `acquireLock()` with PG queries via `getConnection()`
  - `register()` → INSERT with ON CONFLICT
  - `update()` → UPDATE with RETURNING
  - `unregister()` → DELETE
  - `list()` → SELECT with optional filters
  - `get()` → SELECT by id
  - `listTemplates()` → SELECT from `agent_templates`
  - `registerTemplate()` → UPSERT into `agent_templates`
  - Remove `acquireLock()` import and file-lock dependency
- Public API unchanged — 25 importers should need zero changes
- Update `src/__tests__/resume.test.ts` and `src/lib/agent-registry.test.ts` to mock PG instead of filesystem

**Validation:** `bun test src/lib/agent-registry.test.ts && bun test src/__tests__/resume.test.ts`

### Group 3: Team Manager Migration (depends on Group 1)

**Tasks:**
- Refactor `src/lib/team-manager.ts` (486 lines, 12 exported functions):
  - Replace file reads/writes with PG queries via `getConnection()`
  - `createTeam()` → INSERT
  - `hireAgent()` / `fireAgent()` → UPDATE members array
  - `disbandTeam()` → DELETE or status update
  - `listTeams()` → SELECT
  - `getTeam()` → SELECT by name
  - Remove file-system team config logic
- Public API unchanged — 6 importers should need zero changes

**Validation:** `bun test src/lib/team-manager.test.ts`

### Group 4: Mailbox Migration (depends on Group 1)

**Tasks:**
- Refactor `src/lib/mailbox.ts` (204 lines, 6 exported functions):
  - `send()` → INSERT into mailbox
  - `inbox()` → SELECT WHERE to_worker = ? AND is_read = false
  - `markRead()` → UPDATE is_read = true
  - `markDelivered()` → UPDATE delivered_at = now()
  - Add LISTEN/NOTIFY for real-time delivery (subscribe to `genie_mailbox` channel)
  - Remove file-based locking and JSON read/write
- Public API unchanged — 8 importers should need zero changes
- Update protocol router if internal mailbox types change

**Validation:** `bun test src/lib/__tests__/mailbox.test.ts`

### Group 5: Cleanup + Validation (depends on Groups 2-4)

**Tasks:**
- Delete legacy state file code:
  - Remove `wish-state.json` file writes (already using PG)
  - Remove `tasks.json` legacy support
  - Remove `state.json` counter
- Add crash recovery test: spawn agents → kill -9 agent processes → restart → verify PG state intact and `genie resume --all` recovers them
- Update `recoverOnStartup()` in `scheduler-daemon.ts` to scan all non-`done` agents (fix from #774)
- Run full test suite

**Validation:** `bun test && genie ls` (all tests pass, ls reads from PG)

## Auto-Approve

```yaml
defaults:
  allow: [Read, Write, Edit, Glob, Grep, Bash]
  bash_allow_patterns:
    - "^bun test"
    - "^bun run"
    - "^git "
    - "^psql"
    - "^genie "
```
