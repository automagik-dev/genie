> ⚠️ DEPRECATED: This skill has been replaced by `/dream`. See `dream/SKILL.md`.

---
name: sleepyhead
description: "Overnight batch execution — human defines tasks before sleep, agent executes the full pipeline (brainstorm → wish → work → review → PR) autonomously. Wake up to reviewed PRs. Use when the user says 'sleepyhead', 'overnight', 'batch run', 'kill the backlog', 'run while I sleep', or hands off a task list for autonomous execution."
---

# Sleepyhead — Overnight Batch Execution

Plan before sleep. Wake up to reviewed PRs.

## Overview

The human provides a task list. The agent runs the full skill pipeline per task — **brainstorm → wish → work → review → PR** — with no human interaction. Output: N reviewed PRs + a wake-up summary.

Each task becomes one PR (up to ~2k lines). Use git worktrees for parallel work.

---

## Input: What the Human Provides

Before activating, confirm you have:

1. **Task list** — items that each become one PR. Per task:
   - Objective (1–3 bullets)
   - Scope (files/areas)
   - Acceptance criteria (tests, routes, logs, etc.)
   - Constraints (don't touch X, keep compat with Y)
   - Priority + ordering (or "parallelizable")

2. **Repo conventions:**
   - Branch naming (e.g. `feat/<slug>`, `fix/<slug>`)
   - Commit style (conventional commits, etc.)
   - PR checklist (lint, tests, screenshots, logs)

3. **Permissions:**
   - Can create branches? Push to remote? Open PRs?
   - Target branch for PRs (usually `main` or `dev`)

If anything is missing, ask **before** starting. Once confirmed, the human goes to sleep.

---

## Pipeline: Per-Task Execution

For each task (parallel via worktrees when safe, sequential when dependent):

### A) Brainstorm

Run `/brainstorm` for the task:
- Explore approach, trade-offs, risks
- Output: validated design ready for wish

### B) Wish

Run `/wish` to create `.genie/wishes/<task-slug>/wish.md`:
- Summary, scope (IN/OUT), decisions, success criteria
- Execution groups with validation commands
- Definition of Done for the PR

### C) Work

Run `/work` (dispatches implementor subagents per execution group):
1. Create worktree: `git worktree add ../repo-<task-slug> -b <convention>/<task-slug>`
2. Implement in the worktree (isolates parallel work)
3. Spec review + quality review per group (with fix loops)
4. Run lint/format, tests, build + smoke checks
5. Commit with clean, descriptive messages

### E) Review

Run `/review` for final validation:
- Criterion-by-criterion audit with evidence
- All validation commands re-run
- Quality spot-check (security, edge cases, performance)
- Verdict: SHIP / FIX-FIRST / BLOCKED

**If FIX-FIRST:** return to /work, fix, re-review (max 2 loops).
**If BLOCKED:** mark task blocked, note why, move to next.

### F) PR

1. Push branch to remote
2. Create PR via `gh pr create` with:
   - **Title:** conventional format
   - **Body:** context + what changed, how to test, checklist, risks, follow-ups
3. Wait for CI + Gemini auto-review
4. Read Gemini's review comments
5. If Gemini flagged real issues → fix in worktree, push, re-check
6. If Gemini comments are noise/style-only → note in PR, move on
7. Update wish status to SHIPPED

---

## Worktree Strategy

```bash
# Create isolated worktree per task
git worktree add ../repo-<slug> -b feat/<slug> <target-branch>

# Work in worktree
cd ../repo-<slug>

# After PR is opened, clean up
git worktree remove ../repo-<slug>
```

- Parallel tasks get parallel worktrees — no branch conflicts
- Each worktree starts from the target branch (clean base)
- Dependent tasks: wait for dependency PR, rebase from its branch

---

## Execution Strategy

### Ordering
- Execute tasks in declared priority order
- Parallelizable tasks: dispatch in parallel worktrees via subagents
- Dependent tasks: sequential, each rebasing from the previous

### Error Handling
- Task fails after 2 fix loops → mark BLOCKED, note state, move to next
- Build breaks globally → stop, document, alert in summary
- Never merge — only open PRs. Human merges after waking up.

### Checkpoints
After each task completes (or blocks), update:
- `.genie/wishes/<slug>/wish.md` status
- Running tally for the wake-up summary

---

## Output: Wake-Up Summary

When all tasks are done, deliver to the human's channel:

```markdown
# 🌅 Sleepyhead Report

## Completed (N PRs)
| # | Task | PR | Lines | Review | Notes |
|---|------|----|-------|--------|-------|
| 1 | <name> | #<num> | ~800 | ✅ SHIP | clean |
| 2 | <name> | #<num> | ~1.2k | ✅ SHIP | 1 Gemini comment addressed |

## Blocked (N tasks)
| # | Task | Reason | Branch |
|---|------|--------|--------|
| 3 | <name> | <why> | `feat/<slug>` partial |

## Gemini Review Notes
- PR #1: no comments
- PR #2: flagged unused import → fixed
- PR #3: style suggestion → noted, not blocking

## Follow-Ups
- [ ] Task 2: <LOW item>
- [ ] Task 3: needs <what> to unblock

## Stats
- Tasks: N completed, M blocked, P total
- PRs opened: N
- Build: ✅ green / ⚠️ issues
```

---

## Key Principles

- **Zero interaction after start** — ask everything upfront
- **Full skill pipeline** — brainstorm → wish → work → review → PR
- **One task = one PR** — up to ~2k lines, atomic and reviewable
- **Worktrees for parallelism** — no branch pollution between tasks
- **Gemini reviews are real** — read comments, fix genuine issues, ignore noise
- **Never merge** — only open PRs. Human decides merge order.
- **Fix loops are bounded** — max 2 attempts per stage, then BLOCKED
- **Honest reporting** — blocked is better than shipping broken code
