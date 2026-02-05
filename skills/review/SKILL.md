---
name: review
description: "Use when all make tasks are complete and work needs final validation - produces SHIP/FIX-FIRST/BLOCKED verdict with categorized gaps."
---

# Review - Final Validation

## Overview

After make completes all tasks, run comprehensive final review. Check every success criterion with evidence, run validation commands, do quality spot-check, and produce the ship decision.

**Three verdicts: SHIP / FIX-FIRST / BLOCKED**

---

## The Flow

### 1. Load Wish & Verify Tasks

```
Read .genie/wishes/<slug>/wish.md
Check TaskList for wish tasks
Verify all tasks marked complete
```

**If tasks incomplete:** Stop. Output: "Make not complete. [N] tasks remaining. Run /make to continue."

### 2. Task Completion Audit

For each execution group in the wish:
- Check the task was completed
- Verify acceptance criteria checkboxes are checked
- Note any tasks that were BLOCKED during make

**Output per group:**
```
Group A: [name]
- Task: COMPLETE | BLOCKED
- Criteria: [X/Y] checked
```

### 3. Criterion-by-Criterion Audit

For each success criterion in the wish document:

- **PASS**: Evidence exists. Describe the evidence.
- **FAIL**: Not met. Categorize the gap.

**Gap Categories:**

| Severity | Meaning | Blocks Ship? |
|----------|---------|--------------|
| CRITICAL | Broken functionality, security flaw, data loss | Yes |
| HIGH | Missing feature, major bug, test failure | Yes |
| MEDIUM | Missing edge case, incomplete docs | No |
| LOW | Style, naming, minor polish | No |

### 4. Run All Validation Commands

Execute validation command for each execution group:

```
For each execution group:
  Run its validation command
  Record: PASS or FAIL with output
```

### 5. Quality Spot-Check

Dispatch a quick quality review:

```
Task tool dispatch:
  subagent_type: general-purpose
  prompt: |
    Quick quality review for wish: [slug]

    Check the changes made across all execution groups.
    Look for obvious issues:
    - Security vulnerabilities
    - Broken error handling
    - Missing null checks
    - Obvious performance issues

    Verdict: OK or CONCERNS with brief list.
```

### 6. Browser Tests (Optional)

If the wish involves user-facing changes and agent-browser is available:
- Navigate to relevant pages
- Verify user-visible behavior
- Capture screenshots as evidence

**If agent-browser is not available:** Skip gracefully. Note: "Browser tests skipped - agent-browser not available."

### 7. Verdict

**SHIP** - All criteria pass. No CRITICAL or HIGH gaps.

```
Conditions:
  - Zero CRITICAL gaps
  - Zero HIGH gaps
  - All validation commands pass
  - No BLOCKED tasks
  - Quality spot-check returns OK or minor concerns only
  - MEDIUM/LOW gaps are advisory only
```

**FIX-FIRST** - Fixable issues found. Return to make.

```
Conditions:
  - One or more HIGH gaps (fixable)
  - Or validation commands failing
  - Quality spot-check found significant concerns
  - Provide specific fix list for /make
```

**BLOCKED** - Fundamental issues. Return to wish.

```
Conditions:
  - CRITICAL gaps that require scope changes
  - Or architectural problems that can't be fixed in make
  - Any BLOCKED tasks from make
  - Provide specific issues requiring wish revision
```

### 8. Write Results

Update the wish document with review results:

```markdown
## Review Results

**Verdict:** SHIP | FIX-FIRST | BLOCKED
**Date:** YYYY-MM-DD

### Task Completion
| Group | Status | Criteria |
|-------|--------|----------|
| A | COMPLETE | 3/3 |
| B | COMPLETE | 2/2 |

### Criteria Check
- [x] Criterion 1 - PASS: [evidence]
- [ ] Criterion 2 - FAIL (HIGH): [gap description]

### Validation Commands
- [x] `command 1` - PASS
- [ ] `command 2` - FAIL: [output]

### Quality Spot-Check
Verdict: OK
Notes: [brief notes if any]

### Browser Tests
- [x] Page loads correctly
- Skipped: agent-browser not available

### Gaps
| # | Severity | Description | Fix |
|---|----------|-------------|-----|
| 1 | HIGH | Missing error handling | Add try/catch in handler.ts |
| 2 | MEDIUM | No edge case test | Add test for empty input |

### Recommendation
[One paragraph: what to do next]
```

---

## After Review

**If SHIP:**
```
"Review passed. Work is complete and ready to ship."
```

**If FIX-FIRST:**
```
"Review found fixable issues. Run /make to address:
1. [gap 1]
2. [gap 2]
Then run /review again."
```

**If BLOCKED:**
```
"Review found fundamental issues requiring scope changes.
Revise the wish document to address:
1. [issue 1]
2. [issue 2]
Then run /make and /review again."
```

---

## Key Principles

- **Every criterion checked** - No skipping, no "probably fine"
- **Evidence required** - PASS needs proof, not assumption
- **Gaps categorized** - Severity determines whether it blocks
- **Actionable feedback** - Every FAIL includes how to fix
- **Browser tests graceful** - Skip if agent-browser unavailable, don't fail
- **Results written to wish** - Review results live in the wish document

---

## Never Do

- Declare SHIP with CRITICAL or HIGH gaps
- Skip validation commands
- Mark criteria PASS without evidence
- Re-implement fixes during review (that's make's job)
- Change scope during review (that's wish's job)
- Block on MEDIUM or LOW gaps
- Pass with BLOCKED tasks from make
- Maket to write results back to the wish document
