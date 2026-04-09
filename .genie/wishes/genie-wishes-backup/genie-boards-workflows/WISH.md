# Wish: Genie Boards — Project-Scoped Task Boards with CLI

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `genie-boards` |
| **Date** | 2026-03-25 |
| **Design** | [DRAFT.md](/home/genie/agents/sofia/.genie/brainstorms/genie-task-boards/DRAFT.md) |
| **Next** | `genie-workflow-engine` (separate wish — transition table, loops, parallel, side-effects) |

## Summary

Replace `task_types` with project-scoped Boards. One project can have many boards with different column layouts. Full CLI management — no more SQL. The board schema is designed to support the future workflow engine: each column carries `gate`, `action`, `auto_advance`, `roles`, `color`, and a `transitions` JSONB field for routing rules. This wish ships the data model and CLI. The workflow runtime that reads these fields is a separate wish.

## Scope

### IN
- **`boards` PG table** — project-scoped, replaces `task_types`. Columns as JSONB array with workflow-ready fields.
- **Multiple boards per project** — `genie board create "Dev" --project khal-os --from software`
- **`genie board` CLI** — create, list, show, edit, delete, columns
- **Task ↔ Board + Column binding** — `tasks.board_id` FK replaces `tasks.type_id`. `tasks.column_id` (stable UUID) replaces `tasks.stage` (string). Tasks reference column IDs — immune to renames, reorders, config changes.
- **Board-scoped queries** — `genie task list --board Dev`
- **`board_templates` PG table** — fully editable blueprints stored in PG. Builtins seeded on first migration as starting points — users can rename, add/remove columns, change gates, customize everything. No "protected" templates.
- **Template CLI** — full CRUD:
  - `genie board template list` — show all templates
  - `genie board template show <name>` — detail view with columns pipeline
  - `genie board template create <name> [--from-board <board>] [--columns "a,b,c"]` — new template from scratch or snapshot from board
  - `genie board template edit <name> --column <col> [--gate X] [--action X] [--rename Y]` — edit any field
  - `genie board template rename <old> <new>` — rename template
  - `genie board template delete <name>` — delete any template (including builtins — your system, your rules)
- **Column schema future-proofed** for workflow engine:
  ```typescript
  {
    id: string,                   // STABLE column ID (uuid or slug). Tasks reference THIS, not name.
    name: string,                 // display name — freely renameable without breaking tasks
    label: string,                // short label for compact views
    gate: "human" | "agent" | "human+agent",
    action: string | null,        // skill to dispatch: /work, /review, /qa
    auto_advance: boolean,        // linear forward advance (simple case)
    transitions: Transition[],    // FUTURE: routing rules for loops/branches/parallel
    roles: string[],              // who sees/acts: ["*"], ["engineering"], ["business"]
    color: string,
    parallel: boolean,            // FUTURE: can multiple agents work this column simultaneously
    on_fail: string | null,       // FUTURE: "loop:review", "escalate", "block"
    position: number,             // column order — reorderable without breaking anything
  }

  // Tasks store column_id (stable), NOT column name. Rename columns, reorder them,
  // change gates — tasks don't care. They're attached to the column ID.

  // transitions field is JSONB, empty [] in v1, populated by workflow engine wish
  type Transition = {
    event: string,          // "complete", "fail", "pr_merge", "approval"
    target: string,         // column ID to route to (stable reference)
    condition?: string,     // optional: "fix_count < 2", "qa_passed"
    action?: string,        // optional: skill to run on transition
  }
  ```
- **Change-proof design:** Tasks store `column_id` (the stable column UUID), not the column name. Rename a column from "Build" to "Engineering"? Zero tasks break. Reorder columns? Zero tasks break. Change a gate from human to agent? Tasks stay put, only the automation behavior changes. Delete a column? Tasks in it move to a "no column" state (orphaned, visible in `genie task list --orphaned`).
- **Migration from `task_types`** — convert existing types to boards, preserve all task data
- **Default board** — if project has exactly one board, `--board` is implicit
- **`genie board use "Dev"`** — set active board context (avoids `--board` on every command)
- **Deprecation** — `genie type` aliases to `genie board` with warning

### OUT
- **Workflow runtime** — the listener that reads `gate`/`action` and dispatches agents (separate wish: `genie-workflow-engine`)
- **Transition execution** — the `transitions` field is schema-only in this wish, no runtime
- **Fix loops, conditional routing, parallel dispatch** — workflow engine scope
- **External event triggers** (PR merge, webhook) — workflow engine scope
- **Release bundling** — future wish
- **Visual kanban UI** — KhalOS scope
- **Board permissions / RBAC** — future

