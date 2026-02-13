---
name: review
description: "Universal reviewer for plans and execution - validates readiness and returns SHIP/FIX-FIRST/BLOCKED with actionable gaps."
---

# /review

Universal review gate for wish plans, execution output, and PR readiness.

## Modes
- **Plan review:** validate wish structure/scope before execution.
- **Execution review:** validate completed /work results against criteria.
- **PR review:** final ship check before merge.

## Flow
1. Detect review target (wish draft, in-progress wish, or PR diff).
2. Audit criteria one-by-one with explicit evidence.
3. Run listed validation commands and capture pass/fail output.
4. Perform quality pass (security, correctness, maintainability, regressions).
5. Classify gaps: CRITICAL / HIGH / MEDIUM / LOW.
6. Return verdict:
   - **SHIP:** no CRITICAL/HIGH gaps, validations pass.
   - **FIX-FIRST:** fixable HIGH gaps or failing validations.
   - **BLOCKED:** scope/architecture issue requiring wish revision.
7. Write actionable next steps (exact fixes, files, commands).

## Rules
- Never mark PASS without evidence.
- Never ship with CRITICAL/HIGH gaps.
- Never implement fixes during /review.
- Keep review output concise, prioritized, and executable.
