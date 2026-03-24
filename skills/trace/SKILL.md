---
name: trace
description: "Dispatch trace subagent to investigate unknown issues — reproduces, traces, and reports root cause for /fix handoff. Use when you need to debug an error, investigate a bug, figure out why something is failing, trace a root cause, or can't figure out why unexpected behavior is happening."
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
4. **Signal findings:** tracer reports findings back to the leader via `genie send '<diagnosis summary>' --to <leader>`.
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
genie spawn tracer
```

### Spawn Example with Context

When dispatching the tracer, pass symptoms and relevant context so it can begin investigating immediately:

```bash
# Spawn tracer with symptoms and affected files
genie spawn tracer --message "Auth middleware returns 401 for valid tokens. \
  Error: 'TokenExpiredError: jwt expired' in src/middleware/auth.ts:47. \
  Started after commit abc1234. Expected: valid JWTs accepted. Actual: all requests rejected."
```

### Example Investigation Commands

The tracer subagent uses read-only tools to isolate root cause. Typical investigation steps:

```bash
# Search for the error origin across the codebase
grep -r "TokenExpiredError" src/ --include="*.ts" -n

# Check recent changes to the affected file
git log --oneline -10 -- src/middleware/auth.ts

# Diff the suspect commit to see what changed
git diff abc1234~1..abc1234 -- src/middleware/auth.ts

# Search for related configuration (e.g. token expiry settings)
grep -rn "expiresIn\|maxAge\|TOKEN_TTL" src/ --include="*.ts"

# Trace the call chain from the failing function
grep -rn "verifyToken\|validateJWT" src/ --include="*.ts"
```

## Rules
- Never fix during trace — investigation only, always separate from correction.
- Always reproduce before theorizing — if the failure can't be reproduced, the report must say so.
- Evidence required — every root cause claim must include file paths, line numbers, and a causal chain.
- Hand off to `/fix` — trace produces a report, `/fix` applies the correction. Never combine them.
- Read-only tools — trace subagent uses Read, Bash, Glob, Grep. No Write, no Edit.
- If root cause spans multiple systems, report each separately with confidence levels.
