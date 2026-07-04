---
name: review
description: "Validate plans, execution, or PRs against wish criteria — returns SHIP / FIX-FIRST / BLOCKED with severity-tagged gaps."
---

# /review — Universal Review Gate

Validate any artifact against its wish criteria. Dispatch as a subagent — never review your own work inline. The deliverable is findings plus a verdict: report and stop — never implement fixes, however small.

## Context Injection

When spawned as a reviewer subagent, your dispatch prompt carries the curated scope: the target (wish draft, completed work, or PR diff), the wish path (`.genie/wishes/<slug>/WISH.md`), and the extracted acceptance criteria. Use it directly — do not re-parse for information already provided.

## When to Use
- Before `/work` — validate a wish plan is ready for execution
- After `/work` — verify implementation meets acceptance criteria
- Before merge — check a PR diff against wish scope

## Flow
1. **Detect target** — wish draft, completed work, or PR diff.
2. **Select pipeline** — the matching checklist below.
3. **Run checklist** — evaluate each criterion, collecting evidence.
4. **Run validations** — execute validation commands; capture pass/fail output.
5. **Tag gaps** — classify every unmet criterion by severity.
6. **Return verdict** — SHIP, FIX-FIRST, or BLOCKED, with exact fixes (files, commands, what to change) for each gap.

## Pipelines

### Plan Review (before `/work`)
- [ ] Problem statement is one sentence and testable
- [ ] Scope IN has concrete deliverables; Scope OUT is explicit
- [ ] Every task has testable acceptance criteria
- [ ] Tasks are bite-sized and independently shippable
- [ ] Dependencies tagged (`depends-on` / `blocks`)
- [ ] Validation commands exist for each execution group

### Execution Review (after `/work`)
- [ ] All acceptance criteria met with evidence
- [ ] Validation commands run and passing
- [ ] No scope creep — only wish-scoped changes
- [ ] Work is auditable — commands and outcomes captured
- [ ] Quality pass: security, maintainability, correctness
- [ ] No regressions introduced

### PR Review (before merge)
- [ ] Diff matches wish scope — no unrelated changes
- [ ] File list matches wish's "Files to Create/Modify"
- [ ] No secrets, credentials, or hardcoded tokens in diff
- [ ] Tests pass (if applicable)
- [ ] Commit messages reference wish slug

## Severity & Verdicts

| Severity | Meaning | Blocks? |
|----------|---------|---------|
| CRITICAL | Security flaw, data loss, crash | Yes |
| HIGH | Bug, major perf issue | Yes |
| MEDIUM | Code smell, minor issue | No |
| LOW | Style, naming preference | No |

| Verdict | Condition | Next step |
|---------|-----------|-----------|
| **SHIP** | Zero CRITICAL/HIGH gaps, validations pass | See SHIP next-steps |
| **FIX-FIRST** | Any CRITICAL/HIGH gap or failing validation | Auto-invoke `/fix` |
| **BLOCKED** | Scope or architecture issue requiring wish revision | Escalate to human |

### SHIP next-steps

| Review context | On SHIP |
|---------------|---------|
| Plan review (after `/brainstorm`) | Proceed to `/wish` to create the executable plan |
| Plan review (after `/wish`) | Proceed to `/work` to execute the plan |
| Execution review (after `/work`) | Create PR targeting `dev` |
| PR review (before merge) | Merge to `dev` (agents) or approve for human merge |

### FIX-FIRST loop
1. Auto-invoke `/fix` with the severity-tagged gap list.
2. After `/fix` completes, re-run `/review` (max 2 fix loops).
3. Still FIX-FIRST after 2 loops → escalate as BLOCKED.

When a failure's root cause is unclear, invoke `/trace` for a diagnosis before dispatching `/fix` — `/fix` then applies the correction from the trace report.

## Dispatch

**Reviewer ≠ engineer.** The orchestrator dispatches review as a separate subagent via the Agent tool — an agent never reviews its own work. Follow-ups to a running reviewer go through SendMessage. When a council team is active, findings may be shared with council members for advisory input; the verdict is still determined by the checklist.

## Verdict Reporting

The verdict plus severity-tagged gaps ARE the review output — deliver them in your final message (and, for a plan/PR, in review notes committed to git). The reviewer never mutates task state:

| Verdict | Orchestrator's next move |
|---------|-------------------------|
| **SHIP** | Execution review → complete the group with `genie task done <task-id>`; plan review → advance to the next lifecycle stage |
| **FIX-FIRST** | Auto-invoke `/fix` with the gap list; the task stays `in_progress` until a clean re-review |
| **BLOCKED** | Escalate to a human; the task stays `in_progress` |

`genie task done` belongs to the orchestrator, after a clean verdict — never to the reviewer.

## Rules
- Never mark PASS without evidence from this session — verify, don't assume.
- Never ship with CRITICAL or HIGH gaps.
- Report findings and stop — no unrequested fixes; corrections belong to `/fix`.
- Every FAIL includes an actionable fix (file, command, what to change).
- Keep output concise, severity-ordered, and executable.

## Session close (required)

When spawned as a native-team subagent, your final message IS the completion signal — the orchestrator is notified when you finish; do not poll or emit a separate contract call. State the verdict, then end with exactly one terminal outcome as the last word:

- **done** — review completed; verdict (SHIP / FIX-FIRST / BLOCKED) and severity-tagged gaps stated.
- **blocked** — could not complete the review (missing artifact, unrunnable validation). State exactly what you need.
- **failed** — aborted or irrecoverable. State why.

`blocked` / `failed` must include a one-line reason.
