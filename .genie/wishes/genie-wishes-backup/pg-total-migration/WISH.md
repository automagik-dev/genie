# Wish: Total PG Migration — Zero Leftover JSON State

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `pg-total-migration` |
| **Date** | 2026-03-25 |
| **Design** | [DESIGN.md](../../brainstorms/pg-total-migration/DESIGN.md) |

## Summary

Move all Genie-owned hot-path mutable state from crash-unsafe JSON files to PostgreSQL (via embedded pgserve). After this migration, the only filesystem files are cold bootstrap (`config.json`, `pgserve.port`, `pgserve.migrated`) and Claude Code protocol files (`~/.claude/`). All agent registry, team config, mailbox, team chat, pane colors, and agent directory operations go through PG.

## Scope

### IN
- Schema: `005_pg_state.sql` with `agents`, `agent_templates`, `teams`, `mailbox`, `team_chat` tables + indexes + LISTEN/NOTIFY
- Migrate `agent-registry.ts` internals from `workers.json` to PG (26 importing files, ~78 call sites)
- Migrate `team-manager.ts` internals from `teams/*.json` to PG (7 importing files, ~32 call sites)
- Migrate `mailbox.ts` internals from `mailbox/*.json` to PG (9 importing files, ~21 call sites)
- Migrate `team-chat.ts` internals from `chat/*.jsonl` to PG (5 importing files, ~8 call sites)
- Migrate pane-colors from `pane-colors.json` to `pane_color` column on `agents` table (1 file: `tmux.ts`)
- Migrate `agent-directory.ts` from `agent-directory.json` to derive from `agents` table (8 importing files)
- Idempotent one-time data seed: JSON → PG via `INSERT ... ON CONFLICT DO NOTHING`
- Remove `acquireLock()` calls from migrated modules (PG handles concurrency)
- Delete legacy dead files: `state.json`, `tasks.json`, `state/`
- Consolidate duplicate `004_*` migration files into single `004_clean_test_artifacts.sql`
- Add `paneColor` field to `Agent` TypeScript interface

### OUT
- Claude Code owned files (`~/.claude/projects/`, `~/.claude/teams/`, `~/.claude/settings.json`)
- Git-tracked artifacts (`AGENTS.md`, `SOUL.md`, `HEARTBEAT.md`, `.genie/wishes/`, `.genie/brainstorms/`)
- Cold bootstrap files (`config.json`, `pgserve.port`, `pgserve.migrated`)
- Changes to pgserve itself (upstream repo: `namastexlabs/pgserve`)
- Schema changes to existing PG tables (tasks, schedules, agent_checkpoints, etc.)
- Session UUID extraction from CC JSONL (separate wish: `fix-session-uuid-resume`)
- NATS/external message bus integration
- Multi-machine / distributed PG topology

## Decisions

| Decision | Rationale |
|----------|-----------|
| PG is hard dependency — no filesystem fallback | pgserve auto-starts. If PG is down, genie can't work. Dual-write adds complexity for zero benefit. |
| Public API signatures unchanged | All I/O exports already async. Pure sync helpers (e.g., `toNativeInboxMessage()`) stay sync — they do no I/O. Callers need zero changes. |
| Add `paneColor` to `Agent` interface | TS type currently lacks it. Add during Group 2 so the `agents` table column has a corresponding field. |
| Consolidate duplicate 004_* migrations | Merge `004_clean_test_artifacts.sql` and `004_cleanup_test_data.sql` into single `004_clean_test_artifacts.sql`. |
| `agent_directory` derived from `agents` table, no separate table | Just a filtered view: `SELECT DISTINCT role, team FROM agents`. Eliminates a whole JSON file. |
| `pane_color` as column on `agents`, not separate table | One color per agent. No join needed. |
| Mailbox + team_chat scoped by `repo_path` column | Current JSON is per-repo. PG table adds `repo_path TEXT NOT NULL` for same scoping. |
| Idempotent seed via UPSERT | `INSERT ... ON CONFLICT DO NOTHING`. Rename `.json` → `.json.migrated` only after full success. Safe to re-run after crash. |
| Seed trigger: source file existence | Seed runs if source `.json` exists AND corresponding `.json.migrated` does NOT. After all UPSERTs succeed, rename `.json` → `.json.migrated`. On partial failure, source files remain — next startup re-runs seed safely. |
| LISTEN/NOTIFY for mailbox delivery | Replaces filesystem polling. Instant notification. Fallback poll every 5s as safety net. |
| Remove `acquireLock()` from migrated modules | PG transactions replace file locks. Simpler, faster, correct under concurrency. |

