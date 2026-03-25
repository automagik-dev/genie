# Wish: Genie Boards + Workflow Automations

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-boards-workflows` |
| **Date** | 2026-03-25 |
| **Design** | [DRAFT.md](/home/genie/agents/sofia/.genie/brainstorms/genie-task-boards/DRAFT.md) |

## Summary

Replace `task_types` with a proper Board + Workflow system. A board is a project-scoped kanban with ordered columns. Each column can have workflow automations — `gate: human` means a person must advance it, `gate: agent` means genie auto-dispatches a skill when a task enters that column. Boards are created from templates via CLI, not SQL. One project can have many boards. A workflow can even deploy its own board (meta-automation). This is the runtime that reads the `gate`, `action`, `auto_advance` fields that already exist in `task_types.stages` but have zero execution behind them today.

## Scope

### IN

#### Layer 1: Boards (the view)
- **`boards` PG table** — replaces `task_types` as the column definition layer. Each board belongs to a project. Columns stored as JSONB array (same shape as current `stages`).
- **Multiple boards per project** — khal-os can have "Dev Pipeline", "Sales Pipeline", "QA Nightly"
- **`genie board` CLI** — `create`, `list`, `show`, `edit`, `delete`, `columns add/remove/reorder`
- **Board-scoped task queries** — `genie task list --board "Dev Pipeline"`
- **Task ↔ Board assignment** — tasks belong to a board (not just a type). `tasks.board_id` FK replaces `tasks.type_id`
- **Migration from `task_types`** — convert existing types to boards, assign orphan tasks

#### Layer 2: Templates (the blueprint)
- **`board_templates` PG table** — reusable blueprints for boards
- **Builtin templates** seeded on first run: `software` (current 7-stage), `sales`, `hiring`, `ops`
- **`genie board create "Name" --from software --project khal-os`** — creates board from template
- **Custom templates** — `genie board save-template "My Custom" --from "Dev Pipeline"`
- Boards diverge from templates freely after creation — templates are starting points, not constraints

#### Layer 3: Workflows (the brain)
- **Workflow automations live ON the board columns** — each column has `gate`, `action`, `auto_advance`
- **Workflow runtime** — a listener on `genie_task_stage` NOTIFY that:
  1. Reads the target column's config from the board
  2. If `gate: agent` + `action` is set → auto-dispatches the skill/agent
  3. If `auto_advance: true` → moves task to next column on skill completion
  4. If `gate: human` → does nothing (waits for manual move)
  5. If `gate: human+agent` → dispatches agent but requires human approval to advance
- **Skill-to-column binding** — column `action` field maps to genie skills: `/brainstorm`, `/wish`, `/work`, `/review`, `/qa`, or custom skills
- **Agent role binding** — column `roles` field maps to genie agents: `engineer`, `reviewer`, `qa`, `pm`
- **Transition triggers** — beyond stage entry, support:
  - `on_enter` — when task enters this column (existing: spawn agent)
  - `on_complete` — when the column's action finishes (advance to next)
  - `on_external` — when an external event arrives (PR merge, webhook, etc.)
- **Workflow-created boards** — a workflow step can create a new board for its sub-process (e.g. "deploy" step creates a temporary "Deploy Checklist" board with its own columns)

#### Layer 4: CLI
- `genie board create <name> --project <project> [--from <template>] [--columns "a,b,c"]`
- `genie board list [--project <project>]`
- `genie board show <name>`
- `genie board edit <name> --add-column <name> [--after <column>] [--gate human|agent] [--action /skill]`
- `genie board columns <name>` — show column pipeline with gates/actions
- `genie board delete <name>`
- `genie board save-template <name> --from <board>`
- `genie board templates` — list available templates
- `genie task create <title> --board <board> --project <project>`
- `genie task list --board <board>`

### OUT
- Cross-board dependencies (e.g. dev board "ship" triggers sales board "lead") — future
- Visual kanban UI (KhalOS scope, reads from this PG)
- External webhook ingestion (future — start with NOTIFY-based internal triggers)
- Retry/rollback on agent failure (v2 — first version escalates to human on failure)
- Board permissions / RBAC (future — for now, anyone can see/edit any board)
- Real-time event bus beyond PG NOTIFY (Kafka/NATS — overengineered for now)

## Decisions

| Decision | Rationale |
|----------|-----------|
| **Boards replace task_types, not wrap** | task_types was a prototype. Boards are the real thing. Clean migration, no dual system. |
| **Workflows live on columns, not as separate entities** | A column IS its automation config. No need for a separate `workflows` table — that's premature abstraction. The column's `gate`+`action`+`auto_advance` IS the workflow. |
| **PG NOTIFY is the trigger mechanism** | Already exists (`genie_task_stage`), already fires on every stage change. The runtime just needs to LISTEN and react. No polling, no external event bus. |
| **Skill-based actions, not arbitrary code** | Column actions point to genie skills (`/work`, `/review`, `/qa`). Skills are sandboxed, documented, testable. No arbitrary shell commands in board config. |
| **Templates are snapshots, not live references** | Creating a board from a template copies the config. Board evolves independently. Simpler than inheritance/overrides. |
| **Meta-boards (workflow creates board) is a column action** | A column action can be `genie board create` — no special-casing needed. It's just another skill/command the workflow dispatches. |

## Success Criteria

- [ ] `genie board create "Dev" --project khal-os --from software` works
- [ ] `genie board create "Sales" --project khal-os --columns "lead,qualified,proposal,closed"` works
- [ ] `genie board list --project khal-os` shows both boards
- [ ] `genie task create "Fix auth" --board Dev --project khal-os` creates task on the Dev board
- [ ] `genie task list --board Dev` shows only Dev board tasks
- [ ] `genie board columns Dev` shows the pipeline with gates and actions
- [ ] Moving a task to a `gate: agent, action: /work` column auto-spawns an engineer
- [ ] Moving a task to a `gate: human` column does NOT auto-dispatch anything
- [ ] `auto_advance: true` moves task to next column when agent skill completes
- [ ] `task_types` table is migrated to `boards` — no data loss
- [ ] All existing tasks retain their stage/column after migration
- [ ] `genie type` commands still work (aliased to `genie board` with deprecation warning)

## Execution Strategy

### Wave 1: Schema + Migration (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | `boards` + `board_templates` tables, migrate from `task_types`, update `tasks.type_id` → `tasks.board_id` |
| 2 | engineer | Seed builtin templates: software, sales, hiring, ops |

### Wave 2: CLI (parallel, after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | `genie board` CLI commands: create, list, show, edit, delete, columns, save-template, templates |
| 4 | engineer | Update `genie task create/list` to accept `--board` flag, board-scoped queries |

### Wave 3: Workflow Runtime (after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | Workflow listener: LISTEN on `genie_task_stage`, read board column config, dispatch skill/agent on `gate: agent` columns |
| 6 | engineer | Auto-advance: on skill completion, move task to next column if `auto_advance: true`. Escalate to human on failure. |

### Wave 4: Review + QA
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review all groups against wish criteria |
| qa | qa | End-to-end test: create board from template, create task, move through automated pipeline |

## Execution Groups

### Group 1: Schema + Migration
**Goal:** Replace `task_types` with `boards` table, preserve all existing data.

**Deliverables:**
1. New migration: `boards` table (id, name, project_id FK, columns JSONB, created_at, updated_at)
2. New migration: `board_templates` table (id, name, description, icon, columns JSONB, is_builtin, created_at)
3. Migration: copy `task_types` → `boards` (one board per type, assigned to appropriate project)
4. Migration: `tasks.type_id` → `tasks.board_id` (FK to boards)
5. Update `validate_task_stage` trigger to read from `boards.columns` instead of `task_types.stages`
6. Keep `task_types` as deprecated view/alias during transition

**Acceptance Criteria:**
- [ ] `boards` table exists with all migrated data
- [ ] `tasks.board_id` FK works
- [ ] Stage validation still enforces valid columns
- [ ] Zero data loss on existing tasks

**Validation:**
```bash
genie db query "SELECT count(*) FROM boards"
genie db query "SELECT count(*) FROM tasks WHERE board_id IS NOT NULL"
bun test src/lib/task-service.test.ts
```

**depends-on:** none

---

### Group 2: Seed Templates
**Goal:** Create reusable board templates for common workflows.

**Deliverables:**
1. `software` template — draft→brainstorm→wish→build→review→qa→ship (migrate from builtin task_type)
2. `sales` template — lead→qualified→proposal→negotiation→closed-won→closed-lost (all human-gated)
3. `hiring` template — sourcing→screening→interview→offer→hired (migrate from existing)
4. `ops` template — identified→planning→in-progress→done (migrate from existing)
5. Template columns include full config: name, label, gate, action, auto_advance, color, roles

**Acceptance Criteria:**
- [ ] `genie board templates` lists 4 builtin templates
- [ ] Each template has correct column configs with gates and actions

**Validation:**
```bash
genie db query "SELECT name FROM board_templates WHERE is_builtin = true"
```

**depends-on:** Group 1

---

### Group 3: Board CLI
**Goal:** Full CLI for board management — no more SQL.

**Deliverables:**
1. `genie board create <name> --project <project> [--from <template>] [--columns "a,b,c"]`
2. `genie board list [--project <project>]`
3. `genie board show <name>` — detail view with column pipeline
4. `genie board edit <name>` — add/remove/reorder columns, change gate/action
5. `genie board delete <name>`
6. `genie board columns <name>` — compact pipeline view (like `genie type show` but better)
7. `genie board save-template <name> --from <board>`
8. `genie board templates` — list available templates
9. Deprecation: `genie type` commands alias to `genie board` with warning

**Acceptance Criteria:**
- [ ] All 8 commands work
- [ ] `--from template` copies template columns to new board
- [ ] `--columns "a,b,c"` creates board with custom columns (all human-gated by default)
- [ ] `edit` can change gate/action on individual columns

**Validation:**
```bash
genie board create "Test" --project genie --from software
genie board list --project genie
genie board columns "Test"
genie board delete "Test"
```

**depends-on:** Group 1, Group 2

---

### Group 4: Task ↔ Board Integration
**Goal:** Tasks belong to boards, queries are board-scoped.

**Deliverables:**
1. `genie task create <title> --board <board> --project <project>` — assigns task to board
2. `genie task list --board <board>` — board-scoped query
3. `genie task move` validates stage against the task's board columns (not global types)
4. Default board: if project has exactly one board, it's used automatically

**Acceptance Criteria:**
- [ ] Tasks can be created on a specific board
- [ ] `--board` filter works on list
- [ ] Stage validation uses the task's board, not the global type

**Validation:**
```bash
genie board create "Dev" --project genie --from software
genie task create "Test task" --board Dev --project genie
genie task list --board Dev
```

**depends-on:** Group 3

---

### Group 5: Workflow Listener
**Goal:** When a task enters an agent-gated column, auto-dispatch the configured skill.

**Deliverables:**
1. `WorkflowListener` class — connects to PG LISTEN on `genie_task_stage`
2. On stage change notification: look up the board, look up the target column config
3. If `gate: agent` and `action` is set: dispatch the skill (via `genie spawn` or skill invocation)
4. If `gate: human` or `gate: human+agent`: log the transition, do not auto-dispatch
5. Listener runs as part of the genie daemon (scheduler-daemon.ts integration)
6. `genie workflow status` — show which columns are automated on a board

**Acceptance Criteria:**
- [ ] Moving a task to a `gate: agent, action: /work` column triggers agent spawn
- [ ] Moving a task to a `gate: human` column does NOT trigger anything
- [ ] Listener recovers from PG reconnection

**Validation:**
```bash
# Create board with one agent column
genie board create "AutoTest" --project genie --columns "todo,build,done"
genie board edit "AutoTest" --column build --gate agent --action /work
# Create task, move to build — should trigger
genie task create "Auto test" --board AutoTest --project genie
genie task move <id> --to build
# Verify agent was spawned
genie status
```

**depends-on:** Group 4

---

### Group 6: Auto-Advance
**Goal:** When an agent completes its skill, auto-move the task to the next column.

**Deliverables:**
1. On skill/agent completion: check if the column has `auto_advance: true`
2. If yes: move task to the next column in the board's column order
3. If the next column is also `gate: agent`: chain the dispatch (pipeline effect)
4. If the agent fails: mark task as blocked, escalate to human (no auto-retry in v1)
5. Log all auto-advances to `task_stage_log` with `actor_type: workflow`

**Acceptance Criteria:**
- [ ] Task auto-advances through consecutive agent columns without manual intervention
- [ ] Pipeline stops at human-gated columns (waits for manual move)
- [ ] Agent failure blocks the task, does not crash the pipeline

**Validation:**
```bash
# Full pipeline test: task moves through build→review→qa automatically
# Stops at ship (human-gated)
```

**depends-on:** Group 5

---

## QA Criteria

- [ ] Create a board from template, verify columns match
- [ ] Create task on board, move through all columns manually
- [ ] Set up an agent-gated column, verify auto-dispatch works
- [ ] Verify auto-advance chains through multiple agent columns
- [ ] Verify pipeline stops at human-gated column
- [ ] Verify existing tasks still work after migration (no data loss)
- [ ] Verify `genie type` commands still work with deprecation warning
- [ ] Load test: 50 tasks on a board, move 10 simultaneously

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| PG NOTIFY missed under heavy load | Medium | NOTIFY is best-effort in PG. Add a periodic reconciliation sweep (every 60s) that catches missed transitions. |
| Migration breaks existing tasks | High | Migration is additive (new table + FK). Old `type_id` preserved as fallback. Test on copy of prod DB first. |
| Workflow listener crashes mid-dispatch | Medium | v1 escalates to human on failure. v2 adds retry with backoff. |
| Board column schema too rigid | Low | JSONB columns are flexible by design. New fields can be added without migration. |
| `genie type` deprecation breaks scripts | Medium | Alias `genie type` → `genie board` with deprecation warning for 2 releases before removal. |

## Files to Create/Modify

```
# New
src/db/migrations/007_boards.sql          — boards + board_templates tables, task_types migration
src/term-commands/board.ts                 — genie board CLI commands
src/lib/board-service.ts                   — board CRUD, template management
src/lib/workflow-listener.ts               — PG LISTEN runtime for auto-dispatch
src/lib/workflow-listener.test.ts          — tests

# Modify
src/lib/task-service.ts                    — board_id FK, board-scoped queries, stage validation
src/lib/task-service.test.ts               — update tests for board model
src/term-commands/task.ts                  — --board flag on create/list
src/term-commands/type.ts                  — deprecation aliases to board commands
src/lib/scheduler-daemon.ts                — integrate workflow listener
src/genie.ts                               — register board commands
```
