# Wish: Task Projects — Multi-Board Task Segmentation

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `task-projects` |
| **Date** | 2026-03-23 |

## Summary

Add a "project" abstraction on top of the existing PG task system so tasks can be segmented into named boards. Today `repo_path` silently scopes everything — you only see tasks for the CWD repo. This wish introduces explicit projects (named aliases for repo paths or virtual boards), cross-project listing (`--all`, `--project`), and virtual projects for non-repo contexts like WhatsApp C-level task boards.

## Use Cases

| Board | Type | Example |
|-------|------|---------|
| `genie` | repo-backed | Genie CLI tasks, auto-scoped from CWD |
| `genie-os` | repo-backed | Genie OS tasks, auto-scoped from CWD |
| `omni` | repo-backed | Omni messaging tasks |
| `khal-landing` | repo-backed | Landing page (temporary) |
| `c-level` | virtual | WhatsApp group task capture for executives |
| `ops` | virtual | Infrastructure/DevOps tasks not tied to a repo |

## Scope

### IN
- **Projects table** in PG — `id`, `name` (unique slug), `repo_path` (nullable — null = virtual), `description`, `created_at`
- **Auto-registration**: When `genie task create` runs in a repo for the first time, auto-create a project from the repo name
- **CLI: `genie project`** — `create`, `list`, `show`, `set-default`
- **CLI: `--project` flag** on `task list`, `task create`, `task show` — override CWD scoping
- **CLI: `--all` flag** on `task list` — show tasks across all projects with a project column
- **Virtual projects**: `genie project create c-level --virtual` — no repo_path, for non-code boards
- **Config: default project** — `~/.genie/config.json` → `defaultProject` for when you're outside any repo
- **Migration**: Backfill existing tasks by extracting project names from `repo_path` (basename)

### OUT
- **UI / Genie OS views** — future (Phase 2+ of the platform)
- **Per-project permissions** — future (needs WorkOS RBAC)
- **Project archival** — not needed yet
- **Cross-project task dependencies** — the `dep` command already works with task IDs; just needs ID resolution without repo scope. Defer.
- **Omni/WhatsApp integration for task capture** — separate wish (the CLI plumbing comes first)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Projects table with nullable `repo_path` | Repo-backed projects auto-scope; virtual projects (null path) work for non-code boards like C-level |
| `--project` flag, not `--repo` | Users think in project names ("genie-os"), not paths. The project table maps name→path. |
| Auto-register on first `task create` | Zero-friction. Don't make users run `genie project create` before they can use tasks. |
| `--all` shows all projects in one table | The core ask: "see everything from a single DB". Add a `PROJECT` column to the output. |
| Migration as Group 1 | Existing tasks have `repo_path` but no project. Backfill by extracting basename. Non-breaking. |
| `seq` stays per-repo (not per-project) | `#47` is repo-scoped today. Changing to project-scoped is a breaking change. Keep repo-scoped, show project prefix in `--all` mode: `genie-os#3`. |

## Success Criteria

- [ ] `genie project list` shows all registered projects
- [ ] `genie project create ops --virtual` creates a non-repo project
- [ ] `genie task list --all` shows tasks from ALL projects with a project column
- [ ] `genie task list --project genie-os` shows only genie-os tasks (from any CWD)
- [ ] `genie task create "Fix auth" --project genie-os` creates a task in genie-os project regardless of CWD
- [ ] Existing `genie task list` (no flags) still works — scoped to CWD repo as before
- [ ] `genie task create` in a repo auto-registers the project if not exists
- [ ] Virtual project tasks use `genie task create "Board meeting prep" --project c-level`
- [ ] Migration backfills existing tasks with project IDs
- [ ] `bun run check` passes

## Execution Strategy

### Wave 1 (sequential — schema + service)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Migration + projects table + task-service updates |

### Wave 2 (parallel — CLI)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | `genie project` CLI commands |
| 3 | engineer | `--project` and `--all` flags on task commands |

### Wave 3 (quality gate)
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review all groups, run validation |

## Execution Groups

### Group 1: Schema + Service Layer

**Goal:** Add projects table, update task-service to support project-based queries.

**Deliverables:**

1. New migration `003_projects.sql`:
   ```sql
   CREATE TABLE projects (
     id TEXT PRIMARY KEY DEFAULT 'proj-' || substr(gen_random_uuid()::text, 1, 8),
     name TEXT UNIQUE NOT NULL,
     repo_path TEXT,  -- NULL = virtual project
     description TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );

   ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id);
   CREATE INDEX idx_tasks_project ON tasks(project_id);
   ```