## Success Criteria

- [ ] Kill -9 genie daemon mid-run, restart — all agents resume from PG state, zero data loss
- [ ] `~/.genie/workers.json` no longer written (migrated to `.json.migrated`)
- [ ] `~/.genie/teams/*.json` no longer written (migrated)
- [ ] `<repo>/.genie/mailbox/*.json` no longer written (migrated)
- [ ] `<repo>/.genie/chat/*.jsonl` no longer written (migrated)
- [ ] `<repo>/.genie/state.json`, `tasks.json`, `state/` deleted
- [ ] `genie ls`, `genie spawn`, `genie resume`, `genie send` all work against PG backend
- [ ] All existing tests pass
- [ ] Registry operations < 10ms at 1000 agents
- [ ] Fresh install on clean machine works (pgserve provisions, migrations run, zero JSON files created)
- [ ] Only `config.json`, `pgserve.port`, `pgserve.migrated` + `data/` remain in `~/.genie/`
- [ ] Seed is idempotent: kill -9 mid-seed, restart, completes without duplicate key errors

## Execution Strategy

### Wave 1 (single — foundation)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Schema migration + data seed infrastructure |

### Wave 2 (parallel — module migrations, no shared dependencies)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Agent registry → PG |
| 3 | engineer | Team manager → PG |
| 4 | engineer | Mailbox + team chat → PG |

### Wave 3 (after Wave 2 — depends on agents table)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | Pane colors + agent directory + legacy cleanup |
| review | reviewer | Review all groups |

## Execution Groups

### Group 1: Schema + Migration + Seed Infrastructure

**Goal:** Create PG tables matching current TypeScript interfaces, fix migration numbering, and build idempotent seed logic.

**Deliverables:**
1. Consolidate `004_cleanup_test_data.sql` into `004_clean_test_artifacts.sql` (merge contents, delete duplicate)
2. Create `src/db/migrations/005_pg_state.sql` with:
   - `agents` table mirroring `Agent` interface (id, pane_id, session, team, role, state, claude_session_id, pane_color, wish_slug, group_number, repo_path, worktree, provider, transport, auto_resume, resume_attempts, etc.)
   - `agent_templates` table mirroring `WorkerTemplate` interface
   - `teams` table mirroring team config shape (name, description, members JSONB, created_at)
   - `mailbox` table (id UUID, from_worker, to_worker, body, repo_path, read, delivered_at, created_at)
   - `team_chat` table (id, team, repo_path, sender, message, created_at)
   - Indexes on hot-path columns: `agents(state)`, `agents(team)`, `mailbox(to_worker, read)`, `team_chat(team, repo_path)`
   - LISTEN/NOTIFY triggers for `agents` state changes and `mailbox` inserts
3. Create `src/lib/pg-seed.ts` — idempotent seed function:
   - Read `workers.json` → UPSERT into `agents` + `agent_templates`
   - Read `teams/*.json` → UPSERT into `teams`
   - Read `mailbox/*.json` → UPSERT into `mailbox`
   - Read `chat/*.jsonl` → UPSERT into `team_chat`
   - Rename source files to `.migrated` only after all UPSERTs succeed
   - Wire into `getConnection()` flow (run after migrations if seed marker absent)

**Acceptance Criteria:**
- [ ] `005_pg_state.sql` creates all 5 tables on fresh DB
- [ ] `005_pg_state.sql` runs clean on existing DB with prior migrations
- [ ] Seed imports test fixtures from JSON → PG and query returns correct data
- [ ] Seed is idempotent: running twice produces no errors and no duplicates

**Validation:**
```bash
bun run build && bun test -- --grep "migration|seed" && echo "Group 1 OK"
```

**depends-on:** none

---

### Group 2: Agent Registry → PG

**Goal:** Replace all `readFile/writeFile` on `workers.json` with PG queries. Zero caller changes.

**Deliverables:**
1. Rewrite `agent-registry.ts` internals:
   - `loadRegistry()` → `SELECT * FROM agents` + `SELECT * FROM agent_templates`
   - `register()` → `INSERT INTO agents`
   - `updateState()` → `UPDATE agents SET state = $1 WHERE id = $2`
   - `unregister()` → `DELETE FROM agents WHERE id = $1`
   - `getAgent()` → `SELECT * FROM agents WHERE id = $1`
   - `listAgents()` → `SELECT * FROM agents` (with optional filters)
   - All template CRUD → `agent_templates` table
   - Add `paneColor?: string` field to `Agent` interface (maps to `pane_color` column)
   - Remove `acquireLock()` calls — PG handles concurrency
   - Remove `readFile/writeFile` imports and `registryFilePath()` helper
