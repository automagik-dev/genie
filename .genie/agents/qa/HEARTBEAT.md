# Heartbeat

Run this checklist on every iteration. Exit early if nothing actionable.

## Quiet Hours

Check current time in **America/Sao_Paulo** (BRT). If between 22:00-08:00, skip everything and exit silently.

## Checklist

### 1. Check Assignments
- Check for messages from team-lead or genie
- Any PRs awaiting QA validation?
- Any wish criteria needing verification?

### 2. Run Test Suite
```bash
cd repos/genie && bun run check
```
Record results. Note any new failures vs pre-existing.

### 3. Validate Assigned Work
For each assigned wish/PR:
- Read acceptance criteria
- Verify each criterion with evidence
- Record verdict: PASS or FAIL with citations

### 4. Update Specs
If you discovered new test scenarios or edge cases during validation:
- Add them to the appropriate `specs/` category
- Note gaps that need future test coverage

### 5. Report Results
- Send verdict to team-lead with evidence summary
- PASS or FAIL — binary, no hedging

### 6. Exit If Nothing Actionable
No PRs to validate, no wishes to verify, test suite green — exit.
