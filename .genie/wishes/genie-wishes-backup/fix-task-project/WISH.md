# Wish: Fix --project flag on task create/list

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `fix-task-project` |
| **Date** | 2026-03-24 |
| **Issues** | #725 |

## Summary

`genie task create --project <name>` creates the task but it doesn't appear in `genie task list --project <name>`. The code path exists: `handleTaskCreate` resolves projectId and passes it to `createTask()`, and `listTasks` filters by `project_id`. The bug is in the data flow — either the project ID isn't stored correctly in the tasks row, the project name lookup returns a different ID on list vs create, or the auto-created project doesn't persist properly.

## Scope

### IN
- Trace and fix the data flow: task create `--project` → INSERT → task list `--project` → SELECT
- Verify `ensureProject()` returns consistent IDs across create and list operations
- Verify auto-created projects persist and are findable by name
- Add integration test: create with `--project`, list with `--project`, verify task appears
- Fix `getProjectByName()` if name matching is case-sensitive or whitespace-sensitive

### OUT
- No changes to project CRUD API
- No changes to task list display format
- No new CLI flags
- No changes to PG schema/migrations

## Decisions

| Decision | Rationale |
|----------|-----------|
| Trace the exact data flow first | Code looks correct structurally — bug is in runtime behavior, not architecture |
| Add integration test | This is a cross-function bug — unit tests pass but the pipeline doesn't |
| Check ensureProject consistency | If create uses `ensureProject(repo)` and list uses `getProjectByName(name)`, they may return different projects |

## Success Criteria

- [ ] `genie task create "test" --project myboard` creates task associated with "myboard"
- [ ] `genie task list --project myboard` shows the created task
- [ ] Auto-created projects are findable by name in subsequent commands
- [ ] `bun run check` passes

## Execution Strategy

### Wave 1
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Trace and fix project association + add integration test |

## Execution Groups

### Group 1: Fix task-project association

**Goal:** Tasks created with `--project` appear in `--project` filtered lists.

**Deliverables:**
1. Trace the bug:
   - In `src/term-commands/task.ts` `handleTaskCreate`: log the `projectId` being passed to `createTask()`
   - In `src/lib/task-service.ts` `createTask()`: verify `projId` is included in the INSERT statement
   - In `src/lib/task-service.ts` `listTasks()`: verify `buildScopeConditions` generates correct WHERE clause for `projectName`
   - Check if `ensureProject(repo)` (called when no explicit projectId) conflicts with explicit `projectId`
2. Fix the identified issue (likely one of):
   - `createTask()` line 492: `projectId ?? (await ensureProject(repo))` may override explicit projectId with repo-based project
   - `getProjectByName()` may be case-sensitive when `createProject()` normalizes differently
   - The `project_id` column may not be in the INSERT column list at the correct position
3. Add integration test in `src/lib/task-service.test.ts`:
   - Create project by name
   - Create task with that project
   - List tasks filtering by project name
   - Assert task appears in filtered list

**Acceptance Criteria:**
- [ ] Integration test passes: create + list round-trip works
- [ ] `project_id` correctly stored in tasks row
- [ ] `projectName` filter in `listTasks` matches stored project

**Validation:**
```bash
bun test src/lib/task-service.test.ts && bun test src/term-commands/task.ts && bun run typecheck
```

**depends-on:** none

---

## Files to Create/Modify

```
src/lib/task-service.ts       — fix project association in createTask
src/lib/task-service.test.ts  — integration test for project round-trip
src/term-commands/task.ts      — verify handleTaskCreate passes correct projectId
```
