---
name: "review"
description: "Use when all forge tasks are complete and work needs final validation - produces pass/fail verdict with categorized gaps"
---

# Review - Final Validation

## Overview

After all forge tasks complete, run a final review of the entire wish. Check every success criterion, run integration tests, optionally run browser tests, and produce a verdict.

**Three verdicts: SHIP / FIX-FIRST / BLOCKED**

---

## The Flow

### 1. Load Wish

```
Read .genie/wishes/<slug>/wish.md
Parse all success criteria
Verify all forge tasks are marked complete
```

### 2. Wish Audit (Criterion by Criterion)

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

### 3. Integration Verification

Run validation commands from the wish document:

```
For each execution group:
  Run its validation command
  Record: PASS or FAIL with output
```

### 4. Browser Tests (Optional)

If the wish involves user-facing changes and agent-browser is available:

```
Use agent-browser to:
  - Navigate to relevant pages
  - Verify user-visible behavior
  - Capture screenshots as evidence
```

**If agent-browser is not available:** Skip gracefully. Note in report: "Browser tests skipped - agent-browser not available."

### 5. Verdict

**SHIP** - All criteria pass. No CRITICAL or HIGH gaps.

```
Conditions:
  - Zero CRITICAL gaps
  - Zero HIGH gaps
  - All validation commands pass
  - MEDIUM/LOW gaps are advisory only
```

**FIX-FIRST** - Fixable issues found. Return to forge.

```
Conditions:
  - One or more HIGH gaps (fixable)
  - Or validation commands failing
  - Provide specific fix list for /genie:forge
```

**BLOCKED** - Fundamental issues. Return to wish.

```
Conditions:
  - CRITICAL gaps that require scope changes
  - Or architectural problems that can't be fixed in forge
  - Provide specific issues requiring wish revision
```

### 6. Write Results

Update the wish document with review results:

```markdown
## Review Results

**Verdict:** SHIP | FIX-FIRST | BLOCKED
**Date:** YYYY-MM-DD

### Criteria Check
- [x] Criterion 1 - PASS: [evidence]
- [ ] Criterion 2 - FAIL (HIGH): [gap description]

### Validation Commands
- [x] `command 1` - PASS
- [ ] `command 2` - FAIL: [output]

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

**If SHIP:** Work is done. Inform the user.

**If FIX-FIRST:**
```
"Review found fixable issues. Run /genie:forge to address:
1. [gap 1]
2. [gap 2]
Then run /genie:review again."
```

**If BLOCKED:**
```
"Review found fundamental issues requiring scope changes.
Revise the wish document to address:
1. [issue 1]
2. [issue 2]
Then run /genie:forge and /genie:review again."
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
- Re-implement fixes during review (that's forge's job)
- Change scope during review (that's wish's job)
- Block on MEDIUM or LOW gaps
- Forget to write results back to the wish document
