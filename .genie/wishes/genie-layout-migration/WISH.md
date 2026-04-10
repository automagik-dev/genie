# Wish: Genie Layout Migration

| Field | Value |
|-------|-------|
| **Status** | SHIPPED (verified 2026-04-08) |
| **Slug** | `genie-layout-migration` |
| **Date** | 2026-04-07 |
| **Design** | [DESIGN.md](../../brainstorms/genie-layout-migration/DESIGN.md) |

## Summary

Add an opt-in `genie migrate` command that converts symlinked agent directories (created by `genie init` discovery) into physical directories under the canonical `agents/` layout. Includes dry-run, git-aware moves, internal symlink fixup, journal-based rollback, and automatic PG re-sync. Also fixes `discovery.ts` to create relative symlinks for portability.

## Scope

### IN
- `genie migrate` CLI command with `--dry-run`, `--force`, `--rollback`, `--no-git` flags
- Migration engine: symlink → physical directory conversion
- Git-aware moves (`git mv` where possible, `cp -r` + `rm` fallback)
- Internal symlink recalculation (adjust relative targets for new depth)
- Journal file (`.genie/migration-journal.json`) for rollback support
- Automatic `syncAgentDirectory()` after successful migration
- Fix `discovery.ts` to create relative symlinks instead of absolute
- Dirty-repo safety check (abort if source has uncommitted changes)
- Non-interactive mode: `CI=true` → dry-run by default

### OUT
- Automatic migration during `genie init` (always explicit opt-in)
- Cross-machine workspace migration
- Native Windows symlink handling (WSL only)
- Sub-agent reparenting (moving sub-agents between parents)
- Workspace root relocation
- Migration of non-symlinked agents (already physical = nothing to do)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Opt-in `genie migrate`, not automatic | Physical moves are destructive; user must choose explicitly |
| `git mv` with `cp -r` fallback | Preserves git rename detection where possible without hard-requiring git |
| Skip cross-repo agents by default | Moving agent out of separate git repo could break that project; `--force` overrides |
| Journal-based rollback | Independent of git state; works for non-git dirs too |
| Relative symlinks in discovery.ts | Prevents portability problems at source; 1-line fix |
| PG re-sync via existing `syncAgentDirectory()` | No custom DB migration needed; sync already handles path updates |
| Per-agent atomic execution | Partial migration is valid; one failure doesn't roll back completed moves |
| Rollback = last batch, not individual | `--rollback` reverses all agents from the most recent `genie migrate` run (one batch), not individual entries |
| CI flag precedence: explicit > implicit | Explicit flags (`--force`, `--rollback`) override CI-default dry-run. `--rollback` in CI without `--force` is valid (deterministic undo). |
| Dirty check scoped to agent dir only | `git -C <agent-dir> status --porcelain`; if agent is outside any git repo, skip check (no git to protect) |

## Success Criteria

- [ ] `genie migrate --dry-run` lists all symlinked agents with source → destination and risk flags
- [ ] `genie migrate` replaces symlinks with physical directories under `agents/<name>/`
- [ ] Git-tracked files use `git mv` for rename detection preservation
- [ ] Internal relative symlinks (e.g., `repos -> ../../repos`) are recalculated for new depth
- [ ] PG metadata self-heals via `syncAgentDirectory()` post-migration
- [ ] `genie migrate --rollback` reverses the last migration from journal file
- [ ] Cross-repo agents (separate `.git` ancestor) skipped by default with warning
- [ ] Dirty source repos abort migration with clear error message
- [ ] `discovery.ts` creates relative symlinks instead of absolute
- [ ] `CI=true` → dry-run behavior by default (no interactive prompts)
- [ ] `bun test` passes; new tests cover migration engine + CLI command

## Execution Strategy

### Wave 1 (sequential)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix discovery.ts relative symlinks + migration engine core |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | CLI command + integration (depends on Group 1) |

### Wave 3 (after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | reviewer | Review all groups |

## Execution Groups

### Group 1: Relative Symlinks + Migration Engine

**Goal:** Fix the portability root cause and build the core migration logic.

**Deliverables:**

1. **Fix `discovery.ts` relative symlinks** — Change `symlinkSync(agent.path, linkPath)` to use `relative(dirname(linkPath), agent.path)` so imported agents get portable relative symlinks instead of absolute. **Update `src/__tests__/discovery.test.ts`** test expectations: the `readlinkSync()` assertions must expect relative paths (e.g., `../../services/auth`) instead of absolute paths. Verify `agent-sync.ts` uses `realpathSync()` on the resolved dir (it does — line 77), so the symlink format change is transparent to sync.