## Decisions

| Decision | Rationale |
|----------|-----------|
| **Boards replace task_types** | Clean migration, no dual system. task_types was a prototype. |
| **Column schema includes `transitions`, `parallel`, `on_fail` fields NOW** | The workflow engine wish needs these. Adding them later means another migration. Schema is cheap, runtime is expensive — lay the schema now, build the runtime later. |
| **`transitions: []` empty in v1** | Fields exist but are inert. No runtime reads them. The workflow engine populates and acts on them. |
| **Templates in PG, not JSON files** | Everything else is PG — boards, tasks, projects. Templates follow the same pattern. CLI-manageable. Builtins seeded by migration, custom templates created from existing boards. |
| **`genie board use` sets context** | Avoids `--board` flag on every task command. If project has one board, it's auto-selected. If many, user sets context once. |
| **Column `gate` field preserved as-is** | `human`, `agent`, `human+agent` — same semantics as original Mar 20 design. Workflow engine reads these. Boards just store them. |

## Success Criteria

- [ ] `genie board template list` shows 5 builtin templates
- [ ] `genie board template create "My Flow" --from-board "Dev"` snapshots a board as template
- [ ] `genie board create "Dev" --project khal-os --from software` creates board with 8 columns
- [ ] `genie board create "Sales" --project khal-os --columns "lead,qualified,proposal,closed"` creates board with human-gated columns
- [ ] `genie board list --project khal-os` shows both boards
- [ ] `genie board columns Dev` shows pipeline: column names, gates, actions, colors
- [ ] `genie board edit Dev --column review --gate human+agent` changes a column's config
- [ ] `genie board export Dev --json` dumps full config
- [ ] `genie board import --json board.json --project khal-os` recreates board from export
- [ ] Every board/template edit produces an `audit_events` row (who, what, when, before/after)
- [ ] `genie events list --entity board` shows full change history
- [ ] `genie task create "Fix auth" --board Dev --project khal-os` assigns task to board
- [ ] `genie task list --board Dev` shows only Dev board tasks
- [ ] `genie board use Dev` sets context, subsequent `genie task create` uses Dev implicitly
- [ ] `task_types` migrated to `boards` — zero data loss
- [ ] All existing tasks retain their stage/column after migration
- [ ] `genie type list` works with deprecation warning
- [ ] Column JSONB includes `transitions`, `parallel`, `on_fail` fields (empty/default in v1)

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | `boards` table + migration from `task_types` + `tasks.board_id` FK |
| 2 | engineer | Template JSON files: software, sales, hiring, ops |

### Wave 2 (parallel, after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | `genie board` CLI: create, list, show, edit, delete, columns, use |
| 4 | engineer | `genie task` updates: `--board` flag, board-scoped queries, `genie type` deprecation |

### Wave 3: Review + QA
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review all groups |
| qa | qa | Create boards, assign tasks, verify migration, test all CLI commands |

## Execution Groups

### Group 1: Schema + Migration
**Goal:** Replace `task_types` with `boards`, preserve all data.

**Deliverables:**
1. Migration `008_boards.sql`:
   - `boards` table: id, name, project_id FK, columns JSONB, config JSONB DEFAULT '{}', description, created_at, updated_at
   - `config` field = board-level settings (auto-archive, digest schedule, connector config, etc.) — extensible without migrations
   - `board_templates` table: id, name, description, icon, columns JSONB, is_builtin, created_at, updated_at
   - Column JSONB shape: `{id, name, label, gate, action, auto_advance, transitions, roles, color, parallel, on_fail, position}`
   - Each column gets a stable UUID `id` — tasks reference this, not column name
   - `tasks.board_id` FK (nullable for migration safety)
   - `tasks.column_id` TEXT — replaces `tasks.stage`. Stores the stable column UUID.
   - Migrate: for each task, resolve `tasks.stage` → column UUID via its board's columns JSONB
   - Copy `task_types` rows → `boards` (assign to projects by convention)
   - Seed 5 builtin templates: software, sales, hiring, ops, bug
   - Update stage validation trigger to check `column_id` exists in board's columns JSONB
   - Index on `boards.project_id`, `tasks.column_id`, `tasks.board_id`
