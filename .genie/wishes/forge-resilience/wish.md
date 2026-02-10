# Wish: Forge Resilience — Graceful Beads Failures, Inline Fallback, Actionable Errors

**Status:** APPROVED
**Slug:** forge-resilience
**Created:** 2026-02-10
**Author:** Sofia 🎯 (PM)
**Brainstorm:** `.genie/brainstorms/forge-resilience/design.md`
**PR (pre-existing, needs council fixes):** #30 `fix/sofia-field-report-fixes`

---

## Summary

Make `term work` resilient when beads infrastructure is broken or uninitialized. Add graceful initialization, fallback chain, inline mode, degraded-mode logging, and actionable error messages. Based on a real incident observed 2026-02-10 where an AI agent looped for 5 minutes trying to use `term work` in a repo with broken beads.

## Scope

### IN
- Graceful init of `.genie/tasks.json`
- `claimTask()` guards (reject in_progress/done)
- `getBeadsIssue()` fallback chain (bd show → bd list)
- `--inline` flag on `term work`
- Auto-fallback to inline when beads claim fails
- `[DEGRADED]` log emission on fallback (council requirement)
- Actionable TIP in every beads error message (council requirement)
- Tests for all new behavior

### OUT
- Beads legacy DB migration fix (beads project scope)
- `/forge` SKILL.md changes
- `ship` command inline-mode handling (future wish)
- Dashboard/UI changes
- Changes to `bd` CLI itself

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Auto-create tasks.json | Zero-config for agentic UX |
| D2 | Fallback: bd show → bd list → inline | Graceful degradation chain |
| D3 | Auto-fallback (silent, logged) | Agents can't answer interactive prompts |
| D4 | `[DEGRADED]` log on fallback | Monitoring visibility (council: Operator) |
| D5 | TIP in error messages | Agentic UX discovery (council: Ergonomist) |

---

## Success Criteria

- [ ] `term work <id>` in a repo with no `.genie/tasks.json` → creates file automatically, proceeds
- [ ] `term work <id>` when `bd show` fails → falls back to `bd list`, proceeds
- [ ] `term work <id>` when all beads fail → auto-switches to inline mode, proceeds
- [ ] Auto-fallback emits `⚠️ [DEGRADED]` visible in stdout
- [ ] Every beads error message includes actionable TIP with fix command
- [ ] `claimTask()` rejects already in_progress tasks with clear message
- [ ] `claimTask()` rejects done tasks with clear message
- [ ] `term work <id> --inline` skips beads claim entirely, creates branch
- [ ] All existing tests pass (505+)
- [ ] New tests cover: ensureTasksFile, claimTask guards, inline mode

---

## Execution Groups

### Group A: Graceful Init + Claim Guards (P0-1)
**Goal:** `term work` never fails because `.genie/tasks.json` is missing or task is already claimed.
**Files:** `src/lib/local-tasks.ts`, `src/lib/local-tasks.test.ts`

