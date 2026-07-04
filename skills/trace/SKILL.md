---
name: trace
description: "Dispatch trace subagent to investigate unknown issues — reproduces, traces, and reports root cause for /fix handoff."
---

# /trace — Investigation and Root Cause Analysis

Investigate unknown failures: dispatch a trace subagent to reproduce, trace, and isolate root cause, then hand the report to `/fix`. The deliverable is findings only — report and stop; never apply fixes, however obvious.

## When to Use
- A failure exists but the cause is unknown
- Stack traces or error messages don't point to an obvious defect
- Multiple files or systems may be involved
- `/review` hit a failure with unclear root cause and needs a diagnosis before `/fix`

## Flow
1. **Collect symptoms:** error messages, stack traces, logs, and expected vs actual behavior from the wish or reporter.
2. **Dispatch tracer:** Agent tool → trace subagent, briefed with the symptoms, relevant context (files, recent changes, environment), and read-only stop conditions (see Dispatch).
3. **Investigate:** the tracer reproduces, hypothesizes, traces, and isolates root cause autonomously.
4. **Receive report:** the tracer's final message is the diagnosis (format below); the native team notifies you on completion — no polling.
5. **Hand off:** pass the report to `/fix`, or escalate to the orchestrator.

## Report Format

```
Root cause: <what's actually broken — file, line, condition>
Evidence: <reproduction steps, traces, proof>
Causal chain: <root cause → intermediate effects → observed symptom>
Recommended correction: <what to change, where, why>
Affected scope: <other files or features impacted>
Confidence: <high / medium / low>
```

Include file paths and line numbers in every root-cause claim so `/fix` can act without re-investigating. If root cause spans multiple systems, report each separately with its own confidence level.

## Dispatch

Trace runs in **isolation**: the subagent is read-only (Read, Bash, Glob, Grep — no Write, no Edit) and must not modify any source file. Spawn via the Agent tool; follow-ups to a running tracer go through SendMessage.

## Rules
- Report findings and stop — investigation only. `/fix` applies the correction; never combine the two.
- Reproduce before theorizing — if the failure can't be reproduced, the report must say so.
- Evidence required: every root-cause claim carries file paths, line numbers, and a causal chain grounded in tool output from this session — never inferred from memory.
- **Verify symbols before citing them.** Confirm every function named in "Recommended correction" via `grep -n "export.*<name>"` against the actual file — a hallucinated name sends `/fix` into a failing type-check and wastes a fix loop.

## Session close (required)

When spawned as a native-team subagent, your final message IS the completion signal — the orchestrator is notified when you finish; do not poll or emit a separate contract call. End with exactly one terminal outcome as the last word:

- **done** — diagnosis delivered in the Report Format with root cause, evidence, and confidence.
- **blocked** — cannot proceed (unreproducible without missing access, environment unavailable). State exactly what you need.
- **failed** — aborted or irrecoverable. State why.

`blocked` / `failed` must include a one-line reason.
