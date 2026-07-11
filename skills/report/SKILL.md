---
name: report
description: "Investigate bugs comprehensively — cascade through /trace, capture browser evidence, extract observability data, and auto-create a GitHub issue with all findings."
---

# /report — Comprehensive Bug Report and GitHub Issue Creation

Investigate a bug end-to-end: collect symptoms, run `/trace` for root cause, capture browser evidence when available, pull observability data from project-configured tools, and create a GitHub issue with all findings attached. Investigation only — the deliverable is findings, never fixes; `/report` must not modify source code.

## When to Use
- A bug needs a thorough, documented investigation before fixing
- A GitHub issue is needed with reproduction steps, root cause, and evidence
- A self-contained report is wanted that someone can act on without reproducing
- QA-loop failures against wish acceptance criteria need investigation

## QA Loop Integration

When invoked during the QA loop (after merge to dev):
1. Read the wish's criteria from `.genie/wishes/<slug>/WISH.md`.
2. Map each failure to the criterion it violates: `Criterion: "<text>" — FAIL`.
3. Chain: QA failure → `/report` → `/trace` → `/fix` → retest.

## Flow

### Phase 1: Collect Symptoms
Gather bug description (required), plus URL, error messages, and expected-vs-actual behavior when offered. If detail is missing, ask clarifying questions one at a time via native user-input surface — minimum viable input is a bug description.

### Phase 2: Run /trace (always)
The backbone of every report. Dispatch a trace subagent via the **native delegation surface** with a read-only brief: the symptoms, relevant files, and the expected deliverable (the `/trace` report format — root cause file:line, evidence, causal chain, recommended correction, affected scope, confidence). The subagent notifies you with its findings as its final message; follow-ups go through **native follow-up messaging**. If root cause cannot be determined, note "Code investigation incomplete — /trace could not determine root cause" and continue.

### Phase 3: Browser Evidence (opportunistic)
Requires the `agent-browser` CLI on PATH. Attempt when a URL was provided, a dev server is on a common port (3000, 3001, 4200, 5173, 5174, 8080, 8000), or `package.json` has a startable `dev`/`start` script.

| Command | Purpose |
|---------|---------|
| `agent-browser screenshot <url> [--full\|--annotate]` | Page evidence |
| `agent-browser record start <file>` | Video, only for multi-step reproduction |
| `agent-browser profiler start` / `stop` | Performance profile (perf bugs only) |

Also capture console errors/warnings and failed or slow network requests. Prefer screenshots over video. Unavailable → skip with note: "Browser evidence not available — no URL provided and no dev server detected."

### Phase 4: Observability Data (project-dependent)
Detect configured tools, pull recent related errors from each; integrations are independent — one failing never blocks the others.

| Tool | Detection | Pull via |
|------|-----------|----------|
| Sentry | `SENTRY_DSN`, `sentry.client.config.*`, `@sentry/*` in package.json | `sentry-cli issues list` or API |
| PostHog | `POSTHOG_KEY`, `posthog` dep | recent error events |
| DataDog | `DD_API_KEY`, `dd-trace` dep | APM traces |
| LogRocket | `LOGROCKET_APP_ID`, `logrocket` dep | session logs |
| Generic logs | `*.log`, `logs/` | grep recent entries |

Nothing found → skip with note: "No observability integrations detected in this project."

### Phase 5: Compile Report
Merge all evidence into the issue body per `references/issue-template.md`. Grounded evidence rule: every statement in the report traces to tool output from this investigation — trace findings, captured artifacts, command output. State per evidence source whether it was **captured**, **failed**, or **skipped** (and why); never present a planned capture as evidence.

### Phase 6: Create GitHub Issue
1. `gh auth status` — verify authentication.
2. `gh issue create --title '<title>' --body '<report>'` — single-quote and escape user-provided text to prevent shell injection.
3. Labels: `bug` + area labels derived from the top-level directory of affected files (`src/auth/` → `area:auth`, `components/` → `area:ui`, `routes/` → `area:api`, `__tests__/` → `area:tests`).
4. Not authenticated or creation fails → print the full report to stdout: "Could not create GitHub issue. Here is the report for manual submission."
5. If an identical open issue exists, link to it instead of creating a duplicate.

## Degradation Rules

Each phase is independent — failure in one never blocks the others. The report is always produced; the only question is how rich the evidence is.

| Condition | Behavior |
|-----------|----------|
| No browser / URL / dev server | Skip Phase 3, note why |
| No observability tooling | Skip Phase 4, note why |
| `/trace` inconclusive | Report with remaining evidence, note "investigation incomplete" |
| No `gh` auth | Print report to stdout |

## Board Tracking (optional)

The GitHub issue is the primary artifact. If the bug should also appear on the genie board:

```bash
genie task create --title "bug: <title> (gh#<issue-number>)"
```

If task creation fails (no `.genie/genie.db`), skip it — board tracking never blocks the report.

## Example

User reports: "dispatched engineers sit idle at an empty prompt."

1. Symptoms collected: command run, observed behavior (empty prompt, no task received).
2. Trace subagent dispatched (native delegation surface, read-only) → returns: `dispatch.ts:532 — handleWorkerSpawn called without initialPrompt; 4/6 engineers received no message. Confidence: high.`
3. Evidence captured: screenshot of the idle pane; `genie task list --json` showing the group `in_progress` with no progress.
4. Issue created: `gh issue create --title "bug: dispatch spawns engineers idle without initial task prompt" --body ...` — body carries root cause, causal chain, reproduction steps, and both artifacts.

## Rules
- Always run `/trace` first — it is the backbone of every report.
- One question at a time when collecting symptoms.
- Never modify source code — investigation only; hand corrections to `/fix`.
- Screenshots and video are evidence, not decoration — capture only what is relevant.
- Be explicit about what was not captured and why.
- The report must be self-contained — readable and actionable without reproducing the bug.