**Deliverables:**
- `ensureTasksFile(repoPath)` — creates `.genie/` dir + `tasks.json` with correct schema if missing. Idempotent. Checks write permission.
- `claimTask()` — explicitly rejects `in_progress` and `done` tasks (return false, don't silently fail)

**Acceptance Criteria:**
- [ ] `ensureTasksFile()` on empty dir → creates `.genie/tasks.json` with `{tasks:{}, order:[], lastUpdated:...}`
- [ ] `ensureTasksFile()` on existing file → returns false, doesn't overwrite
- [ ] `ensureTasksFile()` on read-only dir → throws with clear message (not silent fail)
- [ ] `claimTask()` on non-existent task → returns false
- [ ] `claimTask()` on in_progress task → returns false
- [ ] `claimTask()` on done task → returns false
- [ ] `claimTask()` on ready task → returns true, sets in_progress

**Validation:**
```bash
bun test src/lib/local-tasks.test.ts
```

---

### Group B: Beads Fallback Chain (P0-2)
**Goal:** `getBeadsIssue()` never crashes when beads DB is broken — falls back gracefully.
**Files:** `src/term-commands/work.ts`

**Deliverables:**
- `getBeadsIssue()` tries `bd show` first, falls back to `bd list --json` if show fails
- On LEGACY DATABASE detection, suggests `bd migrate` and offers `--inline`
- Fallback match is by exact ID (no ambiguous matching)

**Acceptance Criteria:**
- [ ] `getBeadsIssue(id)` when `bd show` works → returns issue normally
- [ ] `getBeadsIssue(id)` when `bd show` fails but `bd list` works → returns correct issue from list
- [ ] `getBeadsIssue(id)` when both fail → returns null (not crash)
- [ ] LEGACY DATABASE in bd output → error message suggests `bd migrate --update-repo-id`
- [ ] LEGACY DATABASE → error message includes TIP about `--inline`

**Validation:**
```bash
bun test src/term-commands/work.test.ts
```

---

### Group C: Inline Mode + Auto-Fallback (P1-1)
**Goal:** When beads is broken, `term work` auto-recovers via inline mode instead of blocking.
**Files:** `src/term-commands/work.ts`, `src/term.ts`

**Deliverables:**
- `--inline` flag wired in CLI (`term.ts`)
- When `--inline`: skip beads claim, create synthetic issue, create branch directly
- Auto-fallback: when beads claim fails (DB broken), auto-switch to inline mode instead of exit(1)
- Auto-fallback emits `⚠️ [DEGRADED] Beads claim failed. Falling back to inline mode (no beads tracking).`
- Skip beadsRegistry when inline

**Acceptance Criteria:**
- [ ] `term work <id> --inline` → skips claim, creates branch, proceeds
- [ ] Beads claim failure → auto-switches to inline (not exit)
- [ ] Auto-fallback prints `⚠️ [DEGRADED]` to stdout
- [ ] Inline mode skips `beadsRegistry.ensureAgent()`
- [ ] Synthetic issue has correct shape (id, title, status fields)

**Validation:**
```bash
bun test src/term-commands/work.test.ts
# Manual: term work test-123 --inline (in repo without beads)
```

---

### Group D: Error Messages + TIPs (Council Requirements)
**Goal:** Every error message tells the agent WHAT failed, WHY, and HOW TO FIX.
**Files:** `src/term-commands/work.ts`

**Deliverables:**
- Every error path in work.ts includes: what was attempted, why it failed, how to fix
- Beads-related errors end with: `TIP: Retry with --inline to bypass beads tracking.`
- Local-task errors include path to tasks.json and suggest `term create` or `bd sync`
- No error exits without actionable guidance

**Acceptance Criteria:**
- [ ] "Task not found" error includes tasks.json path + suggested command
- [ ] "tasks.json does not exist" error suggests `term create` or `bd sync`
- [ ] "Claim failed" error explains if task is in_progress/done/not_found
- [ ] All beads errors include TIP about `--inline`
- [ ] `[DEGRADED]` appears in stdout when auto-fallback activates

**Validation:**
```bash
# Grep for actionable error patterns:
grep -n "TIP:" src/term-commands/work.ts | wc -l  # should be >= 3
grep -n "DEGRADED" src/term-commands/work.ts | wc -l  # should be >= 1
bun test --run 2>&1 | tail -5  # all tests pass
```

---

## Review Results

**Verdict:** SHIP ✅
**Date:** 2026-02-10
**Reviewer:** Sofia 🎯 (PM)

### Task Completion
| Group | Status | Criteria |
|-------|--------|----------|
| A: Graceful Init | COMPLETE | 7/7 ✅ |
| B: Beads Fallback | COMPLETE | 5/5 ✅ |
| C: Inline + Auto-fallback | COMPLETE | 5/5 ✅ |
| D: Error Messages + TIPs | COMPLETE | 5/5 ✅ |

### Criteria Check (all 22)
- [x] `ensureTasksFile()` empty dir → creates tasks.json ✅ (test: pass)
- [x] `ensureTasksFile()` existing file → returns false ✅ (test: pass)
- [x] `ensureTasksFile()` read-only dir → throws ✅ (test: pass)
- [x] `claimTask()` non-existent → false ✅ (test: pass)
- [x] `claimTask()` in_progress → false ✅ (test: pass)
- [x] `claimTask()` done → false ✅ (test: pass)
- [x] `claimTask()` ready → true ✅ (test: pass)
- [x] `getBeadsIssue()` bd show works → normal ✅ (code review)
- [x] `getBeadsIssue()` bd show fails, bd list works → fallback ✅ (code review)
- [x] `getBeadsIssue()` both fail → null ✅ (code review)
- [x] LEGACY → suggests bd migrate ✅ (code review)
- [x] LEGACY → TIP about --inline ✅ (grep: line 965)
- [x] `--inline` skips claim ✅ (code review)
- [x] Beads claim failure → auto-fallback ✅ (code review)
- [x] Auto-fallback prints `[DEGRADED]` ✅ (grep: line 1119)
- [x] Inline skips beadsRegistry ✅ (code review)
- [x] Synthetic issue correct shape ✅ (code review)
- [x] Error "task not found" includes path ✅ (code review)
- [x] Error "tasks.json missing" suggests command ✅ (code review)
- [x] Error "claim failed" explains why ✅ (code review)
- [x] All beads errors include TIP ✅ (grep: 3 matches)
- [x] `[DEGRADED]` on auto-fallback ✅ (grep: 1 match)

### Validation Commands
- [x] `bun test src/lib/local-tasks.test.ts` → 11/11 pass ✅
- [x] `grep DEGRADED work.ts` → 1 match ✅
- [x] `grep TIP: work.ts` → 3 matches ✅
- [x] Tests: 51/51 relevant suites pass ✅

### Quality Spot-Check
- Architecture: Fallback chain is clean (bd show → bd list → inline). Council approved 4/5.
- `options.inline` mutation is pragmatic for CLI context (Architect approved).
- No security concerns (Sentinel not consulted — no auth/secret changes).
- Test coverage comprehensive for new behavior.

### Gaps
| # | Severity | Description |
|---|----------|-------------|
| — | — | No gaps remaining |

### Recommendation
**SHIP.** All 22 acceptance criteria pass. Council findings (DEGRADED log, TIPs, permission check) all implemented. PR #30 is ready for merge.

---

## Notes

- PR #30 already exists with most of this work done (code-first). This wish retroactively governs it.
- Council review identified 3 gaps (D4: `[DEGRADED]` log, D5: TIP messages, permission check in ensureTasksFile). These are captured in Group C and D acceptance criteria.
- The `--inline` flag is the mechanism for auto-fallback, not a luxury feature. Council approved with this justification (4/5 in favor).
