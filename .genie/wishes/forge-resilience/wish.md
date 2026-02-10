# Wish: Forge Resilience — Graceful Failures in term work

**Status:** REVIEW
**Slug:** `forge-resilience`
**Created:** 2026-02-10
**PR:** #30 (`fix/sofia-field-report-fixes`)

> ⚠️ **Retroactive wish.** Code was shipped before this document existed.
> Sofia (PM) correctly flagged the process violation. This wish exists to
> provide acceptance criteria, spec review, and validation for PR #30.

---

## Summary

When an AI agent transitions from `/wish` → `/forge`, `term work` is the
execution bridge: it claims a beads issue, creates a worktree, and spawns a
Claude Code worker. Three bugs cause this bridge to collapse silently when
the environment isn't pristine — no `.genie/tasks.json`, a legacy beads
database, or any beads failure. The agent gets stuck with no actionable
error, requiring human intervention.

This wish fixes all three failure modes with graceful degradation: explicit
error messages, fallback paths, and an `--inline` escape hatch.

---

## Scope

### IN
- Graceful init of `.genie/tasks.json` when missing
- Guard rails on `claimTask()` — reject `in_progress` and `done` tasks with clear messages
- Fallback in `getBeadsIssue()` when `bd show` fails (legacy DB)
- New `--inline` flag for `term work` — bypass beads entirely
- Auto-fallback: beads claim failure → inline mode (not exit(1))
- Actionable error messages throughout (what failed, why, what to do)
- Tests for all new code paths

### OUT
- Fixing the beads legacy database migration itself (that's a `bd` issue)
- Changing `/forge` skill logic (this is `term work` only)
- Refactoring the existing `term work` happy path
- Any changes to `claudio` or tmux orchestration

---

## Decisions

- **DEC-1:** Auto-fallback to inline mode on beads failure rather than prompting the user. Rationale: AI agents can't answer interactive prompts during forge — they need the tool to keep working.
- **DEC-2:** `--inline` creates a synthetic issue object (not a real beads issue). Rationale: downstream code expects an issue shape; faking it is simpler than making everything optional.
- **DEC-3:** `claimTask()` returns `false` (not throws) on guard failures. Rationale: callers already handle the false case; throwing would require try/catch refactoring.

---

## Success Criteria

- [ ] `term work <id>` succeeds in a repo with no `.genie/tasks.json` (auto-creates it)
- [ ] `term work <id>` gives actionable error when task is already `in_progress`
- [ ] `term work <id>` gives actionable error when task is already `done`
- [ ] `term work <id>` auto-falls back to inline mode when `bd show` returns LEGACY DATABASE
- [ ] `term work <id> --inline` bypasses beads entirely and creates worktree+branch directly
- [ ] All error messages include: what was attempted, why it failed, what to do next
- [ ] 10+ new tests covering graceful init and claim guards
- [ ] Full test suite passes (pre-existing failures excluded)

---

## Assumptions

- **ASM-1:** Agents use `term work` as the primary entry point for forge execution (not manual git commands)
- **ASM-2:** The beads legacy DB issue is transient — repos will eventually migrate, but we can't block on it

## Risks

- **RISK-1:** Inline mode bypasses beads tracking, so work done inline won't appear in `bd list`. — Mitigation: synthetic issue logged to `.genie/tasks.json`; beads is supplementary, not authoritative.
- **RISK-2:** Auto-fallback masks real beads issues that should be fixed. — Mitigation: fallback emits a warning with `bd migrate` suggestion.

---

## Execution Groups

### Group A: Graceful Task Registry Init

**Goal:** `term work` never fails due to missing `.genie/tasks.json`.

**Deliverables:**
- `ensureTasksFile()` function in `local-tasks.ts`
- `claimTask()` guard: reject `in_progress` and `done` tasks with reason
- Error messages with actionable guidance

**Acceptance Criteria:**
- [ ] `ensureTasksFile()` creates `.genie/tasks.json` with `{tasks:{}, order:[], lastUpdated}` when missing
- [ ] `ensureTasksFile()` is idempotent (returns false if file exists, doesn't overwrite)
- [ ] `claimTask()` returns false + logs reason for `in_progress` tasks
- [ ] `claimTask()` returns false + logs reason for `done` tasks
- [ ] `claimTask()` returns false for non-existent task IDs

**Validation:** `bun test ./src/lib/local-tasks.test.ts`

**Files:**
- `src/lib/local-tasks.ts`
- `src/lib/local-tasks.test.ts`

---

### Group B: Beads Fallback on Legacy Database

**Goal:** `term work` doesn't crash when beads has a legacy database.

**Deliverables:**
- `getBeadsIssue()` fallback: try `bd list --json` when `bd show` fails
- Detection of LEGACY DATABASE error with migration suggestion
- Actionable error with `--inline` workaround

**Acceptance Criteria:**
- [ ] When `bd show` fails with LEGACY DATABASE, falls back to `bd list` parsing
- [ ] If fallback also fails, error message suggests `bd migrate --update-repo-id`
- [ ] Error message mentions `term work <id> --inline` as workaround

**Validation:** `bun test ./src/term-commands/work.test.ts`

**Files:**
- `src/term-commands/work.ts`

---

### Group C: Inline Mode & Auto-Fallback

**Goal:** Agents always have a working path from wish → execution, even if beads is broken.

**Deliverables:**
- `--inline` flag on `term work`: skip beads claim, create branch directly
- Auto-fallback: beads claim failure → inline mode (not exit(1))
- Synthetic issue creation for downstream compatibility
- CLI registration of `--inline` flag

**Acceptance Criteria:**
- [ ] `term work <id> --inline` creates worktree and branch without touching beads
- [ ] When beads claim fails, `term work` automatically retries in inline mode
- [ ] Inline mode creates a synthetic issue object with title, id, status
- [ ] Warning emitted when falling back to inline (not silent)
- [ ] `term --help` shows the `--inline` flag

**Validation:** `bun test ./src/term-commands/work.test.ts && bun test 2>&1 | tail -5`

**Files:**
- `src/term-commands/work.ts`
- `src/term.ts`

---

## Review Results

_Pending — run `/review` after wish validation._

---

## Files to Create/Modify

```
src/lib/local-tasks.ts          # ensureTasksFile(), claimTask() guards
src/lib/local-tasks.test.ts     # 10 new tests for graceful init + claim guards
src/term-commands/work.ts       # --inline flag, auto-fallback, beads fallback
src/term-commands/work.test.ts  # conflict marker fix
src/term.ts                     # --inline CLI registration
```
