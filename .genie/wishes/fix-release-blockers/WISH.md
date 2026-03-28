# Wish: Fix release blockers — stale state + resume context

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `fix-release-blockers` |
| **Date** | 2026-03-24 |
| **Issues** | #743, #744 |

## Summary

Two bugs block stable release: (1) `genie status` reads stale state because `resolveRepoPath()` returns worktree-specific paths, so state written from worktree A is invisible from worktree B. (2) `genie resume` spawns agents with `--resume` but injects no context about their prior progress — the agent has no idea which groups are done, which wave it was in, or what to do next.

## Scope

### IN
- Fix `resolveRepoPath()` in `wish-state.ts` to normalize to the main repo path (not worktree path)
- Fix `resumeAgent()` in `agents.ts` to inject a status summary as `initialPrompt`
- Tests for both fixes

### OUT
- No changes to PG schema
- No changes to how state is written (only how it's read/scoped)
- No changes to team-lead prompt or AGENTS.md
- No auto-resume daemon changes

## Decisions

| Decision | Rationale |
|----------|-----------|
| Use `git rev-parse --path-format=absolute --git-common-dir` to normalize repo path | Returns the main repo's `.git` dir even from worktrees. Parent dir of that = canonical repo path. |
| Resume injects wish status summary as initialPrompt | Same pattern as PR #746 (initialPrompt at spawn). Agent sees "Groups 1-3 done, Group 4 in_progress, your job is..." |
| Keep file-based state resolution as fallback | If PG is unavailable, fall back to `.genie/state/*.json` files |

## Success Criteria

- [ ] `genie status <slug>` from parent worktree shows correct state written by child team
- [ ] `genie resume <team-lead>` injects status summary — agent knows where it left off
- [ ] State is consistent across all worktrees sharing the same repo
- [ ] `bun run check` passes

## Execution Strategy

### Wave 1 (parallel — different files)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix resolveRepoPath in wish-state.ts (#743) |
| 2 | engineer | Fix resumeAgent context injection in agents.ts (#744) |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | reviewer | Review both fixes |

## Execution Groups

### Group 1: Fix resolveRepoPath — normalize to main repo (#743)

**Goal:** `genie status` returns consistent state regardless of which worktree it's called from.

**Deliverables:**
1. In `src/lib/wish-state.ts`, function `resolveRepoPath()` (line 55):
   - Replace `git rev-parse --show-toplevel` with logic that detects worktrees
   - Use `git rev-parse --git-common-dir` to find the shared `.git` directory
   - Derive the main repo path from the common dir (parent directory of `.git`)
   - If inside a worktree, resolve to the main repo path, not the worktree path
   - Fallback: if not a git repo, use `process.cwd()` (existing behavior)

   ```typescript
   function resolveRepoPath(cwd?: string): string {
     if (cwd) return cwd;
     try {
       // git-common-dir returns the shared .git for worktrees, or .git for main repo
       const commonDir = execSync('git rev-parse --path-format=absolute --git-common-dir', {
         encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
       }).trim();
       // For main repos: commonDir = /path/to/repo/.git → parent = /path/to/repo
       // For worktrees: commonDir = /path/to/main-repo/.git → same parent
       const { dirname } = require('node:path');
       return dirname(commonDir);
     } catch {
       return process.cwd();
     }
   }
   ```

2. Add test in `src/lib/wish-state.test.ts`:
   - Test that `resolveRepoPath()` returns the same path from main repo and worktree
   - Test fallback to cwd when not in a git repo

**Acceptance Criteria:**
- [ ] `resolveRepoPath()` returns main repo path from any worktree
- [ ] State written from worktree A is readable from worktree B
- [ ] Non-git directories fall back to cwd

**Validation:**
```bash
bun test src/lib/wish-state.test.ts && bun run typecheck
```

**depends-on:** none

---

### Group 2: Fix resume context injection (#744)

**Goal:** Resumed agents know where they left off.

**Deliverables:**
1. In `src/term-commands/agents.ts`, function `resumeAgent()` (line 1183):
   - After building params (line 1188), check if the agent has a team and wish context
   - If the agent's role is `team-lead`, look up the wish state via `getState()` from `wish-state.ts`
   - Build a status summary as `initialPrompt`:
     ```
     You were resumed after a crash. Here's where you left off:
     Wish: <slug>
     Group 1: done (completed at <time>)
     Group 2: in_progress (started at <time>)
     Group 3: blocked (depends on Group 2)

     Continue from where you left off. Run `genie status <slug>` to verify, then dispatch the next wave.
     ```
   - Set `params.initialPrompt = statusSummary`
   - For non-team-lead agents: inject a simpler message: "You were resumed. Check your team's current state with `genie status`."

2. Add helper function `buildResumeContext(agent: registry.Agent): Promise<string | undefined>`:
   - Reads wish state from the agent's team worktree
   - Formats a human-readable status summary
   - Returns undefined if no wish context found (agent proceeds without extra context)

3. Add test:
   - Test that resume with wish context includes group statuses in initialPrompt
   - Test that resume without wish context returns undefined

**Acceptance Criteria:**
- [ ] Team-lead resume includes wish group statuses in initialPrompt
- [ ] Non-team-lead resume gets basic "you were resumed" message
- [ ] Resume still works if no wish state exists (graceful fallback)

**Validation:**
```bash
bun test src/term-commands/agents.ts && bun run typecheck
```

**depends-on:** none

---

### Group 3: Review

**Goal:** Review both fixes for correctness.

**Deliverables:**
1. Verify resolveRepoPath normalization works across worktree scenarios
2. Verify resume context accurately reflects wish state
3. Verify no regressions in existing tests

**Acceptance Criteria:**
- [ ] Both fixes reviewed and SHIPPED
- [ ] `bun run check` passes

**Validation:**
```bash
bun run check
```

**depends-on:** Group 1, Group 2

---

## QA Criteria

- [ ] `genie status <slug>` from parent worktree matches child worktree state
- [ ] `genie resume <team-lead>` shows context about prior progress
- [ ] All 1137+ tests pass
- [ ] No regressions in wish-state or agent lifecycle

## Files to Create/Modify

```
src/lib/wish-state.ts           — fix resolveRepoPath to normalize across worktrees
src/lib/wish-state.test.ts      — worktree path resolution tests
src/term-commands/agents.ts      — resume context injection via initialPrompt
```
