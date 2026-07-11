---
name: fix
description: "Dispatch fix subagent for FIX-FIRST gaps from review, re-review, then diagnose unresolved failures after 2 loops."
---

# fix — Fix-Review Loop

**Runtime syntax:** in Codex, invoke the plugin copy with the owner-qualified `$genie:<skill>` selector; use bare `$<skill>` only for a separately installed personal copy. Claude Code and Hermes use `/<skill>`. Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active tier.

Resolve FIX-FIRST gaps from `review`: dispatch a fix subagent, re-review, repeat up to 2 loops, then diagnose and route any unresolved failure.

## When to Use
- `review` returned a **FIX-FIRST** verdict with CRITICAL or HIGH gaps
- Orchestrator hands off unresolved gaps after execution review

## Flow
1. **Parse gaps:** severity, files, failing checks from the FIX-FIRST verdict.
2. **Dispatch fixer:** native delegation surface → fix subagent, briefed with the gap list, the original wish criteria, and any `trace` diagnosis.
3. **Re-review:** native delegation surface → a separate reviewer subagent (never the fixer) running `review` on the same pipeline.
4. **Evaluate verdict:**

| Verdict | Condition | Action |
|---------|-----------|--------|
| SHIP | — | Done. Return to orchestrator. |
| FIX-FIRST | loop < 2 | Increment loop, go to step 2. |
| FIX-FIRST | loop = 2 | Stop fixing and run Escalation Diagnosis; max loops reached. |
| BLOCKED | — | Run Escalation Diagnosis and take the cause-specific route. |

5. **Route the diagnosis:** report the remaining gaps with exact files, failing checks, cause class, and corrective route; the group's task stays `in_progress`.

## Dispatch

Fix and re-review are **separate native-dispatch dispatches** — never combined in one subagent, and the re-reviewer is never the fixer. Subagents notify on completion — no polling. Follow-ups to a running fixer go through native follow-up messaging.

The fixer's brief must carry: the severity-tagged gaps (file:line), the original wish acceptance criteria, the validation command(s) to re-run, and stop conditions — fix only the listed gaps; report blocked rather than expand scope.

## Escalation Diagnosis

Use this policy before any model or effort change; keep this contract identical in `fix`, `review`, and `work`.

| Cause | Diagnostic evidence | Corrective route |
|-------|---------------------|------------------|
| `model-capacity` | The supplied context is complete, the spec is decidable, the environment works, and attempt output shows the assigned model or effort still cannot perform the reasoning. | May raise model or effort one step, but only with new evidence and available caps. |
| `missing-context` | The attempt identifies absent files, history, criteria, logs, or other inputs needed to decide. | Supply the missing context and retry at the same model and effort; MUST NOT escalate model or effort. |
| `ambiguous-spec` | Two or more materially different behaviors remain consistent with the stated criteria. | Request a human decision or wish clarification; MUST NOT escalate model or effort. |
| `env-tool-failure` | A reproducible environment, dependency, permission, timeout, or tool error prevents valid execution. | Repair or retry the environment/tool, or report blocked with the error; MUST NOT escalate model or effort. |

Escalation eligibility requires **new evidence** produced since the previous attempt: attach the new failing output or diagnostic result, the correction already tried, and why it rules out the other three causes. A repeated verdict or unchanged failure is not new evidence and cannot authorize a model or effort change.

Model and reasoning effort belong in the active runtime's session or named-agent configuration, never in skill frontmatter. Inherit the active model by default. Only an evidenced `model-capacity` diagnosis may justify one higher-effort fresh agent, with at most two escalation attempts per group. The runtime's highest supported effort is appropriate only for a final gate or similarly demanding review when the user requested it or the evidence warrants it. Further escalation requires an explicit human decision recorded with the wish/group, old and new settings, reason, approver, and timestamp.

If an ordinary reviewer and the `final-gate` disagree, log an appeal with the wish/group, both verdicts and evidence, the contested criterion, and the human resolution. Neither verdict silently overrides the other, and the group remains `in_progress` until the appeal is resolved.

## Task State

The fix loop never mutates task state. The group's task stays `in_progress` through every loop; the orchestrator calls `genie task done <task-id>` only after a clean re-review. During any diagnosed route or appeal, the task remains `in_progress` with the remaining gaps recorded in the wish notes/handoff. If no task row exists for the work, proceed — the loop runs off the review verdict alone.

## Diagnosis / Appeal Format

```
Fix loop exhausted (2/2). Group remains in progress.
Remaining gaps:
- [CRITICAL] <gap description> — <file>
- [HIGH] <gap description> — <file>
Cause: <model-capacity|missing-context|ambiguous-spec|env-tool-failure>
New evidence: <new output/diagnosis, or "none — model/effort escalation prohibited">
Corrective route: <one cause-specific next step>
Budget: attempts=<used>/2; effort_escalations=<used>/2
Appeal: <reviewer/final-gate disagreement record, or "none">
```

## Example

`review` returned FIX-FIRST with:

```
- [CRITICAL] workDispatchCommand missing initialPrompt — dispatch.ts:532
- [HIGH] sendMessage result not checked — dispatch.ts:541
```

Loop 1: native delegation surface → fixer briefed with both gaps, the wish criteria, and `bun test` as validation. The fixer edits, runs the validation, reports its changes with outcomes, and ends `done`. Then native delegation surface → a fresh reviewer briefed to re-run `review` against the same criteria. SHIP → report success to the orchestrator. FIX-FIRST again → loop 2; after that, classify the cause and take its corrective route. A model or effort raise is permitted only for evidenced `model-capacity` within both caps.

## Rules
- Tight scope: fix exactly the tagged gaps — no unrequested refactors, features, or drive-by cleanups.
- Never fix and review in the same session — always separate subagents.
- Never exceed 2 fix loops — stop, diagnose, and take the cause-specific route.
- Include the original wish criteria in every fix dispatch.
- Identical gaps across loops = no progress; classify the cause. Repetition is not new evidence and never authorizes a model or effort raise.
- Grounded progress: report only what tool output from this session verifies — state what was fixed, what failed, what was skipped. Never report an attempted fix as complete.

## Session close (required)

When spawned as a native subagent, your final message IS the completion signal — the orchestrator is notified when you finish; do not poll or emit a separate contract call. End with exactly one terminal outcome as the last word:

- **done** — gaps resolved and re-review returned SHIP. Report evidence (validation output, loop count).
- **blocked** — needs human input or an unblocking signal (including max loops exceeded). State exactly what.
- **failed** — aborted or irrecoverable. State why.

`blocked` / `failed` must include a one-line reason.
