---
name: report
description: "Investigate bugs comprehensively — cascade through /trace, capture browser evidence, extract observability data, and auto-create a GitHub issue with all findings."
---

# /report — Comprehensive Bug Report and GitHub Issue Creation

Investigate bugs end-to-end: collect symptoms, run `/trace` for root cause analysis, capture browser evidence when available, pull observability data from project-configured tools, and auto-create a GitHub issue with all findings attached.

## When to Use
- A bug needs a thorough, documented investigation before fixing
- A GitHub issue is needed with reproduction steps, root cause, and evidence
- Multiple evidence sources (code, browser, observability) should be combined into one report
- Orchestrator or user wants a self-contained bug report that someone can act on without reproducing
- During QA loop: test failures against wish acceptance criteria need investigation

## Dependencies

- **`agent-browser`** — required for browser-based evidence capture (screenshots, console logs, network requests). Install separately: `agent-browser` must be on PATH for Phase 3 to work. If unavailable, Phase 3 degrades gracefully.

## QA Loop Integration

When invoked during the QA loop (after merge to dev), link findings to wish acceptance criteria:

1. Read the wish's success criteria from `.genie/wishes/<slug>/WISH.md`.
2. For each QA failure, map it to the specific acceptance criterion it violates.
3. Include the criterion reference in the report: `Criterion: "<criterion text>" — FAIL`.

**Auto-invocation chain for QA failures:**
```
QA failure → /report (investigate + document) → /trace (root cause) → /fix (correct) → retest
```

## Flow

### Phase 1: Collect Symptoms

Accept user input for the bug investigation:
- **Bug description:** what's going wrong
- **URL (optional):** page or endpoint where the bug manifests
- **Error messages:** any error text, stack traces, or console output
- **Expected vs actual behavior:** what should happen vs what does happen

If no details are provided, ask clarifying questions **one at a time** via AskUserQuestion. Never batch questions. Minimum viable input: a bug description.

### Phase 2: Run /trace (Code-Level Investigation)

This phase is **ALWAYS** run — it is the foundation of every report.

1. Dispatch the `/trace` skill with the collected symptoms.
2. `/trace` performs: source analysis, reproduction, root cause hypothesis, causal chain construction.
3. Collect the trace report:
   - **Root cause:** file, line, condition
   - **Evidence:** reproduction steps, traces, proof
   - **Causal chain:** root cause -> intermediate effects -> observed symptom
   - **Recommended correction:** what to change, where, why
   - **Affected scope:** other files or features impacted
   - **Confidence:** high / medium / low

If `/trace` fails or cannot determine root cause, note in the report: "Code investigation incomplete — /trace could not determine root cause." Continue with remaining phases.

### Phase 3: Browser Investigation (Opportunistic)

**Detection — check if browser investigation is possible:**
- User provided a URL
- A dev server is running on common ports: 3000, 3001, 4200, 5173, 5174, 8080, 8000
- `package.json` has a `dev` or `start` script that could be started

**If browser is available**, use agent-browser capabilities:

| Command | Purpose |
|---------|---------|
| `agent-browser screenshot <url>` | Screenshot of affected page |
| `agent-browser screenshot <url> --full` | Full page screenshot |
| `agent-browser screenshot <url> --annotate` | Annotated with element labels |
| `agent-browser record start <file>` | Video recording of reproduction steps |
| `agent-browser profiler start` / `agent-browser profiler stop` | Performance profile (if perf-related) |

Also capture:
- **Console logs:** errors and warnings from the page
- **Network requests:** failed requests, slow requests, error responses

Prefer screenshots over video — smaller, easier to embed in issues. Only record video when reproduction requires multi-step interaction.

**If browser is NOT available**, skip this phase and note in report:
> "Browser evidence not available — no URL provided and no dev server detected."

### Phase 4: Observability Data (Project-Dependent)

**Detection — check project for configured observability tools:**

| Tool | Detection signals |
|------|------------------|
| **Sentry** | `SENTRY_DSN` env var, `sentry.client.config.*` files, `@sentry/*` in package.json |
| **PostHog** | `POSTHOG_KEY` env var, `posthog` in package.json |
| **DataDog** | `DD_API_KEY` env var, `dd-trace` in package.json |
| **LogRocket** | `LOGROCKET_APP_ID` env var, `logrocket` in package.json |
| **Generic logs** | `*.log` files, `logs/` directory |

**If found**, use available CLI/API to pull recent errors:
- Sentry: `sentry-cli issues list --project <project>` or API via curl
- PostHog: query recent error events
- DataDog: query APM traces
- Generic logs: search recent entries for related error patterns

Each integration is independent — if one fails, continue with others.

**If nothing found**, skip this phase and note in report:
> "No observability integrations detected in this project."

### Phase 5: Compile Report

Merge all evidence into a structured GitHub issue body using this template:

