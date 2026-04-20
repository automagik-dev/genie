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
- `/review` encounters a failure with unclear root cause and invokes `/trace` for investigation

## Flow
1. **Collect symptoms:** gather error messages, stack traces, logs, and expected vs actual behavior from the wish or reporter.
2. **Dispatch tracer:** the spawned agent IS the tracer — it performs a read-only inline investigation. Send symptoms + relevant context (files, recent changes, environment).
3. **Investigate:** the tracer autonomously reproduces, hypothesizes, traces, and isolates root cause.
4. **Signal findings:** tracer reports findings back to the leader via `genie agent send '<diagnosis summary>' --to <leader>`.
5. **Receive report:** structured diagnosis with root cause, evidence, recommended correction, and affected scope.
6. **Hand off:** pass the report to `/fix` or escalate to the orchestrator.

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
genie agent spawn tracer
```

## Task Lifecycle Integration (v4)

When a PG task exists for the work being investigated, log findings as task comments:

| Event | Command |
|-------|---------|
| Investigation start | `genie task comment #<seq> "Trace: investigating — [symptom summary]"` |
| Root cause found | `genie task comment #<seq> "Root cause: [summary] — [file:line]"` |
| Multiple causes | `genie task comment #<seq> "Root causes: [count] identified — see trace report"` |
| Investigation failed | `genie task comment #<seq> "Trace: could not determine root cause — [reason]"` |

Include file paths and line numbers in every root cause comment so the task history is actionable without reading the full report.

**Graceful degradation:** If no PG task exists for the investigated work, skip all `genie task` commands. Findings logging is an enhancement — the trace flow must never fail due to missing tasks.

## Example

An engineer reports that `genie work` dispatches engineers but they sit idle. The orchestrator runs `/trace`:

```bash
# 1. Spawn a tracer (read-only — no code changes)
genie agent spawn tracer

# 2. Send the symptoms
genie agent send 'Trace: genie work dispatches engineers but they start idle at the prompt. No task received. genie wish status shows in_progress but nothing happens. Check dispatch.ts workDispatchCommand and protocol-router.ts sendMessage.' --to tracer

# 3. Wait for findings
sleep 60 && genie agent log tracer --raw
```

The tracer investigates and reports back:

```
Root cause: workDispatchCommand (dispatch.ts:532) spawns without initialPrompt
Evidence: protocolRouter.sendMessage fails silently under concurrent dispatch — 4/6 engineers got no message
Causal chain: missing initialPrompt → agent starts with empty prompt → no task → idle forever
Recommended correction: add initialPrompt to handleWorkerSpawn in dispatch.ts
Affected scope: brainstormCommand, wishCommand, workDispatchCommand, reviewCommand
Confidence: high
```

The orchestrator then hands the report to `/fix`.

## Rules
- Never fix during trace — investigation only, always separate from correction.
- Always reproduce before theorizing — if the failure can't be reproduced, the report must say so.
- Evidence required — every root cause claim must include file paths, line numbers, and a causal chain.
- Hand off to `/fix` — trace produces a report, `/fix` applies the correction. Never combine them.
- Read-only tools — trace subagent uses Read, Bash, Glob, Grep. No Write, no Edit.
- If root cause spans multiple systems, report each separately with confidence levels.

## Turn close (required)

Every session MUST end by writing a terminal outcome to the turn-session contract. This is how the orchestrator reconciles executor state — skipping it leaves the row open and blocks auto-resume.

- `genie done` — work completed, acceptance criteria met
- `genie blocked --reason "<why>"` — stuck, needs human input or an unblocking signal
- `genie failed --reason "<why>"` — aborted, irrecoverable error, or cannot proceed

Rules:
- Call exactly one close verb as the last action of the session.
- `blocked` / `failed` require `--reason`.
- `genie done` inside an agent session (GENIE_AGENT_NAME set) closes the current executor; it does not require a wish ref.