2. **`src/lib/migrate.ts` — Migration engine** with these exports:

   **Types:**
   ```typescript
   interface MigrationPlan {
     agent: string;
     from: string;       // absolute path to real source directory
     to: string;         // absolute path to destination in agents/
     method: 'git-mv' | 'copy';
     risks: string[];    // human-readable risk descriptions
   }

   interface MigrationJournalEntry {
     agent: string;
     from: string;       // original location (source)
     to: string;         // destination in agents/
     timestamp: string;  // ISO 8601
     method: 'git-mv' | 'copy';
     batchId: string;    // UUID shared across all entries from one `genie migrate` run
   }

   interface MigrationResult {
     migrated: string[];
     skipped: string[];
     errors: Array<{ agent: string; error: string }>;
     batchId: string;
   }

   interface RollbackResult {
     rolledBack: string[];
     errors: Array<{ agent: string; error: string }>;
   }
   ```

   **Exports:**
   - `planMigration(workspaceRoot: string): MigrationPlan[]` — enumerate symlinks in `agents/`, resolve targets via `realpathSync`, detect cross-repo/dirty-repo risks, return plan. Non-symlink dirs are skipped.
   - `executeMigration(workspaceRoot: string, plan: MigrationPlan[], opts: { force?: boolean; noGit?: boolean }): MigrationResult` — execute the plan per-agent atomically:
     - Remove symlink
     - `git mv` or `cp -r` source → `agents/<name>/`
     - Scan for internal relative symlinks, recalculate targets for new directory depth
     - Append entries to journal (`.genie/migration-journal.json`) with shared `batchId`
   - `rollbackMigration(workspaceRoot: string): RollbackResult` — read journal, find most recent batch (by `batchId`), reverse all moves in that batch. If journal is empty, return empty result.

   **Helpers:**
   - `isInsideSeparateGitRepo(path: string, workspaceRoot: string): boolean` — Walk up from `path` until `.git` directory found. Resolve that git root. If it differs from the git root of `workspaceRoot`, return `true`. If no `.git` found in ancestry, return `false`.
   - `hasDirtyWorkingTree(agentDir: string): boolean` — Run `git -C <agentDir> status --porcelain`. If exit code is non-zero (not a git repo), return `false`. If output is non-empty, return `true`.
   - `recalculateInternalSymlinks(dir: string, oldBase: string, newBase: string): void` — Recursively scan `dir` for symlinks. For each **relative** symlink: resolve its target relative to `oldBase`, then recompute the relative path from `newBase`. Rewrite the symlink. **Leave absolute symlinks unchanged.** Skip broken symlinks (log warning to stderr).

3. **`src/__tests__/migrate.test.ts`** — unit tests covering:
   - `planMigration` finds symlinks, skips physical dirs
   - `executeMigration` with git-mv method (mocked)
   - `executeMigration` with copy fallback
   - Internal symlink recalculation
   - Cross-repo detection skips by default
   - Dirty repo detection aborts
   - Rollback reverses completed moves
   - Journal serialization/deserialization

**Acceptance Criteria:**
- [ ] `discovery.ts` `importAgents()` creates relative symlinks
- [ ] `planMigration()` returns correct plans for symlinked agents
- [ ] `planMigration()` returns empty array when no symlinks exist
- [ ] `executeMigration()` converts symlink → physical directory
- [ ] `executeMigration()` recalculates internal relative symlinks
- [ ] `executeMigration()` writes journal entries
- [ ] `executeMigration()` skips cross-repo agents without `--force`
- [ ] `executeMigration()` aborts on dirty source repos
- [ ] `rollbackMigration()` reverses moves from journal
- [ ] All existing discovery tests pass with relative symlink change

**Validation:**
```bash
bun test src/__tests__/migrate.test.ts src/__tests__/discovery.test.ts && bun run typecheck
```

**depends-on:** none

---

### Group 2: CLI Command + Integration

**Goal:** Wire the migration engine into a user-facing `genie migrate` command with full interactive flow.

**Deliverables:**

1. **`src/term-commands/migrate.ts`** — CLI command handler:
   - `genie migrate` — interactive: show plan, confirm, execute, re-sync, report
   - `genie migrate --dry-run` — show plan only, exit 0
   - `genie migrate --force` — skip cross-repo warnings, proceed with all agents
   - `genie migrate --no-git` — force `cp -r` method, never use `git mv`
   - `genie migrate --rollback` — reverse last migration batch from journal (all agents from the most recent `genie migrate` run, identified by shared `batchId`). Shows which agents will be rolled back, confirms with user.
   - **Flag precedence:** Explicit flags (`--dry-run`, `--force`, `--rollback`, `--no-git`) always win. In non-interactive mode (`CI=true` or `--no-interactive`), if no explicit flag is set, default to `--dry-run`. `--rollback` is valid in CI mode (deterministic undo, no prompt needed).
   - Post-migration: call `syncAgentDirectory(workspaceRoot)` to update PG
   - Post-migration: print summary table with columns: `Name | Source | Destination | Method | Status`

