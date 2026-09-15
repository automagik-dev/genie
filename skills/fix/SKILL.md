---
name: fix
description: "Resolve blocking review gaps through bounded repairs and independent re-review; diagnose stalled attempts without expanding scope."
---

# Fix

Given a FIX-FIRST review, the original criteria, and validation commands, dispatch a fixer for the blocking gaps and a different reviewer for the result. The fixer changes only the assigned scope. Reuse the existing worker context when appropriate; a reviewer never reviews its own edits.

## Repair budget

Resolve `B` once per group: default 2, or another positive integer explicitly supplied by a higher-priority user/workspace instruction. Carry `B`, attempts used, and effort-escalation counters across handoffs. Switching skills or correcting a diagnosis never resets them. An override does not expand scope, permit unchanged retries, or skip diagnosis or independent re-review.

1. Diagnose the failure before choosing a repair. An `overdesigned-plan` returns to planning without consuming a fix attempt.
2. Dispatch the fixer with the gap evidence, criteria, owned files, validation, and remaining budget.
3. Run the relevant checks and independent `review` after each repair; record the evidence and attempt count.
4. SHIP returns to the caller. FIX-FIRST may repeat up to `B` loops only with a changed approach or new evidence. At the cap, on unchanged failure, or on BLOCKED, take the diagnostic route below.

## Escalation Diagnosis

| Cause | Required response |
|---|---|
| `missing-context` | Obtain the absent files, logs, history, or criteria; keep model/effort unchanged. |
| `ambiguous-spec` | Resolve the competing interpretations with the user or plan owner. |
| `env-tool-failure` | Repair the demonstrated environment/tool problem or report its exact blocker. |
| `overdesigned-plan` | Remove or defer machinery lacking a present requirement or measurement; return to design/plan review. Do not spend retries defending it. |
| `model-capacity` | Only after ruling out the other causes with new evidence may model/effort increase one step in runtime configuration. Inherit the active model otherwise. |

Allow at most two escalation attempts per group. More requires an explicit human decision recorded with group, old/new settings, evidence, approver, and timestamp. Repeated verdicts are not new evidence and do not grant more repairs. A user-approved simplification invalidates superseded design/plan evidence and requires fresh review.

If reviewers disagree, record both verdicts, the contested criterion, evidence, and human resolution. Do not silently override either verdict.

## Handoff

Return resolved and remaining gaps with file locations, checks and results, cause and next route, `attempts=<used>/B`, and `effort_escalations=<used>/2`. Report any unresolved review disagreement.

The fixer never changes task status and posts nothing to the card. The group stays `in_progress` through repair and review; only its coordinator marks it done after SHIP and passing validation. Each re-review verdict is relayed to the card by the coordinator as one `genie task comment <task-id> --worker orchestrator -- 'review: … — …'`; an exhausted loop or diagnosed route gets one `blocked: <cause> — <route>` comment. Without a task row, use the review evidence directly. Continue independent groups while one group is blocked.
