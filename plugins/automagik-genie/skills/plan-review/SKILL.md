---
name: plan-review
description: "Validate a wish document (structure, scope boundaries, acceptance criteria, validation commands). Use after creating or editing .genie/wishes/<slug>/wish.md to catch missing sections before make."
---

# Plan Review - Validate Wish Documents

## Overview

Fast structural/quality check on wish documents before execution. Catches missing sections and weak criteria.

**Two verdicts: PASS / NEEDS ATTENTION**

---

## How to Run

1. Identify the wish file to validate (`.genie/wishes/<slug>/wish.md`)
2. Check all items below
3. Report PASS or NEEDS ATTENTION with fix list

---

## Validation Checklist

### Structure Completeness

- [ ] Has `## Summary` (2-3 sentences)
- [ ] Has `## Scope` with `### IN` and `### OUT`
- [ ] OUT scope is **not empty** (must explicitly exclude something)
- [ ] Has `## Success Criteria` with checkbox items (`- [ ]`)
- [ ] Has `## Execution Groups` with at least one `### Group`

### Task Quality (per execution group)

- [ ] Each group has `**Goal:**` (one sentence)
- [ ] Each group has `**Deliverables:**` list
- [ ] Each group has `**Acceptance Criteria:**` with checkboxes
- [ ] Each group has `**Validation:**` with a concrete command
- [ ] Tasks are specific (not "implement everything")
- [ ] Tasks are small enough for one focused session

### Scope Boundaries

- [ ] OUT contains explicit exclusions (not empty)
- [ ] IN and OUT do not contradict
- [ ] Scope is realistic for the task count

### Acceptance Criteria Quality

- [ ] Criteria are testable (can verify pass/fail)
- [ ] Criteria are specific (not "works correctly")
- [ ] Validation commands are executable

---

## Output Format

**If all checks pass:**

```
Plan review: PASS

Wish document is well-structured and ready for /make.
```

**If checks fail:**

```
Plan review: NEEDS ATTENTION

Structure:
- [ ] Missing OUT scope - add explicit exclusions

Task Quality:
- [ ] Group B missing validation command
- [ ] Group C acceptance criteria too vague ("works correctly")

Scope:
- [ ] IN/OUT contradiction: X is in both sections

Fix these issues, then run /plan-review again.
```

---

## Key Principles

- **Fast** - This is a gate check, seconds not minutes
- **Structure over content** - Check format, not design quality
- **Actionable feedback** - Every issue includes what to fix
- **Don't block on style** - Focus on missing/broken structure

---

## Never Do

- Modify the wish document (only report)
- Block on style/naming preferences
- Deep review of design quality (trust brainstorm/wish phases)
- Take more than 30 seconds to run