2. Update `agent-registry.test.ts` to use PG test schema isolation (existing pattern in `test-db.ts`)

**Acceptance Criteria:**
- [ ] `genie ls` shows agents from PG (not workers.json)
- [ ] `genie spawn engineer` creates agent row in PG
- [ ] Agent state transitions (spawning→working→idle→done) update PG rows
- [ ] `workers.json` is never read or written after migration
- [ ] All agent-registry tests pass against PG

**Validation:**
```bash
bun run build && bun test -- --grep "agent-registry|registry" && echo "Group 2 OK"
```

**depends-on:** Group 1

---

### Group 3: Team Manager → PG

**Goal:** Replace all `readFile/writeFile` on `teams/*.json` with PG queries.

**Deliverables:**
1. Rewrite `team-manager.ts` internals:
   - `loadTeam()` → `SELECT * FROM teams WHERE name = $1`
   - `saveTeam()` → `INSERT/UPDATE teams`
   - `deleteTeam()` → `DELETE FROM teams WHERE name = $1`
   - `listTeams()` → `SELECT * FROM teams`
   - Members stored as `JSONB` column (matches current nested structure)
   - Remove file I/O and path helpers
2. Update `team-manager.test.ts` to use PG test schema isolation

**Acceptance Criteria:**
- [ ] `genie team create` stores team config in PG
- [ ] `genie team disband` removes team from PG
- [ ] `genie status` reads team state from PG
- [ ] `~/.genie/teams/*.json` never read or written after migration
- [ ] All team-manager tests pass against PG

**Validation:**
```bash
bun run build && bun test -- --grep "team-manager|team" && echo "Group 3 OK"
```

**depends-on:** Group 1

---

### Group 4: Mailbox + Team Chat → PG

**Goal:** Replace mailbox JSON files and team chat JSONL with PG tables. Add LISTEN/NOTIFY for instant delivery.

**Deliverables:**
1. Rewrite `mailbox.ts` internals:
   - `send()` → `INSERT INTO mailbox` + `NOTIFY genie_mailbox_delivery`
   - `getMailbox()` → `SELECT * FROM mailbox WHERE to_worker = $1 AND repo_path = $2`
   - `markRead()` → `UPDATE mailbox SET read = true WHERE id = $1`
   - `getUnread()` → `SELECT * FROM mailbox WHERE to_worker = $1 AND read = false`
   - Remove `appendFile`, `readFile`, `writeFile` for mailbox paths
   - Remove `acquireLock()` calls
   - Add optional `LISTEN genie_mailbox_delivery` subscription for instant push
2. Rewrite `team-chat.ts` internals:
   - `postMessage()` → `INSERT INTO team_chat`
   - `getMessages()` → `SELECT * FROM team_chat WHERE team = $1 AND repo_path = $2 ORDER BY created_at`
   - Remove JSONL appendFile logic
3. Update `mailbox.test.ts` and `team-chat.test.ts` to use PG test schema

**Acceptance Criteria:**
- [ ] `genie send 'hello' --to engineer` stores message in PG mailbox table
- [ ] Agent receives messages from PG (not filesystem)
- [ ] Team chat messages stored in PG team_chat table
- [ ] `<repo>/.genie/mailbox/*.json` never read or written
- [ ] `<repo>/.genie/chat/*.jsonl` never read or written
- [ ] All mailbox + team-chat tests pass against PG

**Validation:**
```bash
bun run build && bun test -- --grep "mailbox|team-chat" && echo "Group 4 OK"
```

**depends-on:** Group 1

---

### Group 5: Pane Colors + Agent Directory + Legacy Cleanup

**Goal:** Eliminate remaining JSON files. Clean up dead state files.

**Deliverables:**
1. Pane colors (in `tmux.ts`):
   - Read/write `pane_color` via `agents` table column instead of `pane-colors.json`
   - Color assignment on spawn → `UPDATE agents SET pane_color = $1 WHERE id = $2`
   - Color lookup → `SELECT pane_color FROM agents WHERE id = $1`
