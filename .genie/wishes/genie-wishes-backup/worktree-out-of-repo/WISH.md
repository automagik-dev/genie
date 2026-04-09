# Wish: Move worktrees out of repo to ~/.genie/worktrees/

**Status:** SHIPPED
**Slug:** `worktree-out-of-repo`
**Created:** 2026-03-16

---

## Summary

Worktrees currently default to `<repo>/.worktrees/` — inside the repo. This causes accidental git commits, bloated npm publishes, and confusion for non-technical users who can't clean them up. Move the default to `~/.genie/worktrees/<project-name>/` and add auto-cleanup of stale worktrees.

---

## Scope

### IN
- Change default worktree base from `<repo>/.worktrees/` to `~/.genie/worktrees/<project-name>/`
- Make `worktreeBase` config optional (undefined = new default)
- Add `pruneStaleWorktrees()` auto-cleanup on disband/reset
- Fix `.gitignore` — add `.worktrees/`, remove dead `.genie/worktrees/`
- Remove committed `.worktrees/` from git tracking
- Delete dead `worktree-manager.ts` legacy code

### OUT
- Changes to how worktrees are created by git (same `git worktree add` commands)
- Migration tool for existing worktrees (users can disband and recreate)
- Changes to team config storage location (`~/.genie/teams/` stays the same)
- Changes to Claude Code's own `.claude/worktrees/` path

---

## Decisions

- **DEC-1:** Project name derived from `basename(repoPath)` — simple, predictable, matches directory name
- **DEC-2:** Explicit `worktreeBase` config still respected — only the default changes
- **DEC-3:** Auto-prune runs on disband (not on a timer/cron) — keeps it simple, no background processes

---

## Success Criteria

- [ ] `genie team create test --repo <path> --branch dev` creates worktree at `~/.genie/worktrees/<project>/test`, NOT inside the repo
- [ ] Explicit `worktreeBase` config in `~/.genie/config.json` still overrides the default
- [ ] `genie team disband test` removes worktree and prunes stale configs
- [ ] `.worktrees/` is in `.gitignore`
- [ ] No `.worktrees/` directory tracked in git
- [ ] `bun run check` passes (typecheck + lint + test)
- [ ] Dead `worktree-manager.ts` code is removed

---

## Assumptions

- **ASM-1:** `basename(repoPath)` is unique enough for most users. Two repos with the same directory name would share a worktree base (unlikely collision, and they'd have different absolute paths anyway).

## Risks

- **RISK-1:** Existing teams have `worktreePath` pointing to old `<repo>/.worktrees/` — Mitigation: `disbandTeam()` already uses the absolute path from config, so existing teams will clean up correctly regardless of the default change.

---

## Execution Groups

### Group 1: Move default path and update config

**Goal:** Change worktree default to `~/.genie/worktrees/<project>/` and make config optional.

**Deliverables:**
1. Update `getWorktreeBase()` in `src/lib/team-manager.ts` — use `~/.genie/worktrees/<project-name>/` when no explicit config
2. Update `worktreeBase` in `src/types/genie-config.ts` — make optional instead of defaulting to `.worktrees`
3. Update setup prompt in `src/genie-commands/setup.ts` — show new default path

**Acceptance Criteria:**
- [ ] `getWorktreeBase()` returns `~/.genie/worktrees/<basename>/` when no config set
- [ ] `getWorktreeBase()` returns configured path when `worktreeBase` is explicitly set
- [ ] Config schema accepts missing `worktreeBase` without error

**Validation:**
```bash
bun run typecheck
```

**depends-on:** none

---

### Group 2: Auto-prune and cleanup

**Goal:** Add stale worktree pruning and fix gitignore.

**Deliverables:**
1. Add `pruneStaleWorktrees(repoPath)` in `src/lib/team-manager.ts` — scan team configs, delete configs for missing worktrees, run `git worktree prune`
2. Call `pruneStaleWorktrees()` from `disbandTeam()` after cleanup
3. Fix `.gitignore` — add `.worktrees/`, remove `.genie/worktrees/`
4. `git rm -r --cached .worktrees/` to untrack committed worktrees
5. Delete `src/lib/worktree-manager.ts` and `src/lib/worktree-manager.test.ts` (dead code)

**Acceptance Criteria:**
- [ ] `pruneStaleWorktrees()` removes configs for non-existent worktree paths
- [ ] `.worktrees/` is in `.gitignore`
- [ ] No `.worktrees/` tracked in git after commit
- [ ] `worktree-manager.ts` deleted

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
git status --short .worktrees/  # should show nothing tracked
```

**depends-on:** Group 1

---

## QA Criteria

- [ ] `genie team create test-qa --repo <path> --branch dev` creates worktree under `~/.genie/worktrees/`, not in repo
- [ ] `genie team disband test-qa` fully cleans up worktree and config
- [ ] Existing teams with old paths still disband correctly
- [ ] `bun run check` passes with zero errors

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/lib/team-manager.ts          — new default path, add pruneStaleWorktrees()
src/types/genie-config.ts        — make worktreeBase optional
src/genie-commands/setup.ts      — update setup prompt default
.gitignore                       — add .worktrees/, remove .genie/worktrees/
src/lib/worktree-manager.ts      — DELETE
src/lib/worktree-manager.test.ts — DELETE
```