2. `src/lib/task-service.ts` updates:
   - `createProject()`, `listProjects()`, `getProjectByName()`, `getProjectByRepoPath()`
   - `ensureProject(repoPath)` — auto-register on first use, return project ID
   - Update `createTask()` to set `project_id` via `ensureProject()`
   - Update `listTasks()` to accept `projectName` and `allProjects` filters
   - Update `resolveTaskId()` to optionally skip repo scoping when `--all`

3. Backfill migration logic in `003_projects.sql`:
   - Extract distinct `repo_path` values from `tasks`
   - Create a project per unique repo_path (name = basename of path)
   - Set `project_id` on all existing tasks

**Acceptance Criteria:**
- [ ] `projects` table exists with correct schema
- [ ] `tasks.project_id` column exists with FK to projects
- [ ] Existing tasks backfilled with project IDs
- [ ] `createProject()`, `listProjects()`, `getProjectByName()` work
- [ ] `ensureProject()` auto-creates on first use
- [ ] `listTasks({ allProjects: true })` returns tasks across all projects
- [ ] `listTasks({ projectName: 'genie-os' })` scopes to that project
- [ ] `bun run check` passes

**Validation:**
```bash
bun run check && echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

### Group 2: `genie project` CLI Commands

**Goal:** Add project management commands to the CLI.

**Deliverables:**

1. `src/term-commands/project.ts`:
   - `genie project list` — table with name, repo_path (or "virtual"), task count, created date
   - `genie project create <name> [--virtual] [--repo <path>] [--description <text>]`
   - `genie project show <name>` — detail view with task stats
   - `genie project set-default <name>` — set in `~/.genie/config.json`

2. Register in `src/genie.ts`

**Acceptance Criteria:**
- [ ] `genie project list` shows registered projects
- [ ] `genie project create ops --virtual` works
- [ ] `genie project create my-repo --repo /path/to/repo` works
- [ ] `genie project show genie` shows task stats
- [ ] `genie project set-default` persists to config
- [ ] `bun run check` passes

**Validation:**
```bash
grep -q "project" src/genie.ts && bun run check && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 1

---

### Group 3: `--project` and `--all` Flags on Task Commands

**Goal:** Add cross-project flags to existing task commands.

**Deliverables:**

1. `src/term-commands/task.ts` updates:
   - `task list --all` — show all projects, add PROJECT column to output
   - `task list --project <name>` — scope to named project
   - `task create --project <name>` — create task in specific project
   - `task show --project <name> <id>` — show task from specific project (for cross-project `#seq`)
   - When `--all`, show task IDs as `project#seq` format (e.g., `genie-os#3`)

2. Update help text and option definitions

**Acceptance Criteria:**
- [ ] `genie task list --all` shows tasks from all projects with PROJECT column
- [ ] `genie task list --project genie-os` scopes correctly
- [ ] `genie task create "test" --project ops` creates in virtual project
- [ ] Default behavior unchanged — `genie task list` still scopes to CWD
- [ ] `bun run check` passes

**Validation:**
```bash
bun run check && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 1, Group 2

---

## QA Criteria

- [ ] `genie task list` in genie repo shows only genie tasks (backwards compat)
- [ ] `genie task list --all` from any directory shows tasks from all repos
- [ ] `genie task create "C-level item" --project c-level` works from any CWD
- [ ] `genie project list` shows all projects with task counts
- [ ] Existing task `#seq` references still work within their repo
- [ ] `bun run check` passes

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Migration on existing PG data | Low | Additive only — new column + table, backfill is non-destructive |
| `#seq` ambiguity across projects | Medium | `#seq` stays repo-scoped. In `--all` mode, display as `project#seq`. No breaking change. |
| Virtual projects have no `repo_path` for auto-scoping | Low | Virtual projects require explicit `--project` flag. If no flag and no repo, use `defaultProject` from config. |

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# Create
src/db/migrations/003_projects.sql       — Projects table + tasks.project_id + backfill
src/term-commands/project.ts             — Project CLI commands

# Modify
src/lib/task-service.ts                  — Project CRUD + updated task queries
src/term-commands/task.ts                — --project and --all flags
src/genie.ts                             — Register project command
src/types/genie-config.ts               — Add defaultProject to config schema
```
