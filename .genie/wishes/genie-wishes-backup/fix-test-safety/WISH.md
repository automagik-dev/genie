# Wish: Fix Test Safety — No Real Spawns, No Env Pollution

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `fix-test-safety` |
| **Date** | 2026-03-25 |

## Summary

Two test defects caused real damage: `team.test.ts` spawned live Claude sessions inside tmux (burning tokens for hours as orphan processes), and `wish-state.test.ts` fails because `/tmp/.git` exists on this server, polluting `resolveRepoPath`. This wish fixes both so the full test suite passes clean and tests never escape their sandbox.

## Scope

### IN
- Add `--no-spawn` flag to `genie team create` (skips leader spawn, keeps wish copy + team setup)
- Update `team.test.ts` wish-copy tests to use `--no-spawn`
- Fix `resolveRepoPath()` to use `GIT_CEILING_DIRECTORIES` so it doesn't walk up to `/tmp/.git`
- Fix `wish-state.test.ts` fallback test to create its temp dir outside any git ancestor
- Ensure `bun test` passes 1226/1226 with 0 failures

### OUT
- Refactoring the spawn pipeline itself (agents.ts, provider-adapters.ts)
- Fixing the biome cognitive-complexity warning on msg.ts (separate concern)
- Cleaning up knip configuration hints (housekeeping, not safety)
- Removing the stale `/tmp/.git` repo (environment issue, not code issue)

## Decisions

| Decision | Rationale |
|----------|-----------|
| `--no-spawn` CLI flag over env var | Explicit, self-documenting, visible in `--help`. Commander `--no-spawn` sets `spawn: false` by default. |
| `GIT_CEILING_DIRECTORIES` over clearing `GIT_DIR` | Standard git mechanism. Prevents upward traversal without breaking legitimate `GIT_DIR` usage. |
| Test creates dir under unique path, not `/tmp` | `/tmp/.git` is a real pollution vector on shared servers. Tests must not depend on `/tmp` being git-free. |

## Success Criteria

- [ ] `bun test` passes all 1226 tests (0 failures)
- [ ] `bun test src/term-commands/team.test.ts` completes without spawning any Claude process
- [ ] `bun test src/lib/wish-state.test.ts` passes, including the `resolveRepoPath` fallback test
- [ ] `git push` succeeds (pre-push hook passes)
- [ ] PR created targeting `dev`

## Execution Strategy

### Wave 1 (sequential — Group 2 depends on Group 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix `team.ts` + `team.test.ts` — add `--no-spawn`, update tests |
| 2 | engineer | Fix `wish-state.ts` + `wish-state.test.ts` — env-safe `resolveRepoPath` |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Run full suite, verify 0 failures, push branch, create PR |

## Execution Groups

### Group 1: Team Test No-Spawn

**Goal:** Prevent `team.test.ts` from ever spawning real Claude sessions.

**Deliverables:**
1. `team.ts`: Add `--no-spawn` option to `team create` command. When `options.spawn === false`, skip `spawnLeaderWithWish()`. Wish copy + team setup still runs.
2. `team.test.ts`: Both wish-copy tests (`feat/autocopy-test`, `feat/inrepo-test`) use `--no-spawn`. Remove try/catch anti-pattern.

**Acceptance Criteria:**
- [ ] `bun test src/term-commands/team.test.ts` — 14 pass, 0 fail
- [ ] No `claude` process with `autocopy` or `inrepo` in its args after test run

**Validation:**
```bash
bun test src/term-commands/team.test.ts && ! ps aux | grep -q "[a]utocopy-test"
```

**depends-on:** none

---

### Group 2: ResolveRepoPath Env Safety

**Goal:** Make `resolveRepoPath()` immune to stale `.git` dirs in ancestor directories like `/tmp/.git`.

**Deliverables:**
1. `wish-state.ts`: In `resolveRepoPath()`, pass `GIT_CEILING_DIRECTORIES` set to the parent of cwd in the `execSync` env. This prevents git from walking above the current directory when no explicit cwd is given.
2. `wish-state.test.ts`: Update the "falls back to cwd when not in a git repo" test to create its temp dir in a location guaranteed to have no `.git` ancestor (e.g. create a nested dir and set `GIT_CEILING_DIRECTORIES`).

**Acceptance Criteria:**
- [ ] `bun test src/lib/wish-state.test.ts` — 62 pass, 0 fail
- [ ] `resolveRepoPath()` returns cwd when called from a non-git directory, even if `/tmp/.git` exists

**Validation:**
```bash
bun test src/lib/wish-state.test.ts
```

**depends-on:** none

---

### Group 3: Green Suite + Ship

**Goal:** Full test suite green, branch pushed, PR created.

**Deliverables:**
1. Run `bun test` — verify 1226/1226 pass
2. Run `bun run typecheck && bun run lint` — verify clean
3. Commit all changes on `fix/team-test-no-spawn` branch
4. Push branch and create PR targeting `dev`

**Acceptance Criteria:**
- [ ] `bun test` — 0 failures
- [ ] `git push` succeeds
- [ ] PR exists on GitHub targeting `dev`

**Validation:**
```bash
bun run typecheck && bun run lint && bun test && git push
```

**depends-on:** Group 1, Group 2

---

## QA Criteria

- [ ] `bun test` passes all tests with 0 failures
- [ ] Running `team.test.ts` in tmux does not spawn any orphan claude processes
- [ ] `resolveRepoPath()` correctly returns cwd in non-git directories regardless of `/tmp/.git`
- [ ] Existing `genie team create --wish` behavior (WITH spawn) is unchanged when `--no-spawn` is not passed

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `/tmp/.git` could be recreated by other processes | Low | Fix is in the code (`GIT_CEILING_DIRECTORIES`), not dependent on env cleanup |
| Other tests may also spawn real processes | Medium | Grep for `handleWorkerSpawn` in test files to audit |
| Worktree copies of old test code still exist | Low | They're frozen; new publishes will include the fix |

---

## Files to Create/Modify

```
src/term-commands/team.ts          # Add --no-spawn flag + guard
src/term-commands/team.test.ts     # Use --no-spawn in wish tests
src/lib/wish-state.ts              # Add GIT_CEILING_DIRECTORIES to resolveRepoPath
src/lib/wish-state.test.ts         # Fix fallback test for polluted /tmp
```