```markdown
## Bug Report: <title>

### Summary
<1-2 sentence description of the bug>

### Reproduction Steps
1. <step 1>
2. <step 2>
3. <step 3>

### Expected Behavior
<what should happen>

### Actual Behavior
<what happens instead>

### Root Cause Analysis
**Source:** `/trace` investigation
**File:** `<path>:<line>`
**Cause:** <description>
**Causal chain:** <root cause> -> <intermediate effects> -> <observed symptom>
**Confidence:** <high/medium/low>

### Evidence

#### Screenshots
<embedded screenshots from agent-browser, if captured>

#### Console Logs
<captured console errors/warnings, if available>

#### Network
<failed requests, timing issues, error responses, if captured>

#### Performance
<performance anomalies, if profiled>

#### Observability
<Sentry errors, PostHog events, DataDog traces, if available>

### Environment
- **OS:** <detected via process.platform>
- **Runtime:** <node/bun version>
- **Browser:** <if applicable>
- **Key dependencies:** <relevant package versions>

### Suggested Fix
<from /trace recommendation>

---
*Generated by genie `/report`*
```

For each evidence section that was skipped, include a note explaining why (e.g., "No dev server detected", "Sentry not configured in this project"). This helps the fixer know what to investigate further.

### Phase 6: Create GitHub Issue

1. Check `gh auth status` — verify GitHub CLI is authenticated.
2. If authenticated: run `gh issue create --title '<title>' --body '<report body>'` with labels. Always use single quotes and escape internal single quotes to prevent shell injection from user-provided text.
3. **Labels:** `bug` + auto-detected area labels based on affected files:
   - Files in `src/auth/` or `lib/auth/` -> `area:auth`
   - Files in `src/ui/` or `components/` -> `area:ui`
   - Files in `src/api/` or `routes/` -> `area:api`
   - Files in `tests/` or `__tests__/` -> `area:tests`
   - Derive area from the top-level directory of affected files
4. If `gh` is not authenticated or issue creation fails, print the full report as markdown to stdout with:
   > "Could not create GitHub issue. Here is the report for manual submission."

## Degradation Rules

Each phase is independent — failure in one **never** blocks the others.

| Condition | Behavior |
|-----------|----------|
| No browser / no URL / no dev server | Skip Phase 3, add note |
| No observability tools configured | Skip Phase 4, add note |
| No `gh` auth | Print report to stdout as fallback |
| `/trace` fails | Still produce report with available evidence, note "Code investigation incomplete" |
| Individual observability tool fails | Skip that tool, continue with others |

The report must always be produced. The only question is how rich the evidence is.

## Dispatch

Report orchestrates multiple tools but must **never modify source code** — investigation only.

```bash
# Spawn a tracer subagent for investigation
genie agent spawn tracer
```

Browser dispatch uses direct `agent-browser` commands alongside the trace subagent.

## Task Lifecycle Integration (v4)

After creating the GitHub issue, also create a PG task to track the bug in the task system:

| Event | Command |
|-------|---------|
| Bug task creation | `genie task create "<bug title>" --type software --tags bug --priority <severity>` |
| Link GitHub issue | `genie task comment #<seq> "GitHub: <issue-url>"` |
| Link trace findings | `genie task comment #<seq> "Root cause: <summary> — <file:line>"` |
| QA criterion failure | `genie task comment #<seq> "Criterion FAIL: <criterion text>"` |

Priority mapping from severity:

| Severity | Priority |
|----------|----------|
| CRITICAL | `--priority critical` |
| HIGH | `--priority high` |
| MEDIUM | `--priority medium` |
| LOW | `--priority low` |

**Graceful degradation:** If PG is unavailable, skip `genie task` commands. The GitHub issue is the primary artifact — PG task tracking is an enhancement. The report must always be produced regardless of PG availability.

## Example

User reports: "genie work dispatches engineers but they sit idle."

The report agent:

```bash
# 1. Collect symptoms (one question at a time)
# Agent asks: "What command did you run?" → "genie team create rlmx --wish tauri-docs-agent"
# Agent asks: "What did you see?" → "Engineers show welcome screen but empty prompt"

# 2. Run /trace
genie agent spawn tracer
genie agent send 'Trace: genie work dispatches engineers but they start idle. Check dispatch.ts and protocol-router.ts.' --to tracer
# Wait for diagnosis...

# 3. Capture evidence
# Screenshot of idle engineer pane showing empty ❯ prompt
# Output of: genie wish status <slug> showing "in_progress" but no actual progress

# 4. Create GitHub issue with all findings
gh issue create --title "bug: genie work dispatch — engineers spawn idle without initial task prompt" --body "$(cat <<'EOF'
## Summary
Engineers dispatched by genie work start idle because initialPrompt is missing from handleWorkerSpawn.

## Root Cause (from /trace)
dispatch.ts:532 — handleWorkerSpawn called without initialPrompt.
protocolRouter.sendMessage fails silently under concurrent dispatch (4/6 engineers got no message).

## Evidence
- [Screenshot: idle engineer pane]
- genie wish status shows in_progress but engineers at empty prompt
- Native inbox files: engineer-1 through engineer-4 have no dispatch message

## Steps to Reproduce
1. genie team create test --wish <any-wish-with-2+-groups>
2. Team-lead runs genie work <slug>
3. Check engineer panes — they show empty ❯ prompt
EOF
)"
```

## Rules
- Always run `/trace` first — it is the backbone of every report.
- One question at a time when collecting symptoms — never batch questions.
- Never modify source code — investigation only.
- Screenshots and videos are evidence, not decoration — only capture when relevant to the bug.
- Prefer screenshots over video (smaller, easier to embed in issues).
- Be specific about what was not captured and why — this helps the fixer know what to investigate further.
- The report must be self-contained — someone reading it should understand the bug without needing to reproduce it.
- If identical to an existing open issue, link to it instead of creating a duplicate.
