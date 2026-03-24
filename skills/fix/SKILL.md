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
3. **Re-review:** dispatch review subagent to validate the fix against the same pipeline.
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

```bash
# Spawn a fixer subagent
genie spawn fixer

# Spawn a reviewer subagent (separate from fixer)
genie spawn reviewer
```

## Task Lifecycle Integration (v4)

When a PG task exists for the work being fixed, log each fix attempt as a task comment:

| Event | Command |
|-------|---------|
| Fix attempt start | `genie task comment #<seq> "Fix loop 1/2: [gap summary]"` |
| Fix attempt result | `genie task comment #<seq> "Fix loop 1/2: [changes made]"` |
| Fix success | `genie task comment #<seq> "Fix complete — [summary of all changes]"` |
| Escalation (max loops) | `genie task block #<seq> --reason "Fix loop exceeded (2/2)"` |
| Escalation (no progress) | `genie task block #<seq> --reason "No progress — identical gaps across loops"` |

**Graceful degradation:** If no PG task exists for the work being fixed, skip all `genie task` commands. Fix loop logging is an enhancement — the fix flow must never fail due to missing tasks.

## Example

`/review` returned FIX-FIRST with 2 gaps:

```
- [CRITICAL] workDispatchCommand missing initialPrompt — dispatch.ts:532
- [HIGH] protocolRouter.sendMessage result not checked — dispatch.ts:541
```

The orchestrator runs `/fix`:

```bash
# Loop 1: dispatch fixer with gaps
genie spawn fixer
genie send 'Fix these gaps from /review on wish fix-dispatch-initial-prompt:
- [CRITICAL] dispatch.ts:532 — add initialPrompt to handleWorkerSpawn
- [HIGH] dispatch.ts:541 — check protocolRouter.sendMessage result, log warning on failure
Reference: qa-runner.ts:334 shows correct pattern.' --to fixer

# Wait for fixer to complete
sleep 60 && genie read fixer

# Re-review (separate subagent — never the same as fixer)
genie spawn reviewer
genie send 'Review wish fix-dispatch-initial-prompt. Check the fixer changes against acceptance criteria. Run bun test.' --to reviewer

# Reviewer returns SHIP → done
# If FIX-FIRST again → loop 2 (max 2 loops, then escalate)
```

## Rules
- Never fix and review in the same session — always separate subagents.
- Never exceed 2 fix loops — escalate, don't spin.
- Include original wish criteria in every fix dispatch.
- If identical gaps persist across loops, escalate immediately — no progress means BLOCKED.
