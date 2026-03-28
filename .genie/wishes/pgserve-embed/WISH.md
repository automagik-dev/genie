# Wish: Embed pgserve as Genie's Persistent Brain

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `pgserve-embed` |
| **Date** | 2026-03-20 |
| **Design** | [DESIGN.md](../../brainstorms/work-fire-forget/DESIGN.md) |
| **Blocks** | `genie-scheduler`, `genie-observability` |

## Summary

Embed pgserve (embedded PostgreSQL) as a genie dependency. One instance per machine on port 19642, auto-started on demand. This becomes genie's persistent brain for scheduling, observability, learning, and machine state — replacing fragile JSON + file locks for durable operations.

## Scope

### IN
- Add `pgserve` to `package.json` dependencies
- Create `src/lib/db.ts` — connection management, lazy init, health check
- Create `src/lib/db-migrations.ts` — schema versioning and migration runner
- Create database schema (core scheduler tables + agent_checkpoints)
- `agent_checkpoints` table: persist what each agent is doing so respawns can resume
- `genie db status` — show pgserve health, connection, table counts
- `genie db migrate` — run pending migrations manually
- `genie db query` — ad-hoc SQL for debugging
- Auto-start pgserve on first command that needs PG (lazy init)
- Data dir: `~/.genie/data/pgserve/`
- Port: `19642` bound to `127.0.0.1` only
- Graceful startup/shutdown with retry and error handling
- File-based fallback detection: if pgserve fails, set `GENIE_PG_AVAILABLE=false`

### OUT
- No scheduler daemon (separate wish: `genie-scheduler`)
- No `genie schedule` commands (separate wish)
- No observability CLI commands like `genie metrics` (separate wish: `genie-observability`)
- No NATS integration
- No migration of existing file-based state (registry, mailbox, wish-state) to PG
- No pgvector or AI-specific extensions (yet)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Port 19642 | Derived from "genie" — unique, unlikely to collide with common services |
| 127.0.0.1 only | Security: never exposed to network. Local-only credentials acceptable |
| One instance per machine | All genie projects share it. Simpler than per-project isolation |
| Lazy init (not daemon) | Start pgserve only when needed. Don't add startup cost to simple commands like `genie --help` |
| Schema migrations in code | Version-controlled, run on connect. No manual migration step needed |
| `postgres:postgres` credentials | Localhost-only, no network auth needed. Simplicity over ceremony |

## Success Criteria

- [ ] `pgserve` is in `package.json` dependencies
- [ ] `genie db status` reports pgserve health (running/stopped, port, data dir, table count)
- [ ] `genie db migrate` runs all pending migrations
- [ ] `genie db query "SELECT 1"` returns result
- [ ] pgserve auto-starts on port 19642 when first PG command runs
- [ ] pgserve data persists in `~/.genie/data/pgserve/` across reboots
- [ ] Schema includes core scheduler tables (schedules, triggers, runs, heartbeats, audit_events)
- [ ] Indexes created for scheduler tables
- [ ] Migration system supports adding tables incrementally (observability tables added later when needed)
- [ ] If pgserve fails to start, `GENIE_PG_AVAILABLE` is set to false and warning printed
- [ ] `bun run check` passes

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | pgserve integration + connection management |
| 2 | engineer | Schema + migrations |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | `genie db` CLI commands |

### Wave 3 (after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review all changes |

## Execution Groups

### Group 1: pgserve integration + connection management

**Goal:** Embed pgserve and create the connection/lifecycle management layer.

**Deliverables:**
1. Add `pgserve` to `package.json` dependencies
2. Create `src/lib/db.ts`:
   - `ensurePgserve()` — start pgserve if not running on port 19642. Use pgserve Node.js API (`startMultiTenantServer`). Data dir `~/.genie/data/pgserve/`. Retry with port auto-increment fallback. Handle orphaned postgres processes.
   - `getConnection()` — lazy singleton. Calls `ensurePgserve()` on first use. Returns postgres.js client connected to `postgresql://postgres:postgres@127.0.0.1:19642/genie`
   - `isAvailable()` — returns boolean. Non-throwing health check.
   - `shutdown()` — graceful close. Does NOT stop pgserve (it persists for other genie processes).
3. Add `GENIE_PG_PORT` env var override (default 19642)
4. Add `GENIE_PG_AVAILABLE` env var set on startup (true/false)

**Acceptance Criteria:**
- [ ] `ensurePgserve()` starts pgserve on 19642 if not running
- [ ] `ensurePgserve()` is idempotent (safe to call multiple times)
- [ ] `getConnection()` returns working postgres client
- [ ] `isAvailable()` returns false if pgserve can't start
- [ ] Port override via `GENIE_PG_PORT` works

