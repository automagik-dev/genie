---
name: fix
description: "Dispatch fix subagent for FIX-FIRST gaps from /review, re-review, and escalate after 2 failed loops."
---

# /fix — Fix-Review Loop

Resolve FIX-FIRST gaps from `/review`: dispatch a fix subagent, re-review, repeat up to 2 loops, then escalate.

## When to Use
- `/review` returned a **FIX-FIRST** verdict with CRITICAL or HIGH gaps
- Orchestrator hands off unresolved gaps after execution review

## Flow
1. **Parse gaps:** severity, files, failing checks from the FIX-FIRST verdict.
2. **Dispatch fixer:** Agent tool → fix subagent, briefed with the gap list, the original wish criteria, and any `/trace` diagnosis.
3. **Re-review:** Agent tool → a separate reviewer subagent (never the fixer) running `/review` on the same pipeline.
4. **Evaluate verdict:**

| Verdict | Condition | Action |
|---------|-----------|--------|
| SHIP | — | Done. Return to orchestrator. |
| FIX-FIRST | loop < 2 | Increment loop, go to step 2. |
| FIX-FIRST | loop = 2 | Escalate — max loops reached. |
| BLOCKED | — | Escalate immediately. |

5. **Escalate (if needed):** report the remaining gaps with exact files and failing checks; the group's task stays `in_progress`.

## Dispatch

Fix and re-review are **separate Agent-tool dispatches** — never combined in one subagent, and the re-reviewer is never the fixer. Subagents notify on completion — no polling. Follow-ups to a running fixer go through SendMessage.

The fixer's brief must carry: the severity-tagged gaps (file:line), the original wish acceptance criteria, the validation command(s) to re-run, and stop conditions — fix only the listed gaps; report blocked rather than expand scope.

## Task State

The fix loop never mutates task state. The group's task stays `in_progress` through every loop; the orchestrator calls `genie task done <task-id>` only after a clean re-review. On escalation the task remains `in_progress` with the remaining gaps recorded in the wish notes/handoff. If no task row exists for the work, proceed — the loop runs off the review verdict alone.

## Escalation Format

```
Fix loop exceeded (2/2). Escalating to human.
Remaining gaps:
- [CRITICAL] <gap description> — <file>
- [HIGH] <gap description> — <file>
```

## Example

`/review` returned FIX-FIRST with:

```
- [CRITICAL] workDispatchCommand missing initialPrompt — dispatch.ts:532
- [HIGH] sendMessage result not checked — dispatch.ts:541
```

Loop 1: Agent tool → fixer briefed with both gaps, the wish criteria, and `bun test` as validation. The fixer edits, runs the validation, reports its changes with outcomes, and ends `done`. Then Agent tool → a fresh reviewer briefed to re-run `/review` against the same criteria. SHIP → report success to the orchestrator. FIX-FIRST again → loop 2; after that, escalate.

## Rules
- Tight scope: fix exactly the tagged gaps — no unrequested refactors, features, or drive-by cleanups.
- Never fix and review in the same session — always separate subagents.
- Never exceed 2 fix loops — escalate, don't spin.
- Include the original wish criteria in every fix dispatch.
- Identical gaps across loops = no progress = escalate immediately as BLOCKED.
- Grounded progress: report only what tool output from this session verifies — state what was fixed, what failed, what was skipped. Never report an attempted fix as complete.

## Session close (required)

When spawned as a native-team subagent, your final message IS the completion signal — the orchestrator is notified when you finish; do not poll or emit a separate contract call. End with exactly one terminal outcome as the last word:

- **done** — gaps resolved and re-review returned SHIP. Report evidence (validation output, loop count).
- **blocked** — needs human input or an unblocking signal (including max loops exceeded). State exactly what.
- **failed** — aborted or irrecoverable. State why.

`blocked` / `failed` must include a one-line reason.
