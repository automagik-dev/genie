# Wish: Resolve Dev Branch Desync After Worker→Agent Rename

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `resolve-dev-desync` |
| **Date** | 2026-03-06 |

## Summary

Local dev branch has 9 uncommitted files from cascading dead-code cleanup (biome warning elimination round 2). Meanwhile, origin/dev advanced 8 commits including a major `Worker→Agent` type rename and `worker-registry.ts→agent-registry.ts` file rename. Need to commit local changes, rebase onto origin/dev, resolve conflicts, re-apply dead-code removals to renamed files, and verify all quality gates pass.

## Scope

### IN

- Commit local dead-code cleanup changes on dev branch
- Rebase onto origin/dev (8 commits behind)
- Resolve conflict in `src/lib/beads-registry.ts` (local: dead-code removal + private heartbeat; upstream: Worker→Agent type rename)
- Re-apply `countByTask` export removal to `src/lib/agent-registry.ts` (was `worker-registry.ts`)
- Verify all cascading dead-code removals still apply after upstream changes
- Run and pass all quality gates: typecheck, lint (0 warnings), dead-code (knip), tests (489/489)

### OUT

- No new feature work — this is purely a merge/sync operation
- No additional refactoring beyond what's needed for the merge
- No changes to upstream code that isn't part of conflict resolution

## Decisions

| Decision | Rationale |
|----------|-----------|
| Commit local changes first, then rebase | Preserves our work as a distinct commit; cleaner than stash-pop |
| Rebase (not merge) | Keeps linear history on dev branch |
| Re-apply dead-code removals to renamed files | `worker-registry.ts` → `agent-registry.ts` means our `countByTask` export removal needs to target the new filename |

## Success Criteria

- [ ] Local dev branch is up-to-date with origin/dev
- [ ] All 9 local file changes are preserved (dead-code removals)
- [ ] `bun run check` exits 0 (typecheck + lint + dead-code + tests)
- [ ] `bunx biome check . --max-diagnostics=300` shows 0 warnings, 0 errors
- [ ] `bun test` passes 489/489 (or more, if upstream added tests)
- [ ] `git status` shows clean working tree
- [ ] Changes are pushed to origin/dev

## Execution Groups

### Group 1: Commit & Rebase

**Goal:** Get local dead-code cleanup committed and rebased onto origin/dev.

**Deliverables:**
1. Commit all 9 local file changes with descriptive message
2. `git pull --rebase origin dev`
3. Resolve conflicts:
   - `src/lib/beads-registry.ts`: Accept upstream Worker→Agent renames, keep local dead-code removals (delete `heartbeat` export, `listWorkers` function)
   - `src/lib/worker-registry.ts` → `src/lib/agent-registry.ts`: Apply `countByTask` export→private change to new filename

**Acceptance criteria:**
- Rebase completes without unresolved conflicts
- `git log --oneline` shows local commit on top of upstream commits

**Validation:**
```bash
git status  # clean working tree
git log --oneline -3  # local commit on top
```

### Group 2: Verify & Fix Cascading Issues

**Goal:** Ensure all quality gates pass after rebase. Upstream changes may have introduced new dead code or broken our previous fixes.

**Deliverables:**
1. Run `bun run typecheck` — fix any type errors from merge
2. Run `bunx biome check .` — fix any new warnings (upstream may have added code with warnings)
3. Run `bun run dead-code` — fix any new dead exports
4. Run `bun test` — all tests pass

**Acceptance criteria:**
- `bun run check` exits 0
- 0 biome warnings
- 0 knip findings

**Validation:**
```bash
bun run check  # exits 0
bunx biome check . --max-diagnostics=300 2>&1 | grep -E 'warning|error' || echo "Clean"
```

### Group 3: Push

**Goal:** Push resolved branch to remote.

**Deliverables:**
1. `git push origin dev`
2. Verify `git status` shows up-to-date with origin

**Acceptance criteria:**
- Push succeeds
- Branch is up-to-date with origin/dev

**Validation:**
```bash
git status  # "Your branch is up to date with 'origin/dev'"
```

## Assumptions / Risks

| Risk | Mitigation |
|------|------------|
| Upstream may have re-introduced dead code we already cleaned | Group 2 re-runs knip and fixes new findings |
| Worker→Agent rename may have broken imports we modified | Typecheck in Group 2 will catch this |
| Upstream may have added new biome warnings | Group 2 re-runs biome and fixes |
| Test count may have changed upstream | Accept whatever the new count is, as long as all pass |
