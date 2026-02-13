---
name: fix
description: "Handle FIX-FIRST verdicts from /review — dispatch fix subagent, re-review, escalate after 2 loops."
---

# /fix

Handle a FIX-FIRST verdict from `/review`. Dispatch fixes via subagent, then re-review.

**Max 2 loops. After that → BLOCKED → escalate to human.**

## Flow
1. **Load gaps:** parse the FIX-FIRST verdict — extract gap list with severity and files.
2. **Dispatch fixer:** send gaps + original wish context to a fix subagent.
3. **Re-review:** dispatch `/review` subagent to validate the fix.
4. **Check verdict:**
   - **SHIP** → done, return to orchestrator.
   - **FIX-FIRST** + loop < 2 → increment loop counter, go to step 2.
   - **FIX-FIRST** + loop = 2 → escalate (max reached).
   - **BLOCKED** → escalate immediately.
5. **Escalation (loop = 2 or BLOCKED):** mark task BLOCKED, report to orchestrator with remaining gaps.

## Subagent Dispatch

```
# Fix subagent
sessions_send(
  agentId: "<self>",
  sessionKey: "agent:<self>:fixer-<slug>-loop<N>",
  message: "Fix these gaps from /review of wish <slug>:\n<gap list>\nOriginal criteria: <criteria>",
  timeoutSeconds: 120
)

# Re-review subagent (use same pipeline as original review)
sessions_send(
  agentId: "<self>",
  sessionKey: "agent:<self>:reviewer-<slug>-loop<N>",
  message: "Review fix for wish <slug>. Pipeline: <original_pipeline>. Check: <gap list resolved?>",
  timeoutSeconds: 120
)
```

## Escalation

When loop limit (2) is exceeded:
- Mark task **BLOCKED** in wish.
- Report remaining gaps with exact files and failing checks.
- Message: `"Fix loop exceeded (2/2). Escalating to human. Remaining gaps: ..."`

## Rules
- Never fix and review in the same session — always separate subagents.
- Never exceed 2 fix loops — escalate, don't spin.
- Include original wish criteria in every fix dispatch for context.
- Each loop must show progress — if same gaps persist, escalate immediately.
