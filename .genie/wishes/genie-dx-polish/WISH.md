# Wish: Genie DX Polish — Fix the Daily-Driver Bugs

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `genie-dx-polish` |
| **Date** | 2026-03-25 |
| **Source** | [#800](https://github.com/automagik-dev/genie/issues/800) — 10 findings from daily-sync power session |

## Summary

Fix the 5 highest-friction bugs that block daily genie operations at scale. These aren't features — they're broken fundamentals. Every PM operating genie hits these within minutes. Verified against v4.260325.25: 2 were already fixed (#P1.3 db query quotes, #P1.5 project filter), 5 remain.

## Scope

### IN
1. **#795 — Task ID aliasing**: `genie task move/done/block/unblock/comment` accept `project#seq` format, not just UUID
2. **#799 — Board name spaces**: `genie board show/columns/edit/delete` resolve names with spaces
3. **Dir registry CWD**: `genie spawn <name>` uses the dir entry's `repo` as default CWD
4. **Dir ls display**: `genie dir ls` shows dir, repo, model, roles from PG (not blank)
5. **Migration marker**: `genie db migrate` checks actual applied migrations, not version marker

### OUT
- Dream session cleanup (#9 in #800) — separate wish, needs workflow engine
- Agent template pruning (#4 in #800) — nice to have, not blocking
- `--prompt` on spawn (#6 in #800) — needs Claude CLI upstream support
- SendMessage disambiguation (#7 in #800) — team architecture change
- `genie board use` context (#10 in #800) — already shipped in v25

## Decisions

| Decision | Rationale |
|----------|-----------|
| **`project#seq` resolves via DB lookup** | `SELECT id FROM tasks WHERE project_id = (SELECT id FROM projects WHERE name = $1) AND seq = $2`. Simple, no new index needed — `seq` is already indexed per-project. |
| **Board name lookup uses ILIKE** | `WHERE name ILIKE $1` handles spaces and case. Also accept board ID as fallback. |
| **Dir spawn CWD fallback chain** | `--cwd` flag > dir entry `repo` > dir entry `dir` > current working directory. Explicit always wins. |
| **Dir ls reads from PG** | The JSON file is legacy. `genie dir add` already writes to PG. `ls` should read from the same place. |
| **Migration marker checks `_genie_migrations` table** | Instead of comparing version strings, query `SELECT name FROM _genie_migrations` and diff against migration files. Only run what's actually missing. |

## Success Criteria

- [ ] `genie task done wk-resilience#1 --comment "shipped"` works (resolves project#seq → UUID)
- [ ] `genie task move genie#1 --to build` works
- [ ] `genie board show "Dev Pipeline"` works (name with spaces)
- [ ] `genie board columns "Dev Pipeline"` works
- [ ] `genie spawn omni-pm` uses the registered repo path as CWD (without `--cwd`)
- [ ] `genie dir ls` shows dir, repo, model, roles for all entries
- [ ] `genie db migrate` on a DB where 008_boards already exists does NOT error

## Execution Strategy

### Wave 1 (parallel — all independent)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Task ID aliasing — `resolveTaskId()` accepts `project#seq` |
| 2 | engineer | Board name spaces — fix lookup in `board-service.ts` |
| 3 | engineer | Dir registry fixes — spawn CWD + ls display |
| 4 | engineer | Migration marker — check `_genie_migrations` table instead of version file |

### Wave 2
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review all 4 groups |
| qa | qa | End-to-end test all fixes |

## Execution Groups

### Group 1: Task ID Aliasing (#795)
**Goal:** `genie task` commands accept `project#seq` format everywhere.

**Deliverables:**
1. Update `resolveTaskId()` in `task-service.ts` to parse `project#seq` pattern
2. Query: `SELECT id FROM tasks WHERE project_id = (SELECT id FROM projects WHERE name = $project) AND seq = $seq`
3. All task mutation commands use `resolveTaskId()`: move, done, block, unblock, comment, assign, tag, checkout, release

**Acceptance Criteria:**
- [ ] `genie task done genie#1` resolves to the correct task UUID
- [ ] `genie task move khal-os#17 --to brainstorm` works
- [ ] Invalid `project#seq` (nonexistent project or seq) gives clear error
- [ ] UUID format still works (no regression)

**Validation:**
```bash
genie task list --project genie | head -3  # note a project#seq
genie task show genie#1                     # should resolve
```

**depends-on:** none

---

### Group 2: Board Name Spaces (#799)
**Goal:** Board CLI commands find boards by name regardless of spaces.

**Deliverables:**
1. Fix `getBoard()` / `getBoardByName()` in `board-service.ts` — use parameterized query with exact match, ensure the name argument is passed as-is (not split on spaces)
2. All board commands that accept `<name>`: show, columns, edit, delete, use, export
3. Also accept board ID as alternative: `genie board show board-21a3c828`

**Acceptance Criteria:**
- [ ] `genie board show "Dev Pipeline"` works
- [ ] `genie board columns "Dev Pipeline"` works
- [ ] `genie board show board-21a3c828` works (ID fallback)
- [ ] `genie board show Dev` still works (no-space name)

**Validation:**
```bash
genie board show "Dev Pipeline"
genie board columns "Dev Pipeline"
```

**depends-on:** none

---

### Group 3: Dir Registry Fixes
**Goal:** `genie spawn` respects dir entry CWD, `genie dir ls` shows all fields.

**Deliverables:**
1. In spawn command (`agents.ts`): when resolving a dir entry, use `entry.repo || entry.dir` as default CWD if `--cwd` not provided
2. In `genie dir ls`: read all fields from PG (or JSON, whichever is authoritative) — show dir, repo, model, roles in the table
3. Ensure `genie dir add` and `genie dir ls` read/write the same store

**Acceptance Criteria:**
- [ ] `genie spawn omni-pm` (without `--cwd`) spawns in the registered repo path
- [ ] `genie dir ls` shows dir, repo, model columns populated
- [ ] `genie dir add X --dir /path --repo /repo --model opus` then `genie dir ls` shows all fields

**Validation:**
```bash
genie dir ls  # should show dir, repo, model columns
genie dir add test-agent --dir /tmp --repo /tmp --model sonnet --global
genie dir ls  # verify test-agent shows all fields
genie dir rm test-agent --global
```

**depends-on:** none

---

### Group 4: Migration Marker Fix
**Goal:** `genie db migrate` checks actual applied migrations, not version file.

**Deliverables:**
1. In `db.ts` / migration runner: replace version-marker check with `SELECT name FROM _genie_migrations`
2. Diff applied names against migration file names on disk
3. Run only migrations whose name is NOT in `_genie_migrations`
4. Remove or ignore `pgserve.migrated` version file (keep for backward compat but don't use for skip logic)

**Acceptance Criteria:**
- [ ] `genie db migrate` on a DB with 008_boards already applied does NOT error
- [ ] `genie db migrate` on a DB missing 008_boards DOES apply it
- [ ] `genie db migrate` is idempotent — running twice produces no errors

**Validation:**
```bash
genie db migrate  # should say "All migrations are up to date" without errors
genie db query "SELECT count(*) FROM _genie_migrations"  # should match file count
```

**depends-on:** none

---

## QA Criteria

- [ ] All 4 fixes verified end-to-end
- [ ] No regressions in existing task/board/dir/migrate commands
- [ ] `bun test` passes (all existing tests + new tests for each fix)
- [ ] Real-world test: run `/daily-sync` audit using `project#seq` format for task operations

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `project#seq` ambiguous if project name contains `#` | Low | Project names don't contain `#`. Validate on project creation. |
| Board name lookup change breaks existing scripts | Low | Adding ILIKE is additive. Exact match still works. |
| Dir store migration (JSON→PG) leaves orphan data | Low | `dir add` already writes both. `ls` just needs to read the right one. |
| Migration runner change breaks fresh installs | Medium | Test on empty DB. The `_genie_migrations` table is created by the runner itself. |

## Files to Create/Modify

```
# Group 1
src/lib/task-service.ts          — resolveTaskId() accepts project#seq

# Group 2
src/lib/board-service.ts         — getBoardByName() handles spaces
src/term-commands/board.ts       — name argument passing

# Group 3
src/term-commands/agents.ts      — spawn uses dir entry repo as CWD
src/term-commands/dir.ts         — ls reads all fields from storage

# Group 4
src/lib/db.ts                    — migration runner checks _genie_migrations table
```