2. `board-service.ts` — CRUD: createBoard, getBoard, listBoards, updateBoard, deleteBoard, getBoardColumns, addColumn, removeColumn, reorderColumns, renameColumn
3. `template-service.ts` — CRUD: createTemplate, getTemplate, listTemplates, updateTemplate, deleteTemplate, snapshotFromBoard
4. Update `task-service.ts` — board_id + column_id on task creation, board-scoped list queries, move resolves column by name → column_id internally
5. **Full audit trail** — every board/template mutation writes to `audit_events`:
   - `entity_type: 'board'` or `entity_type: 'board_template'`
   - Events: `column_added`, `column_removed`, `column_renamed`, `column_reordered`, `gate_changed`, `action_changed`, `board_created`, `board_deleted`, `template_edited`, etc.
   - `details` JSONB captures before/after state: `{column: "review", field: "gate", from: "human", to: "agent"}`
   - Queryable: `genie events list --entity board --since 7d` → full change history, who did what when

**Acceptance Criteria:**
- [ ] `boards` + `board_templates` tables exist with migrated data
- [ ] `tasks.board_id` and `tasks.column_id` populated for all migrated tasks
- [ ] Validation checks `column_id` exists in board's columns JSONB
- [ ] Each column has a stable UUID `id` — tasks reference this, not name
- [ ] Renaming a column does NOT orphan any tasks
- [ ] Reordering columns does NOT orphan any tasks
- [ ] Column JSONB includes `id`, `position`, `transitions: []`, `on_fail: null` defaults
- [ ] 5 builtin templates seeded
- [ ] Zero data loss — all existing tasks keep their position

**Validation:**
```bash
genie db query "SELECT count(*) FROM boards"
genie db query "SELECT count(*) FROM tasks WHERE board_id IS NOT NULL"
bun test src/lib/task-service.test.ts
bun test src/lib/board-service.test.ts
```

**depends-on:** none

---

### Group 2: Templates (PG + CLI)
**Goal:** Seed builtin templates in PG, provide CLI for template management.

**Deliverables:**
1. `board_templates` PG table in migration `008_boards.sql`: id, name, description, icon, columns JSONB, is_builtin, created_at, updated_at
2. Seed 5 builtin templates:
   - `software` — 8 stages: triage→draft→brainstorm→wish→build→review→qa→ship (from Mar 20 pipeline, with gates and actions per stage)
   - `sales` — lead→qualified→proposal→negotiation→closed-won→closed-lost (all human-gated)
   - `hiring` — sourcing→screening→interview→offer→hired
   - `ops` — identified→planning→in-progress→done
   - `bug` — triage(agent/trace)→draft(agent)→build(agent/work)→review(agent/review)→qa(agent/qa)→ship(human)
3. Template CLI:
   - `genie board template list` — show all templates (builtin + custom)
   - `genie board template show <name>` — detail view with columns pipeline
   - `genie board template create <name> --from-board <board>` — snapshot existing board as reusable template
   - `genie board template edit <name> --column <col> [--gate X] [--action X] [--rename Y]` — edit any template column
   - `genie board template rename <old> <new>` — rename any template
   - `genie board template delete <name>` — delete any template (your system, your rules — builtins are just defaults)
4. Each template's columns include full config: gate, action, auto_advance, transitions (empty), roles, color

**Acceptance Criteria:**
- [ ] `genie board template list` shows 5 builtin templates
- [ ] `genie board template show software` shows 8-stage pipeline with correct gates
- [ ] `genie board template create "My Custom" --from-board "Dev"` works
- [ ] `genie board template edit software --column build --gate human+agent` customizes a builtin
- [ ] `genie board template rename software "Our Dev Flow"` renames it
- [ ] `genie board template delete "Our Dev Flow"` deletes it (no protection — user owns everything)
- [ ] Templates include `transitions: []` and column UUIDs (placeholder for workflow engine)
- [ ] All template columns are fully editable — name, gate, action, color, everything
- [ ] Builtins are just defaults, not sacred — user can edit/rename/delete any of them

**Validation:**
```bash
genie board template list
genie board template show software
genie db query "SELECT name FROM board_templates WHERE is_builtin = true"
```

**depends-on:** Group 1 (template table is part of the same migration)

---

### Group 3: Board CLI
**Goal:** Full CLI for board management.

**Deliverables:**
1. `genie board create <name> --project <project> [--from <template>] [--columns "a,b,c"]`
   - `--from` reads template JSON, copies columns to new board
   - `--columns` creates board with named columns, all human-gated by default
   - If neither, creates empty board
2. `genie board list [--project <project>]`
3. `genie board show <name>` — detail view with column pipeline, task counts per column
4. `genie board edit <name> --column <col> [--gate X] [--action X] [--color X]` — edit column config
5. `genie board delete <name>` — with confirmation, refuses if board has active tasks
6. `genie board columns <name>` — compact pipeline view showing flow with gates
7. `genie board use <name>` — set active board in current session (writes to `.genie/config.json`)
8. `genie board templates` — list available templates from PG
9. `genie board export <name> [--json] [--output file.json]` — dump full board config as JSON (backup/share)
10. `genie board import --json file.json --project <project>` — create board from JSON export (restore/clone)
9. `genie type` commands → alias to `genie board` with deprecation warning

