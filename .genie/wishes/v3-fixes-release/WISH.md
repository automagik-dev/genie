# Wish: v3 Fixes-Only Release (Cherry-Pick from Dev)

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `v3-fixes-release` |
| **Date** | 2026-03-22 |
| **Design** | N/A — CEO decision to decouple PG from release |

## Summary

Cherry-pick only bug fixes and enhancements from `dev` into `main` for a clean v3.x release. PostgreSQL, scheduler, daemon, resume, and all new features stay on `dev` for Genie v4. PR #686 (full dev→main promotion) should be closed and labeled "v4".

## Scope

### IN
- Cherry-pick **15 fix commits** and **5 enhancement commits** (20 total) from dev onto a new branch from main
- Close PR #686 and label it for v4
- Open a new fixes-only PR targeting main
- Version bump for stable release
- Build and test validation

### OUT
- **PostgreSQL / pgserve** — v4
- **Scheduler daemon** — v4
- **Daemon CLI** — v4
- **Resume command / daemon auto-resume** — v4
- **Fire-and-forget genie work** (#674) — v4
- **Transcript reader** (#670) — v4
- **Transcript docs** — v4
- **Any new features or capabilities** — v4
- **`ef31b152` Revert of PR #644** — DANGEROUS: main HEAD is #644, cherry-picking this would undo the entire production release
- v4 planning or roadmap work

## Decisions

| Decision | Rationale |
|----------|-----------|
| Cherry-pick (not rebase/squash) | Preserves individual commit attribution and makes conflict resolution incremental |
| Include `--continue by name` enhancement | It replaces `--resume UUID` (improving existing UX), and its follow-up fixes depend on it |
| Include tmux/session enhancements | These improve existing tmux workflow, not new capabilities |
| Exclude fire-and-forget (#674) | May depend on pgserve; is a new capability, not an enhancement |
| Exclude transcript reader (#670) | New feature, not an enhancement to existing functionality |
| Close PR #686, don't rebase it | Cleaner to start fresh than to unpick commits from an existing PR |

## Success Criteria

- [ ] New branch `fix/v3-release` created from current `main`
- [ ] All 20 commits cherry-picked cleanly (or conflicts resolved)
- [ ] `bun run build` passes
- [ ] `bun run test` passes
- [ ] PR opened targeting `main` with only fixes + enhancements
- [ ] PR #686 closed with "v4" label
- [ ] No pgserve, scheduler, daemon, or resume code present in the PR diff

## Execution Strategy

### Wave 1 (sequential — cherry-picks must be ordered)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Cherry-pick fixes + enhancements onto branch from main |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Build, test, version bump, open PR |

### Wave 3 (after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | qa | QA review: verify no v4 code leaked, tests pass, PR is clean |

## Execution Groups

### Group 1: Cherry-Pick Fixes and Enhancements

**Goal:** Apply all v3-eligible commits from dev onto a clean branch from main.

**Deliverables:**
1. Branch `fix/v3-release` created from `main` HEAD
2. Cherry-pick the following 20 commits **in this exact chronological order** (oldest first):

```
 1. 4e67fb34 fix(tmux): restore dual status bar with clickable tabs and agent enrichment
 2. 4d01f390 fix(tmux): sync genie.tmux.conf and auto-reload on update
 3. 925dc5b7 feat: folder-based sessions, run-in-current-tab, agent bottom bar
 4. d20f3676 feat: pass --name to Claude Code for unified session naming
 5. 98abeac0 fix: add --agent-type team-lead to interactive session launch
 6. 7cb87129 fix: set agent-name to team-lead for all interactive sessions
 7. 46d30d45 feat(tmux): dual status bar — sessions top, tabs bottom, both clickable
 8. a08fb487 fix(tmux): single bottom bar with clickable tabs + info
 9. 3f6fa344 fix(team): replace git worktree with git clone --shared (#655)
10. d4c0c51f fix(tmux): dual bar layout — tabs top, sessions bottom, info via pane-border (#656)
11. bc35ce14 fix(session): drop hardcoded 'genie' session name and UUID session IDs
12. ab059e1f fix(session): remove remaining hardcoded 'genie' session references
13. 446befda fix(session): replace UUID fallback for parentSessionId with deterministic team name
14. 57c60092 fix(resolver): add team-scoped role fallback for target resolution
15. a2ef945a feat(session): replace --resume UUID with --continue by session name (#663)
16. e5f48e2f fix(session): don't pass --continue on first run (no session to continue)
17. 39e0fa36 fix(session): remove broken --continue from inside-tmux path, add dead-pane relaunch
18. 65188034 fix(claude-logs): replace dots with dashes in project path hash
19. 4175aac5 fix: stable release fixes — cron, timezone, lease-timeout, notifications
20. 1e302e81 feat: auto-create tmux session in ensureTeamWindow for --session flag
```

**EXCLUDED (DO NOT cherry-pick):**
- `ef31b152` — Revert of PR #644. Main HEAD IS #644. Cherry-picking would undo entire production release.
- All `chore(version): bump` commits — we do our own version bump.
- All scheduler, daemon, pgserve, resume, transcript commits — v4.

**Acceptance Criteria:**
- [ ] All commits applied (or skipped with documented reason)
- [ ] No scheduler/daemon/pgserve/resume imports in the diff
- [ ] Branch compiles without errors

**Validation:**
```bash
git log --oneline main..fix/v3-release | wc -l  # Should be 20
git diff main..fix/v3-release -- '**/pgserve*' '**/scheduler*' '**/daemon*' | wc -l  # Should be 0
```

**depends-on:** none

---

### Group 2: Build, Test, Version Bump, Open PR

**Goal:** Validate the cherry-picked branch and open PR targeting main.

**Deliverables:**
1. `bun run build` passes
2. `bun run test` passes
3. Version bumped appropriately for stable release
4. PR opened targeting `main` with descriptive body listing all included fixes
5. PR #686 closed with comment explaining v4 split

**Acceptance Criteria:**
- [ ] Build passes
- [ ] Tests pass
- [ ] PR created and targeting main
- [ ] PR #686 closed

**Validation:**
```bash
bun run build && bun run test
gh pr view --json state,title | jq .
```

**depends-on:** Group 1

---

### Group 3: QA Review

**Goal:** Verify the PR is clean, contains only fixes/enhancements, and no v4 code leaked.

**Deliverables:**
1. Diff audit — no pgserve, scheduler, daemon, resume, or transcript code
2. Test results verified
3. QA approval on PR

**Acceptance Criteria:**
- [ ] No v4 code in diff
- [ ] All tests green
- [ ] QA approved

**Validation:**
```bash
gh pr diff <PR_NUMBER> | grep -c "pgserve\|scheduler-daemon\|daemon\.ts\|resume\.ts"  # Should be 0
```

**depends-on:** Group 2

---

## QA Criteria

- [ ] PR diff contains ONLY fix and enhancement commits — no new features
- [ ] No references to pgserve, scheduler daemon, resume daemon in changed files
- [ ] `bun run build` succeeds on the PR branch
- [ ] `bun run test` passes on the PR branch
- [ ] `genie` CLI starts and runs basic commands after install from PR branch
- [ ] Existing tmux session management works (spawn, send, ls)

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Cherry-pick conflicts from interleaved commits | Medium | Apply in chronological order; resolve conflicts per-commit |
| Enhancement commits may have hidden dependencies on v4 code | Medium | Engineer must verify imports after each cherry-pick; drop commits that pull in v4 deps |
| `ef31b152` revert excluded (would undo production) | RESOLVED | Excluded from cherry-pick list after review — main HEAD is the commit it reverts |
| Some session fixes depend on `--continue` feature commit | Low | Already included `a2ef945a` in the cherry-pick list |

---

## Review Results

### Plan Review — 2026-03-22
- **Verdict:** FIX-FIRST → fixed → **SHIP**
- **CRITICAL fixed:** Removed `ef31b152` (revert that would undo production). Added to Scope OUT.
- **MEDIUM fixed:** Commits reordered into actual chronological sequence (was grouped by category).
- **LOW fixed:** Validation command corrected from three-dot to two-dot diff.
- **CEO approved** the full commit split (20 IN, 14 v4, 9 skip).

---

## Files to Create/Modify

```
(determined by cherry-pick — primarily touches:)
src/cli/commands/  (session, team)
src/tmux/          (status bar, tabs, config)
src/session/       (naming, continue, agent-type)
src/resolver/      (role fallback)
src/claude-logs/   (path hash fix)
package.json       (version bump)
```
