# Wish: Genie Boards — Project-Scoped Task Boards with CLI

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
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
- **Task ↔ Board assignment** — `tasks.board_id` FK replaces `tasks.type_id`
- **Board-scoped queries** — `genie task list --board Dev`
- **Templates as JSON files** — `templates/software.json`, `templates/sales.json`, etc. No PG table.
- **Column schema future-proofed** for workflow engine:
  ```typescript
  {
    name: string,
    label: string,
    gate: "human" | "agent" | "human+agent",
    action: string | null,        // skill to dispatch: /work, /review, /qa
    auto_advance: boolean,        // linear forward advance (simple case)
    transitions: Transition[],    // FUTURE: routing rules for loops/branches/parallel
    roles: string[],              // who sees/acts: ["*"], ["engineering"], ["business"]
    color: string,
    parallel: boolean,            // FUTURE: can multiple agents work this column simultaneously
    on_fail: string | null        // FUTURE: "loop:review", "escalate", "block"
  }

  // transitions field is JSONB, empty [] in v1, populated by workflow engine wish
  type Transition = {
    event: string,          // "complete", "fail", "pr_merge", "approval"
    target: string,         // column name to route to
    condition?: string,     // optional: "fix_count < 2", "qa_passed"
    action?: string,        // optional: skill to run on transition
  }
  ```
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
| **Templates as JSON files, not PG** | Simplest thing that works. `templates/software.json` is a file, `--from software` reads it. No CRUD overhead, no migration, easy to version in git. |
| **`genie board use` sets context** | Avoids `--board` flag on every task command. If project has one board, it's auto-selected. If many, user sets context once. |
| **Column `gate` field preserved as-is** | `human`, `agent`, `human+agent` — same semantics as original Mar 20 design. Workflow engine reads these. Boards just store them. |

## Success Criteria

- [ ] `genie board create "Dev" --project khal-os --from software` creates board with 7 columns
- [ ] `genie board create "Sales" --project khal-os --columns "lead,qualified,proposal,closed"` creates board with human-gated columns
- [ ] `genie board list --project khal-os` shows both boards
- [ ] `genie board columns Dev` shows pipeline: column names, gates, actions, colors
- [ ] `genie board edit Dev --column review --gate human+agent` changes a column's config
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
   - `boards` table: id, name, project_id FK, columns JSONB, description, created_at, updated_at
   - Column JSONB shape: `{name, label, gate, action, auto_advance, transitions, roles, color, parallel, on_fail}`
   - `tasks.board_id` FK (nullable for migration safety)
   - Copy `task_types` rows → `boards` (assign to projects by convention)
   - Update `tasks.board_id` from `tasks.type_id` mapping
   - Update `validate_task_stage` trigger to read from `boards.columns`
   - Index on `boards.project_id`
2. `board-service.ts` — CRUD functions: createBoard, getBoard, listBoards, updateBoard, deleteBoard, getBoardColumns
3. Update `task-service.ts` — board_id on task creation, board-scoped list queries

**Acceptance Criteria:**
- [ ] `boards` table exists with migrated data from `task_types`
- [ ] `tasks.board_id` FK populated for all tasks that had `type_id`
- [ ] Stage validation reads from `boards.columns`
- [ ] Column JSONB includes `transitions: []` and `on_fail: null` defaults
- [ ] Zero data loss — all existing tasks keep their stage

**Validation:**
```bash
genie db query "SELECT count(*) FROM boards"
genie db query "SELECT count(*) FROM tasks WHERE board_id IS NOT NULL"
bun test src/lib/task-service.test.ts
bun test src/lib/board-service.test.ts
```

**depends-on:** none

---

### Group 2: Templates
**Goal:** Provide JSON template files for common board types.

**Deliverables:**
1. `templates/software.json` — 8 stages: triage→draft→brainstorm→wish→build→review→qa→ship (from Mar 20 pipeline, with gates and actions per stage)
2. `templates/sales.json` — lead→qualified→proposal→negotiation→closed-won→closed-lost (all human-gated)
3. `templates/hiring.json` — sourcing→screening→interview→offer→hired
4. `templates/ops.json` — identified→planning→in-progress→done
5. `templates/bug.json` — triage(agent/trace)→draft(agent)→build(agent/work)→review(agent/review)→qa(agent/qa)→ship(human) — fast track, minimal human gates
6. Each template includes full column config: gate, action, auto_advance, transitions (empty), roles, color

**Acceptance Criteria:**
- [ ] 5 template files exist and are valid JSON
- [ ] `software.json` matches Mar 20 pipeline design (8 stages with correct gates per type)
- [ ] Templates include `transitions: []` field on every column (placeholder for workflow engine)

**Validation:**
```bash
ls templates/*.json | wc -l  # should be 5
cat templates/software.json | jq '.columns | length'  # should be 8
```

**depends-on:** Group 1 (needs to know column JSONB shape)

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
8. `genie board templates` — list available template files from `templates/`
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
| Template files not found at runtime | Low | Embed templates in the built bundle. Fallback: error with clear message. |
| Column JSONB schema changes before workflow engine ships | Low | JSONB is schemaless — add fields freely. `transitions: []` default means old rows work when new code reads them. |

## Files to Create/Modify

```
# New
src/db/migrations/008_boards.sql       — boards table, migration from task_types
src/lib/board-service.ts               — board CRUD
src/lib/board-service.test.ts          — tests
src/term-commands/board.ts             — genie board CLI
templates/software.json                — 8-stage dev pipeline
templates/sales.json                   — 6-stage sales pipeline
templates/hiring.json                  — 5-stage hiring pipeline
templates/ops.json                     — 4-stage ops pipeline
templates/bug.json                     — 6-stage fast-track bug pipeline

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
