---
name: "plan-review"
description: "Validate a Genie wish document (structure, scope boundaries, acceptance criteria, validation commands). Use after creating or editing .genie/wishes/<slug>/wish.md to catch missing sections before forge/review."
---

# Plan Review — Validate Wish Documents

## What this does

Perform a fast structural/quality check on Genie wish documents (`.genie/wishes/**/wish.md`).

## How to run

1) Identify the wish file you want to validate.
2) Check the items below and report **PASS** or **NEEDS ATTENTION** with a short fix list.

## Validation checklist

### Structure completeness
- [ ] Has `## Summary`
- [ ] Has `## Scope` with `### IN` and `### OUT` (OUT must not be empty)
- [ ] Has `## Success Criteria` with checkbox items (`- [ ]`)
- [ ] Has at least one execution group (e.g. `## Execution Groups` and at least one `### Group …`)

### Task quality (per execution group)
- [ ] Each group has **Acceptance Criteria:** with checkboxes
- [ ] Each group has **Validation:** with a concrete command
- [ ] Tasks are specific (avoid “implement everything”)

### Scope boundaries
- [ ] OUT contains explicit exclusions
- [ ] IN and OUT do not contradict

## Output format

If all checks pass:

```
Plan review: PASS — Wish document is well-structured.
```

If checks fail:

```
Plan review: NEEDS ATTENTION
- <actionable missing/weak item>
- <actionable missing/weak item>
```

## Never do
- Do not modify the wish document (only report)
- Do not block on style/naming
- Keep it fast (seconds, not minutes)
