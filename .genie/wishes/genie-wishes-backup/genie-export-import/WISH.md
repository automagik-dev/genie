# Wish: Genie Export/Import — Data Portability Foundation

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `genie-export-import` |
| **Date** | 2026-03-25 |
| **Design** | [DESIGN.md](../../brainstorms/genie-export-import/DESIGN.md) |
| **Phase** | Phase 1 — Foundation for git-install and marketplace |
| **Repo** | **genie CLI** (`/home/genie/agents/namastexlabs/genie/repos/genie/`) |
| **Commands location** | `src/term-commands/export.ts`, `src/term-commands/import.ts` |

## Summary

Add `genie export` and `genie import` commands to the genie CLI for full data portability. Export any data from the unified database as schema-versioned JSON. Import with FK-ordered transactional inserts and conflict resolution. 10 export groups covering all 28 tables. Gracefully skip missing tables (pure genie vs genie+KhalOS installs).

## Scope

### IN
- `genie export all` — full backup (all present tables)
- `genie export <group>` — boards, tasks, tags, projects, schedules, agents, apps, comms, config
- `genie export <group> <name>` — single item export
- `genie import <file>` — restore with `--fail`/`--merge`/`--overwrite`
- `genie import <file> --groups boards,tags` — selective import
- FK dependency ordering, transactional, audit logged
- Graceful skip for missing tables

### OUT
- Git integration, marketplace, binary data, encryption, streaming

## Success Criteria

- [ ] `genie export all` produces valid JSON
- [ ] Each of 10 export groups works independently
- [ ] Missing tables silently skipped
- [ ] Import follows FK dependency order (4 levels)
- [ ] Self-referential tables handled (tasks.parent_id, messages.reply_to)
- [ ] Conflict modes: `--fail`, `--merge`, `--overwrite`
- [ ] Transactional: rollback on any error
- [ ] All imports logged to `audit_events`
- [ ] Round-trip: export → import → identical data

## Execution Strategy

### Wave 1 (parallel — framework + simple groups)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Export framework: command structure, JSON format, schema version, table detection |
| 2 | engineer | Simple export groups: boards, tags, projects, schedules (Level 0-1 tables) |

### Wave 2 (parallel — complex groups)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Complex export groups: tasks (with deps/actors/stage_log), agents, comms |
| 4 | engineer | Optional export groups: apps, config (graceful skip for missing tables) |

### Wave 3 (sequential — import depends on export format)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | Import: parse, validate, conflict resolution, FK-ordered transactional insert |
| 6 | engineer | `genie export all` + `genie import --groups` + round-trip integration test |

### Wave 4
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review all groups |

## Execution Groups

### Group 1: Export Framework

**Goal:** CLI command structure, JSON format types, table detection utility.

**Deliverables:**

1. **`src/term-commands/export.ts`** — Commander command group:
   ```
   genie export all
   genie export boards [name]
   genie export tasks [--project <name>]
   genie export tags
   genie export projects
   genie export schedules [name]
   genie export agents
   genie export apps
   genie export comms
   genie export config
   ```
   Flags: `--output <file>`, `--pretty`, `--include-history`, `--include-audit`, `--include-sessions`, `--include-triggers`

2. **`src/lib/export-format.ts`** — TypeScript types:
   ```typescript
   interface ExportDocument {
     version: "1.0";
     exportedAt: string;
     exportedBy: string;
     genieVersion: string;
     type: "full" | "partial";
     skippedTables: string[];
     data: Record<string, unknown[]>;
   }
   ```

3. **`src/lib/table-detect.ts`** — utility to check which tables exist:
   ```typescript
   async function getAvailableTables(db): Promise<string[]>
   // Queries information_schema.tables, returns list of table names
   ```

4. **Register** in `src/genie.ts` or equivalent command registry.

**Acceptance Criteria:**
- [ ] `genie export --help` shows all subcommands and flags
- [ ] ExportDocument type defined with version, skippedTables
- [ ] `getAvailableTables()` returns actual table list from connected DB
- [ ] Auto-named output: `genie-backup-YYYYMMDD.json`

**depends-on:** none

---

### Group 2: Simple Export Groups

**Goal:** Export boards, tags, projects, schedules — tables with no complex relationships.

**Deliverables:**

1. **Boards export** — queries `task_types` (skip `is_builtin: true`), `board_templates`, `boards`. Single board: filter by name.
2. **Tags export** — queries `tags`. Skips test-* prefixed entries.
3. **Projects export** — queries `projects`.
4. **Schedules export** — queries `schedules` with `run_spec` JSONB. Single schedule: filter by name.

Each outputs ExportDocument with `type: "partial"` and the relevant data key.

**Acceptance Criteria:**
- [ ] `genie export boards` outputs valid JSON with non-builtin task_types
- [ ] `genie export board "Hiring Pipeline"` outputs single board
- [ ] `genie export tags` outputs tags (excluding test-*)
- [ ] `genie export projects` outputs projects
- [ ] `genie export schedules` outputs schedules with run_spec
- [ ] `genie export schedule "Daily Standup"` outputs single schedule

