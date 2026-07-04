---
name: genie-review
description: Review discipline for Genie wishes — SHIP / FIX-FIRST / BLOCKED verdicts with severity-tagged gaps and evidence against acceptance criteria.
---

# Genie Review Discipline

## Verdicts

Every review ends in exactly one verdict:

- `SHIP` — acceptance criteria met with evidence; residual gaps are LOW at
  most and explicitly listed.
- `FIX-FIRST` — shippable only after named fixes; every gap is severity-tagged
  (CRITICAL / HIGH / MEDIUM / LOW) with a concrete, actionable fix.
- `BLOCKED` — a CRITICAL gap or missing prerequisite prevents assessment;
  state exactly what unblocks it.

## Evidence against acceptance criteria

- Start from `genie_review_plan` — it returns wish status plus the Success
  Criteria and QA Criteria sections from `WISH.md`. Judge against those
  criteria, not vibes.
- Every gap cites evidence: a file path, a command output, or the failing
  criterion it violates.

## Independence

- Never self-review. The reviewer must not be the author of the work under
  review; if you produced the change, hand the review to another agent.
