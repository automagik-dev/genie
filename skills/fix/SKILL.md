---
name: fix
description: "Dispatch fix subagent for FIX-FIRST gaps from /review, re-review, and escalate after 2 failed loops."
---

# /fix — Fix-Review Loop

Resolve FIX-FIRST gaps from `/review`. Dispatch a fix subagent, re-review, repeat up to 2 loops, then escalate.

## When to Use
- `/review` returned a **FIX-FIRST** verdict with CRITICAL or HIGH gaps
- Orchestrator hands off unresolved gaps after execution review

## Flow
1. **Parse gaps:** extract gap list from FIX-FIRST verdict — severity, files, failing checks.
2. **Dispatch fixer:** send gaps + original wish criteria to fix subagent.
3. **Re-review:** dispatch `/review` to validate the fix against the same pipeline.
4. **Evaluate verdict:**

| Verdict | Condition | Action |
|---------|-----------|--------|
| SHIP | — | Done. Return to orchestrator. |
| FIX-FIRST | loop < 2 | Increment loop, go to step 2. |
| FIX-FIRST | loop = 2 | Escalate — max loops reached. |
| BLOCKED | — | Escalate immediately. |

5. **Escalate (if needed):** mark task BLOCKED, report remaining gaps with exact files and failing checks.

## Escalation Format

```
Fix loop exceeded (2/2). Escalating to human.
Remaining gaps:
- [CRITICAL] <gap description> — <file>
- [HIGH] <gap description> — <file>
```

## Dispatch

Fix and re-review must be **separate dispatches** — never combine them in one subagent.

| Runtime | Detection | Fix dispatch | Re-review dispatch |
|---------|-----------|-------------|-------------------|
| Claude Code | `Task` tool available | `Task(model: "sonnet", isolation: "worktree", prompt: "<fix prompt>")` | `Task(model: "sonnet", isolation: "worktree", prompt: "<review prompt>")` |
| Codex | `CODEX_ENV` or native API | `codex_subagent(task: "<fix prompt>", sandbox: true)` | `codex_subagent(task: "<review prompt>", sandbox: true)` |
| OpenClaw | `term` CLI available | `term spawn --name "fixer-<slug>" --model sonnet` | `term spawn --name "reviewer-<slug>" --model sonnet` |

Default to **Claude Code** when detection is ambiguous.

## Rules
- Never fix and review in the same session — always separate subagents.
- Never exceed 2 fix loops — escalate, don't spin.
- Include original wish criteria in every fix dispatch.
- If identical gaps persist across loops, escalate immediately — no progress means BLOCKED.