2. **Register command in `src/genie.ts`** — add `migrate` to the command router with description "Consolidate symlinked agents into physical directories"

3. **`src/__tests__/migrate-cli.test.ts`** — integration tests:
   - `--dry-run` outputs plan without modifying filesystem
   - `--rollback` calls rollbackMigration
   - Non-interactive defaults to dry-run
   - Command registration (appears in help)

**Acceptance Criteria:**
- [ ] `genie migrate --dry-run` prints plan table and exits 0
- [ ] `genie migrate` prompts for confirmation before executing
- [ ] `genie migrate --rollback` reverses last migration
- [ ] `genie migrate --force` migrates cross-repo agents
- [ ] `genie migrate --no-git` uses copy method exclusively
- [ ] `CI=true` triggers dry-run behavior automatically
- [ ] `syncAgentDirectory()` runs after successful migration
- [ ] Command appears in `genie --help` output

**Validation:**
```bash
bun test src/__tests__/migrate-cli.test.ts && bun run typecheck && bun run check
```

**depends-on:** Group 1

---

### Group 3: Review

**Goal:** Review all execution groups against wish criteria.

**Deliverables:**
1. Execution review of Groups 1-2 against acceptance criteria
2. Quality review: security (no path traversal), correctness (atomic moves), maintainability
3. Validation command execution and evidence capture

**Acceptance Criteria:**
- [ ] All acceptance criteria from Groups 1-2 verified with evidence
- [ ] `bun test` full suite passes
- [ ] `bun run check` (typecheck + lint + dead-code) clean
- [ ] No scope creep beyond wish boundaries

**Validation:**
```bash
bun run check && bun test
```

**depends-on:** Group 1, Group 2

---

## QA Criteria

_What must be verified on dev after merge._

- [ ] `genie migrate --dry-run` in a workspace with symlinked agents shows correct plan
- [ ] `genie migrate` in a workspace with symlinked agents physically moves them
- [ ] `genie dir ls` shows correct paths after migration (PG re-synced)
- [ ] `genie migrate --rollback` restores symlinks from journal
- [ ] Newly discovered agents via `genie init` get relative symlinks (not absolute)
- [ ] Existing tests unaffected (no regressions from discovery.ts change)

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `git mv` across repos fails (source in different repo than workspace) | HIGH | Detect via `.git` ancestor walk; fall back to copy with warning |
| Partial failure leaves mixed symlink/physical state | MEDIUM | Per-agent atomic + journal; mixed state is valid. If Agent A succeeds and Agent B fails mid-copy, B's partial copy is cleaned up (rm -rf dest, restore symlink). A stays migrated. User can re-run `genie migrate` to retry failed agents. |
| Internal symlinks point to wrong depth after move | MEDIUM | `recalculateInternalSymlinks()` scans and fixes all relative symlinks |
| User has open editor with files at old path | LOW | Warning in dry-run output; IDE reloads handle this |
| Large agent directories slow to copy | LOW | Same-filesystem moves are instant (rename); cross-fs gets progress indicator |

---

## Review Results

### Plan Review — 2026-04-07

**Verdict: SHIP** (second pass, after FIX-FIRST resolved 7 gaps)

| Checklist Item | Status |
|----------------|--------|
| Problem statement testable | ✅ |
| Scope IN concrete | ✅ |
| Scope OUT explicit | ✅ |
| Acceptance criteria testable | ✅ |
| Tasks bite-sized | ✅ |
| Dependencies tagged | ✅ |
| Validation commands exist | ✅ |

First pass: FIX-FIRST — 2 CRITICAL (test expectations, journal format), 5 MEDIUM (symlink scope, cross-repo algo, dirty check scope, CI flag precedence, rollback granularity). All 7 fixed inline. Second pass: SHIP.

---

## Files to Create/Modify

```
NEW:    src/lib/migrate.ts                    — Migration engine (plan, execute, rollback, helpers)
NEW:    src/__tests__/migrate.test.ts         — Unit tests for migration engine
NEW:    src/term-commands/migrate.ts          — CLI command handler
NEW:    src/__tests__/migrate-cli.test.ts     — CLI integration tests
MODIFY: src/lib/discovery.ts                  — Relative symlinks (1-line change)
MODIFY: src/__tests__/discovery.test.ts       — Update test expectations for relative symlinks
MODIFY: src/genie.ts                          — Register migrate command
```
