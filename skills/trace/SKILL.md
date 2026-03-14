---
name: trace
description: "Dispatch trace subagent to investigate unknown issues — reproduces, traces, and reports root cause for /fix handoff."
---

# /trace — Investigation and Root Cause Analysis

Investigate unknown failures. Dispatch a trace subagent to reproduce, trace, and isolate root cause — then hand the report to `/fix`.

## When to Use
- A failure exists but the cause is unknown
- Stack traces or error messages don't point to an obvious defect
- Multiple files or systems may be involved
- Orchestrator needs a diagnosis before dispatching a fix

## Flow
1. **Collect symptoms:** gather error messages, stack traces, logs, and expected vs actual behavior from the wish or reporter.
2. **Dispatch tracer:** send symptoms + relevant context (files, recent changes, environment) to the trace subagent.
3. **Investigate:** the trace subagent autonomously reproduces, hypothesizes, traces, and isolates root cause.
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

Trace must run in **isolation** — the subagent must not modify any source files.

```bash
# Spawn a tracer subagent (read-only investigation)
genie spawn tracer
```

## Rules
- Never fix during trace — investigation only, always separate from correction.
- Always reproduce before theorizing — if the failure can't be reproduced, the report must say so.
- Evidence required — every root cause claim must include file paths, line numbers, and a causal chain.
- Hand off to `/fix` — trace produces a report, `/fix` applies the correction. Never combine them.
- Read-only tools — trace subagent uses Read, Bash, Glob, Grep. No Write, no Edit.
- If root cause spans multiple systems, report each separately with confidence levels.
