# Wish: Genie Final Polish — Everything From the Journey

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `genie-final-polish` |
| **Date** | 2026-03-25 |
| **Source** | Full-day power session QA findings, #800, #799, board system QA |

## Summary

Fix every remaining issue found during today's 10-hour genie session. Migration idempotency (boards re-created on every upgrade), board name lookup (#799 still broken by name), board export flag, by-column view showing done tasks, stale column_ids after board consolidation, OTel test port conflicts, and the pre-existing lint error that blocks pushes. Ship a version where `genie update --next` just works, `genie board` just works, and the test suite is 100% green.

## Scope

### IN
1. **008_boards migration idempotency** — migration must NOT re-create boards/templates if they already exist. Use `CREATE TABLE IF NOT EXISTS`, `INSERT ... ON CONFLICT DO NOTHING` for seeds.
2. **Board name lookup (#799)** — `genie board show Dev Pipeline` must work by name. The CLI is using variadic args but the service lookup still fails on multi-word names.
3. **Board export flag** — `genie board export Dev Pipeline` should support `--json` output flag (currently `error: unknown option '--json'`).
4. **By-column view: hide done tasks** — `genie task list --board X --by-column` should not show `status=done` tasks by default. Add `--include-done` flag to show them.
5. **Column ID reconciliation** — when tasks move between boards (board consolidation), their `column_id` can become orphaned. Add a `genie board reconcile` command that fixes stale column_ids by matching `task.stage` → board column name.
6. **OTel test port conflict** — `otel-receiver.test.ts` fails when pgserve is running on 19643. Use dynamic port or mock.
7. **Lint error in msg.ts** — pre-existing complexity warning (score 40, max 15) that blocks `bun run check` and therefore blocks push hooks. Refactor the function.

### OUT
- Workflow engine runtime — separate wish
- Dream session cleanup automation — separate wish
- `genie board use` improvements — already shipped
- New features — this is fixes only

## Decisions

| Decision | Rationale |
|----------|-----------|
| **`IF NOT EXISTS` on migration** | Idempotent migrations are a genie principle. 008 should follow the same pattern as 006 (which already uses IF NOT EXISTS). |
| **Board name lookup: trim + exact match** | The variadic args pattern already joins words. The service just needs to pass the full string to the query. Simple fix. |
| **Hide done by default in kanban** | A kanban board shows active work. Done tasks clutter the view. `--include-done` is opt-in. |
| **`genie board reconcile`** | Manual escape hatch for the column_id orphan problem. Better than silent auto-fix that might assign wrong columns. |
| **Refactor msg.ts, not suppress** | The complexity is real (40 vs max 15). Extract helper functions. Fixes the lint AND improves maintainability. |

## Success Criteria

- [ ] `genie update --next` then `genie db migrate` produces zero errors (no duplicate boards)
- [ ] `genie board show Dev Pipeline` works by name
- [ ] `genie board export Dev Pipeline --json` outputs valid JSON
- [ ] `genie task list --board "Dev Pipeline" --by-column` shows only non-done tasks
- [ ] `genie task list --board "Dev Pipeline" --by-column --include-done` shows all tasks
- [ ] `genie board reconcile "Dev Pipeline"` fixes orphaned column_ids
- [ ] `bun test` — 0 failures (including OTel tests)
- [ ] `bun run check` — exits 0 (lint clean, including msg.ts)
- [ ] `git push` works without `--no-verify`

## Execution Strategy

### Wave 1 (parallel — all independent)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Migration idempotency — IF NOT EXISTS + ON CONFLICT for 008_boards |
| 2 | engineer | Board name lookup + export flag fixes |
| 3 | engineer | By-column done filter + board reconcile command |
| 4 | engineer | OTel test port fix + msg.ts refactor |

### Wave 2
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review all 4 groups |
| qa | qa | Full QA: update cycle, board CLI, task views, test suite |

## Execution Groups

### Group 1: Migration Idempotency
**Goal:** `genie db migrate` never fails on re-run, never duplicates boards.

**Deliverables:**
1. Update `008_boards.sql`: `CREATE TABLE IF NOT EXISTS boards`, `CREATE TABLE IF NOT EXISTS board_templates`
2. Template seed: `INSERT INTO board_templates ... ON CONFLICT (id) DO NOTHING` (or use name as conflict target)
3. Task type → board migration: `INSERT INTO boards ... ON CONFLICT DO NOTHING`
4. Remove stale `pgserve.migrated` file logic — migration runner already uses `_genie_migrations` table (from dx-polish Group 4)

**Acceptance Criteria:**
- [ ] `genie db migrate` on fresh DB creates everything
- [ ] `genie db migrate` on existing DB with boards does NOT duplicate
- [ ] Running migrate 3 times in a row produces identical state

**Validation:**
```bash
genie db migrate && genie db migrate && genie db migrate
genie board list  # should show same count each time
genie db query "SELECT count(*) FROM board_templates"  # should be 5
```

**depends-on:** none

---

### Group 2: Board Name Lookup + Export
**Goal:** Board CLI commands work with multi-word names and export outputs JSON.

**Deliverables:**
1. Fix `getBoard()` in `board-service.ts` — ensure the full name string (including spaces) reaches the SQL query. Likely issue: commander splits variadic args, service receives array instead of string.
2. Test: `genie board show Dev Pipeline`, `genie board columns Dev Pipeline`, `genie board edit Dev Pipeline`, `genie board delete Dev Pipeline` (with confirmation)
3. Fix `genie board export` — add `--json` flag to the commander option. Currently missing from option registration.
4. Export outputs full board config: name, project, columns (with all fields), config

**Acceptance Criteria:**
- [ ] `genie board show Dev Pipeline` works
- [ ] `genie board columns Dev Pipeline` works
- [ ] `genie board export Dev Pipeline --json` outputs valid JSON to stdout
- [ ] `genie board export Dev Pipeline --json --output backup.json` writes to file

**Validation:**
```bash
genie board show Dev Pipeline
genie board export Dev Pipeline --json | jq '.name'
```

**depends-on:** none

---

### Group 3: Kanban View + Reconcile Command
**Goal:** By-column view hides done tasks, reconcile command fixes orphaned column_ids.

**Deliverables:**
1. `genie task list --board X --by-column` filters out `status=done` tasks by default
2. Add `--include-done` flag to show all tasks including done
3. New command: `genie board reconcile <name>` — for each task on the board whose `column_id` doesn't match any of the board's column IDs, resolve by matching `task.stage` → board column `name`, update `column_id`
4. Reconcile reports: "Fixed N tasks, M still orphaned (stage doesn't match any column)"

**Acceptance Criteria:**
- [ ] Kanban view hides done tasks by default
- [ ] `--include-done` shows them
- [ ] `genie board reconcile "Dev Pipeline"` fixes orphaned column_ids
- [ ] Reconcile is idempotent — running twice produces same result

**Validation:**
```bash
genie task list --board "Dev Pipeline" --by-column  # no done tasks
genie task list --board "Dev Pipeline" --by-column --include-done  # shows done
genie board reconcile "Dev Pipeline"  # reports fixes
```

**depends-on:** none

---

### Group 4: Test Suite + Lint Cleanup
**Goal:** `bun run check` exits 0. Zero test failures. Push hooks pass.

**Deliverables:**
1. Fix `otel-receiver.test.ts` — use dynamic port (`0` for OS assignment) or mock the server. Must not conflict with running pgserve.
2. Refactor `msg.ts:374` — the `action` handler has complexity 40 (max 15). Extract into helper functions: `parseMessageArgs()`, `resolveRecipient()`, `formatDeliveryResult()`, etc. Keep behavior identical.
3. Verify: `bun run typecheck && bun run lint && bun run dead-code && bun test` all pass

**Acceptance Criteria:**
- [ ] `bun test` — 0 failures
- [ ] `bun run lint` — 0 errors (warnings OK for pre-existing knip hints)
- [ ] `bun run check` — exits 0
- [ ] `git push origin dev` works without `--no-verify`

**Validation:**
```bash
bun run check  # must exit 0
```

**depends-on:** none

---

## QA Criteria

- [ ] Fresh install simulation: `genie db migrate` on empty DB, then `genie board list` shows 0 boards + 5 templates
- [ ] Upgrade simulation: `genie db migrate` on existing DB with boards — no duplicates
- [ ] Full board CLI walkthrough: create, show, columns, edit, export, delete
- [ ] Kanban view: by-column with and without done tasks
- [ ] Reconcile: intentionally orphan a task's column_id, run reconcile, verify fix
- [ ] Test suite: `bun run check` green
- [ ] Push hook: `git push` succeeds

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| msg.ts refactor changes behavior | Medium | Extract functions only, keep logic identical. Test coverage exists. |
| OTel port fix breaks real OTel usage | Low | Dynamic port is standard practice. Real usage binds to configured port, not test port. |
| Migration ON CONFLICT needs unique constraint | Medium | Verify board_templates has unique constraint on name. Add if missing. |

## Files to Create/Modify

```
# Group 1
src/db/migrations/008_boards.sql       — IF NOT EXISTS, ON CONFLICT

# Group 2
src/lib/board-service.ts               — name lookup fix
src/term-commands/board.ts             — export --json flag, name arg handling

# Group 3
src/term-commands/task.ts              — --include-done flag on by-column
src/term-commands/board.ts             — reconcile command
src/lib/board-service.ts               — reconcileBoard() function

# Group 4
src/lib/otel-receiver.test.ts         — dynamic port
src/term-commands/msg.ts               — refactor complexity
```
