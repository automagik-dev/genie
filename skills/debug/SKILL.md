---
name: debug
description: "Dispatch debug subagent to investigate unknown issues — reproduces, traces, and reports root cause for /fix handoff."
---

# /debug — Investigation and Root Cause Analysis

Investigate unknown failures. Dispatch a debug subagent to reproduce, trace, and isolate root cause — then hand the report to `/fix`.

## When to Use
- A failure exists but the cause is unknown
- Stack traces or error messages don't point to an obvious defect
- Multiple files or systems may be involved
- Orchestrator needs a diagnosis before dispatching a fix

## Flow
1. **Collect symptoms:** gather error messages, stack traces, logs, and expected vs actual behavior from the wish or reporter.
2. **Dispatch debugger:** send symptoms + relevant context (files, recent changes, environment) to the debug subagent.
3. **Investigate:** the debug subagent autonomously reproduces, hypothesizes, traces, and isolates root cause.
4. **Receive report:** structured diagnosis with root cause, evidence, recommended correction, and affected scope.
5. **Hand off:** pass the report to `/fix` or escalate to the orchestrator.

## Report Format

```
Root cause: <what's actually broken — file, line, condition>
Evidence: <reproduction steps, traces, proof>
Causal chain: <root cause → intermediate effects → observed symptom>
Recommended correction: <what to change, where, why>
Affected scope: <other files or features impacted>
Confidence: <high / medium / low>
```

## Dispatch

Debug must run in **isolation** — the subagent must not modify any source files.

| Runtime | Detection | Debug dispatch |
|---------|-----------|---------------|
| Claude Code | `Task` tool available | `Task(model: "sonnet", isolation: "worktree", prompt: "<debug prompt>")` |
| Codex | `CODEX_ENV` or native API | `codex_subagent(task: "<debug prompt>", sandbox: true)` |
| OpenClaw | `genie` CLI available | `genie worker spawn --role debugger` |

Default to **Claude Code** when detection is ambiguous.

## Rules
- Never fix during debug — investigation only, always separate from correction.
- Always reproduce before theorizing — if the failure can't be reproduced, the report must say so.
- Evidence required — every root cause claim must include file paths, line numbers, and a causal chain.
- Hand off to `/fix` — debug produces a report, `/fix` applies the correction. Never combine them.
- Read-only tools — debug subagent uses Read, Bash, Glob, Grep. No Write, no Edit.
- If root cause spans multiple systems, report each separately with confidence levels.