2. Agent directory (in `agent-directory.ts`) — NO separate PG table, derived from `agents`:
   - Replace all `agent-directory.json` reads with queries against `agents` table (e.g., `SELECT DISTINCT role, team FROM agents WHERE ...`)
   - Remove JSON file I/O and path helpers entirely
   - Update callers in `dir.ts`, `auto-spawn.ts`, `builtin-agents.ts`, `protocol-router.ts`
   - Built-in agent definitions (from `builtin-agents.ts`) remain in code, not PG — they're static config
3. Legacy cleanup:
   - Remove code that reads/writes `<repo>/.genie/state.json`, `tasks.json`, `state/`
   - If any module still references these paths, delete the references
4. Update tests for pane-colors, agent-directory

**Acceptance Criteria:**
- [ ] `~/.genie/pane-colors.json` never read or written
- [ ] `~/.genie/agent-directory.json` never read or written
- [ ] `genie dir` works against PG-derived agent directory
- [ ] `<repo>/.genie/state.json`, `tasks.json`, `state/` references removed from code
- [ ] Fresh `genie` install creates zero JSON files in `~/.genie/` (only `config.json` + pgserve files)
- [ ] All tests pass

**Validation:**
```bash
bun run build && bun test && echo "Group 5 OK"
```

**depends-on:** Group 2 (needs agents table populated for pane_color and directory queries)

---

## QA Criteria

_What must be verified on dev after merge._

- [ ] `genie` fresh install → pgserve auto-provisions, tables created, no JSON files in `~/.genie/`
- [ ] `genie spawn engineer` + `genie ls` → agent visible, state updates work
- [ ] `genie send 'test' --to engineer` → message delivered via PG mailbox
- [ ] `genie team create test --wish test` → team stored in PG
- [ ] Kill -9 genie daemon → restart → `genie resume --all` → agents resume from PG
- [ ] Upgrade path: existing install with JSON files → `genie` → seed runs → JSON renamed to `.migrated` → PG operational
- [ ] No regression in `genie status`, `genie logs`, `genie dir`

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| pgserve fails to start on user machine | Medium | Already handled in db.ts with port fallback. Genie exits with clear error message. |
| Concurrent agent writes (was file-locked) | Low | PG transactions replace file locks. Simpler, faster, correct. |
| Partial seed failure on upgrade | Medium | Idempotent UPSERT. Rename to `.migrated` only after full success. Safe to re-run. |
| Performance regression at scale | Low | PG indexed queries faster than JSON parse. Validate < 10ms at 1000 agents. |
| Migration file naming conflict (two 004_*) | Medium | Consolidate into single `004_clean_test_artifacts.sql` in Group 1, before adding `005_pg_state.sql`. |
| Error mode shift (ENOENT → PG errors) | Low | Analyzed per-module: empty-on-missing pattern maps cleanly to empty-result-set. Connection failures surface loudly (correct). |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# CREATE
src/db/migrations/005_pg_state.sql        — schema for agents, agent_templates, teams, mailbox, team_chat
src/lib/pg-seed.ts                         — idempotent JSON → PG data seed

# MODIFY (core — internal rewrite, public API unchanged)
src/lib/agent-registry.ts                  — readFile/writeFile → PG queries
src/lib/team-manager.ts                    — readFile/writeFile → PG queries
src/lib/mailbox.ts                         — readFile/writeFile/appendFile → PG queries
src/lib/team-chat.ts                       — appendFile → PG INSERT
src/lib/agent-directory.ts                 — JSON file → SELECT from agents table
src/lib/tmux.ts                            — pane-colors.json → agents.pane_color column
src/lib/db.ts                              — wire seed into getConnection() flow

# MODIFY (migration fix)
src/db/migrations/004_clean_test_artifacts.sql  — rename or consolidate with duplicate 004_*

# MODIFY (tests)
src/lib/agent-registry.test.ts             — PG test schema isolation
src/lib/team-manager.test.ts               — PG test schema isolation
src/lib/__tests__/mailbox.test.ts          — PG test schema isolation
src/lib/team-chat.test.ts                  — PG test schema isolation
src/lib/agent-directory.test.ts            — PG test schema isolation

# DELETE (dead code/files — remove references)
<repo>/.genie/state.json                   — superseded by PG agent_checkpoints
<repo>/.genie/tasks.json                   — superseded by PG tasks table
<repo>/.genie/state/                       — superseded by PG agent_checkpoints
```