**Validation:**
```bash
genie export boards | jq '.data.boards | length' && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 1

---

### Group 3: Complex Export Groups

**Goal:** Export tasks (with all relationships), agents, communications.

**Deliverables:**

1. **Tasks export** — queries `tasks` with JOINs for:
   - `task_tags` → tag IDs per task
   - `task_actors` → actor assignments
   - `task_dependencies` → depends-on/blocks
   - `task_stage_log` → stage transitions with actor + timestamp
   - `--project <name>` filters by project_id
   - Excludes ephemeral fields: `checkout_run_id`, `execution_locked_at`, `session_id`, `pane_id`

2. **Agents export** — queries `agents`, `agent_templates`, `agent_checkpoints`.

3. **Comms export** — queries `conversations`, `conversation_members`, `messages`, `mailbox`, `team_chat`, `notification_preferences`.

**Acceptance Criteria:**
- [ ] Tasks export includes tags, actors, dependencies, stage_log per task
- [ ] `--project` filter works
- [ ] Agents export includes templates and checkpoints
- [ ] Comms export includes all 6 communication tables

**depends-on:** Group 1

---

### Group 4: Optional Export Groups (Graceful Skip)

**Goal:** Export KhalOS-specific tables, gracefully skipping if they don't exist.

**Deliverables:**

1. **Apps export** — queries `app_store`, `installed_apps`, `app_versions`. If any table missing → skip with note in `skippedTables`.
2. **Config export** — queries `os_config`, `instances`, `warm_pool`, `golden_images`. If any table missing → skip.
3. Uses `getAvailableTables()` from Group 1 to check before querying.

**Acceptance Criteria:**
- [ ] Apps export works when tables exist
- [ ] Apps export gracefully skips when tables don't exist (no error, noted in skippedTables)
- [ ] Config export same behavior

**depends-on:** Group 1

---

### Group 5: Import

**Goal:** Parse, validate, conflict-resolve, and transactionally import.

**Deliverables:**

1. **`src/term-commands/import.ts`** — Commander command:
   ```
   genie import <file> [--fail|--merge|--overwrite] [--groups <list>]
   ```

2. **Schema validation** — check `version` field, reject incompatible.

3. **Conflict detection** — per-group check by primary key:
   - `--fail` (default): abort if ANY conflict
   - `--merge`: skip existing, import new
   - `--overwrite`: DELETE existing + INSERT imported

4. **FK-ordered insert** — follow dependency graph:
   ```
   Level 0: schedules, sessions, projects, agents, agent_templates, app_store, os_config, ...
   Level 1: task_types, tags, triggers, conversations, installed_apps, boards, ...
   Level 2: tasks, runs, messages, conversation_members
   Level 3: task_tags, task_actors, task_dependencies, task_stage_log, heartbeats
   ```

5. **Self-referential handling:**
   - `tasks`: INSERT with `parent_id = NULL` first, UPDATE `parent_id` after all tasks inserted
   - `messages`: INSERT with `reply_to = NULL` first, UPDATE after all messages inserted

6. **Transaction:** BEGIN → insert all levels → COMMIT. Any error → ROLLBACK.

7. **Audit logging:** INSERT into `audit_events` on success.

8. **`--groups` filter:** `genie import backup.json --groups boards,tags` imports only specified groups.

**Acceptance Criteria:**
- [ ] Full backup import works transactionally
- [ ] `--fail` aborts on conflict (no partial import)
- [ ] `--merge` skips existing, imports new
- [ ] `--overwrite` replaces existing
- [ ] FK order respected (no constraint violations)
- [ ] Self-referential tables handled correctly
- [ ] Failed import rolls back completely
- [ ] `--groups` filter works

**depends-on:** Groups 2, 3, 4 (export defines the format)

---

### Group 6: Export All + Integration Test

**Goal:** Compose all groups into `genie export all` and verify round-trip.

**Deliverables:**

1. **`genie export all`** — calls all export groups, composes single ExportDocument with `type: "full"`.
2. **Round-trip test:** export all → import on clean state → export again → compare JSON (should be identical minus timestamps).
3. **Auto-naming:** `genie-backup-20260325.json`.

**Acceptance Criteria:**
- [ ] `genie export all` produces complete backup
- [ ] Round-trip test passes
- [ ] Auto-naming works

**depends-on:** Group 5 (import must work for round-trip test)

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Large tasks table (35MB) | Medium | `--project` filter, stream writes, progress output |
| Self-referential FK cycles | Medium | Nullify self-refs, insert, update after |
| conversations↔messages circular FK | Medium | Import conversations first (nullify message FK), then messages, then update |
| KhalOS tables missing | Low | Graceful skip via `getAvailableTables()` |

## Files to Create/Modify

```
REPO: /home/genie/agents/namastexlabs/genie/repos/genie/

CREATE:
  src/term-commands/export.ts        — export command group
  src/term-commands/import.ts        — import command
  src/lib/export-format.ts           — ExportDocument types + schema version
  src/lib/table-detect.ts            — table existence detection
  src/lib/import-order.ts            — FK dependency graph + level ordering

MODIFY:
  src/genie.ts (or command registry) — register export/import commands
```
