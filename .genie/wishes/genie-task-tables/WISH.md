# Wish: Genie Task Lifecycle Tables + CLI

| Field | Value |
|-------|-------|
| **Status** | SUPERSEDED |
| **Slug** | `genie-task-tables` |
| **Date** | 2026-03-25 |
| **Repo** | `automagik-dev/genie` |
| **depends-on** | `genie-db-cleanup` (clean DB required) |

## Summary
Add the core task lifecycle tables to Genie's embedded pgserve. 7 tables, 1 built-in type (software with 7-stage pipeline), priority/due-date/effort fields, execution locking, and full CLI commands. This replaces the limited wish-group state with a real task management system.

## Scope

### IN
- **Migration `005_task_lifecycle.sql`** with 7 tables:
  - `task_types` — dynamic pipeline definitions (stages as JSONB array)
  - `tasks` — unified work entity with seq IDs per repo, parent_id recursion, priority, due_date, start_date, effort, blocked_reason, checkout_run_id, execution_locked_at
  - `task_actors` — polymorphic assignment (role: owner/assignee/reviewer/watcher)
  - `task_dependencies` — type field (blocks/depends_on/relates_to)
  - `task_stage_log` — audit trail of stage transitions
  - `tags` — global tag definitions (6 defaults: bug, feature, improvement, chore, urgent, idea)
  - `task_tags` — many-to-many join
- **Seed**: 1 built-in type `software` with 7 stages (draft→brainstorm→wish→build→review→qa→ship)
- **Stage validation trigger**: rejects invalid stage for type
- **LISTEN/NOTIFY** on task stage changes (`genie_task_stage`)
- **`task-service.ts`**: PG CRUD for all tables
- **CLI commands**:
  - `genie task create <title> [--type software] [--priority high] [--due 2026-04-01] [--parent #47]`
  - `genie task list [--project X] [--stage Y] [--priority Z] [--assignee A]`
  - `genie task show <id>` — full detail with stage history + dependencies
  - `genie task move <id> <stage> [--comment "reason"]`
  - `genie task assign <id> <actor> [--role assignee]`
  - `genie task block <id> --reason "waiting on X"`
  - `genie task done <id> [--comment "completed"]`
  - `genie tag list` / `genie tag create <name>`
  - `genie type list` / `genie type show <id>` / `genie type create` (agentic type creation)
- **Execution locking**: `genie work` atomically claims task via `checkout_run_id`. Stale locks auto-expire after timeout (default 10min).
- **Human-friendly IDs**: Sequential `#47` per repo_path, UUID as internal PK

### OUT
- Conversations/messages (separate wish: genie-messaging-pg)
- File-state elimination / wish bridge rewrite (future)
- Workers/teams PG migration (future)
- OTel integration (future)

## Decisions

| Decision | Rationale |
|----------|-----------|
| 7 tables, not 11 | Split messaging into separate wish. Core task lifecycle first. |
| Sequential short IDs per repo | Humans say "move task 47". UUID is internal PK. |
| Priority as column | Indexed, queryable. Not buried in JSONB. |
| Recursive parent_id | Software uses 2-level. Schema supports unlimited depth. |
| Execution locking (Paperclip pattern) | Prevents concurrent work on same task. Auto-expires stale locks. |
| Stages in JSONB on task_types | Dynamic — agents create new pipeline types without code changes. |

## Success Criteria

- [ ] `task_types` table exists with `software` type seeded (7 stages)
- [ ] `tasks` table exists with all specified columns
- [ ] `genie task create "Test task" --priority high` creates task with sequential ID
- [ ] `genie task list` shows tasks with stage, priority, assignee
- [ ] `genie task move <id> brainstorm` transitions stage + writes stage_log
- [ ] `genie task show <id>` displays full detail including stage history
- [ ] Stage validation trigger rejects invalid stages
- [ ] `genie type list` shows the software type with stages
- [ ] 6 default tags seeded (bug, feature, improvement, chore, urgent, idea)
- [ ] Execution locking works: `checkout_run_id` set on `genie work`, released on completion
- [ ] LISTEN/NOTIFY fires on stage change
- [ ] `bun run check` passes

## Execution Groups

### Group 1: Schema + Service
**Agent:** engineer
**Deliverables:**
1. `src/db/migrations/005_task_lifecycle.sql` — all 7 tables + indexes + seed data + triggers
2. `src/lib/task-service.ts` — CRUD operations for tasks, types, actors, dependencies, tags

**depends-on:** none

### Group 2: CLI Commands
**Agent:** engineer
**Deliverables:**
1. `src/term-commands/task.ts` — create, list, show, move, assign, block, done
2. `src/term-commands/type.ts` — list, show, create
3. `src/term-commands/tag.ts` — list, create
4. Wire execution locking into `genie work` flow

**depends-on:** Group 1

### Group 3: Review
**Agent:** reviewer

**depends-on:** Groups 1+2