**Validation:**
```bash
bun run typecheck && bun run lint
```

**depends-on:** none

---

### Group 2: Schema + migrations

**Goal:** Create the full database schema with a migration system.

**Deliverables:**
1. Create `src/lib/db-migrations.ts`:
   - Migration runner: reads `src/db/migrations/*.sql` files in order
   - Tracks applied migrations in `_genie_migrations` table
   - `runMigrations()` — apply all pending. Called by `getConnection()` on first connect.
   - `getMigrationStatus()` — list applied + pending migrations
2. Create `src/db/migrations/001_initial.sql`:
   - Core scheduler tables only: schedules, triggers, runs, heartbeats, audit_events
   - Indexes for scheduler queries (due triggers, leased, running runs, audit by entity)
   - `agent_checkpoints` table for session resume:
     ```sql
     CREATE TABLE agent_checkpoints (
       worker_id TEXT PRIMARY KEY,
       wish_slug TEXT,
       group_name TEXT,
       phase TEXT,                -- 'executing', 'validating', 'reporting'
       context_summary TEXT,      -- what the agent was doing
       dispatch_context TEXT,     -- full dispatch prompt (replaces /tmp/ files)
       branch_name TEXT,          -- git branch agent is working on
       last_checkpoint TIMESTAMPTZ DEFAULT now()
     );
     ```
   - Observability tables (agent_metrics, error_patterns, prompt_outcomes, machine_snapshots) deferred — added via future migrations when pain points emerge
   - LISTEN/NOTIFY function for `genie_trigger_due`
3. Create PG function for trigger notification:
   ```sql
   CREATE OR REPLACE FUNCTION notify_trigger_due()
   RETURNS trigger AS $$
   BEGIN
     PERFORM pg_notify('genie_trigger_due', NEW.id::text);
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql;

   CREATE TRIGGER trg_notify_due
     AFTER INSERT ON triggers
     FOR EACH ROW
     WHEN (NEW.status = 'pending')
     EXECUTE FUNCTION notify_trigger_due();
   ```

**Acceptance Criteria:**
- [ ] `_genie_migrations` table tracks applied migrations
- [ ] All 9 tables from DESIGN.md exist after migration
- [ ] All indexes created
- [ ] `pg_notify` trigger fires on new trigger insert
- [ ] `getMigrationStatus()` shows applied/pending correctly
- [ ] Migration system is incremental (easy to add 002_observability.sql later)

**Validation:**
```bash
bun run typecheck && bun run lint
```

**depends-on:** none

---

### Group 3: `genie db` CLI commands

**Goal:** Add database management commands to the CLI.

**Deliverables:**
1. Create `src/term-commands/db.ts`:
   - `genie db status` — show: pgserve running?, port, data dir, database size, table row counts, migration status
   - `genie db migrate` — run pending migrations, show results
   - `genie db query "<sql>"` — execute arbitrary SQL, print results as table
2. Register commands in `src/genie.ts` CLI router

**Acceptance Criteria:**
- [ ] `genie db status` shows health, port, data dir, table counts
- [ ] `genie db migrate` runs pending migrations
- [ ] `genie db query "SELECT count(*) FROM schedules"` returns result
- [ ] Commands handle pgserve-not-running gracefully (auto-start or error message)

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** Group 1, Group 2

---

## QA Criteria

- [ ] Fresh install: `genie db status` auto-starts pgserve, runs migrations, reports healthy
- [ ] `genie db query "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"` lists all 9+ tables
- [ ] Reboot machine → `genie db status` reconnects to existing data (persistence verified)
- [ ] Two genie processes simultaneously: both connect to same pgserve without conflict
- [ ] `bun run check` passes with zero errors

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| pgserve binary 100MB download on first run | Medium | Cache in `~/.genie/data/pgserve/`, downloads once. Show progress. |
| pgserve fails on exotic Linux distros | Low | File-based fallback. Warn user. pgserve supports Linux x64, macOS ARM64/x64, Windows x64. |
| Port 19642 collision | Low | Auto-increment fallback (19643, 19644...). `GENIE_PG_PORT` override. |
| postgres.js dependency bloat | Low | postgres.js is lightweight (~50KB). No ORM needed. |

## Files to Create/Modify

```
package.json                         — add pgserve, postgres.js dependencies
src/lib/db.ts                        — NEW: connection management, ensurePgserve, getConnection
src/lib/db-migrations.ts             — NEW: migration runner
src/db/migrations/001_initial.sql    — NEW: full schema
src/term-commands/db.ts              — NEW: genie db status/migrate/query
src/genie.ts                         — register db commands
```