**Acceptance Criteria:**
- [ ] All 9 commands work
- [ ] `--from software` creates board with 8 columns matching template
- [ ] `--columns "a,b,c"` creates 3 human-gated columns
- [ ] `edit` can change gate, action, color on individual columns
- [ ] `use` sets context so subsequent `genie task` commands skip `--board`
- [ ] `genie type list` shows deprecation warning and calls `genie board list`

**Validation:**
```bash
genie board create "Test" --project genie --from software
genie board list --project genie
genie board columns "Test"
genie board use "Test"
genie board delete "Test"
```

**depends-on:** Group 1, Group 2

---

### Group 4: Task ↔ Board Integration
**Goal:** Tasks belong to boards, queries are board-scoped.

**Deliverables:**
1. `genie task create <title> --board <board>` — assigns task to board
2. If `genie board use` was called, `--board` is implicit
3. If project has one board, it's auto-selected
4. `genie task list --board <board>` — board-scoped query
5. `genie task list --board <board> --by-column` — group tasks by column (kanban view in terminal)
6. `genie task move` validates stage against the task's board columns
7. Move validation error message shows valid columns for the board

**Acceptance Criteria:**
- [ ] Tasks assigned to board on creation
- [ ] `--board` filter works
- [ ] `--by-column` shows tasks grouped by column
- [ ] Stage validation uses the task's board
- [ ] Default board resolution works (single board auto-select, `use` context)

**Validation:**
```bash
genie board create "Dev" --project genie --from software
genie task create "Test task" --board Dev --project genie
genie task list --board Dev
genie task list --board Dev --by-column
```

**depends-on:** Group 3

---

## QA Criteria

- [ ] Create board from each template (5), verify column counts and configs
- [ ] Create task on board, move through all columns manually
- [ ] Verify column JSONB includes workflow-ready fields (`transitions`, `parallel`, `on_fail`)
- [ ] Verify existing tasks work after migration — no data loss, stage preserved
- [ ] Verify `genie type` deprecation warning works
- [ ] Verify `genie board use` context persists across commands
- [ ] Verify `--by-column` terminal kanban view

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Migration breaks existing tasks | High | Additive migration. `board_id` nullable. Old `type_id` preserved. Rollback = drop `board_id` column. |
| `task_types` removal breaks plugins | Medium | Deprecation alias (`genie type` → `genie board`) for 2 releases. `task_types` table kept read-only. |
| User deletes all templates | Low | `genie db migrate` can re-seed builtins on demand. Or user creates new ones from boards. |
| Column deleted with tasks in it | Medium | Tasks become orphaned (column_id points to nothing). `genie task list --orphaned` surfaces them. User moves them to another column. |
| Column JSONB schema changes before workflow engine ships | Low | JSONB is schemaless — add fields freely. `transitions: []` default means old rows work when new code reads them. |

## Files to Create/Modify

```
# New
src/db/migrations/008_boards.sql       — boards table, migration from task_types
src/lib/board-service.ts               — board CRUD
src/lib/board-service.test.ts          — tests
src/term-commands/board.ts             — genie board CLI
src/lib/template-service.ts            — template CRUD + builtin seed logic
src/lib/template-service.test.ts       — tests

# Modify
src/lib/task-service.ts                — board_id FK, board-scoped queries
src/lib/task-service.test.ts           — update tests
src/term-commands/task.ts              — --board flag, --by-column view
src/term-commands/type.ts              — deprecation aliases
src/genie.ts                           — register board commands
```

---

## Relationship to Workflow Engine

This wish lays the schema. The next wish (`genie-workflow-engine`) builds the runtime.

| This wish (boards) | Next wish (workflow engine) |
|---------------------|---------------------------|
| `gate` field stored on columns | Runtime reads `gate`, dispatches agent or waits for human |
| `action` field stored | Runtime invokes the skill when task enters column |
| `auto_advance` stored | Runtime moves task forward on completion |
| `transitions: []` empty | Runtime populates: fix loops, conditional routing, parallel paths |
| `on_fail: null` | Runtime reads: "loop:review", "escalate", "block" |
| `parallel: false` | Runtime reads: spawn N agents simultaneously on same column |
| Board exists as data | Board becomes a live pipeline |

The board is the blueprint. The workflow engine is the construction crew that reads the blueprint and builds.
