---
name: review
description: "Validate plans, execution, or PRs against wish criteria — returns SHIP / FIX-FIRST / BLOCKED with severity-tagged gaps."
---

# /review — Universal Review Gate

Validate any artifact against its wish criteria. Dispatch as a subagent — never review your own work inline.

## When to Use
- Before `/work` — validate a wish plan is ready for execution
- After `/work` — verify implementation meets acceptance criteria
- Before merge — check a PR diff against wish scope

## Flow
1. **Detect target** — determine what is being reviewed (wish draft, completed work, or PR diff).
2. **Select pipeline** — match target to Plan, Execution, or PR checklist below.
3. **Run checklist** — evaluate each criterion, collecting evidence.
4. **Run validations** — execute any validation commands; capture pass/fail output.
5. **Tag gaps** — classify every unmet criterion by severity.
6. **Return verdict** — one of SHIP, FIX-FIRST, or BLOCKED (see Verdicts).
7. **Write next steps** — exact fixes, files, and commands for each gap.

## Pipelines

### Plan Review (before `/work`)

- [ ] Problem statement is one sentence and testable
- [ ] Scope IN has concrete deliverables
- [ ] Scope OUT is explicit — boundaries stated
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
| **SHIP** | Zero CRITICAL/HIGH gaps, validations pass | Proceed |
| **FIX-FIRST** | Any CRITICAL/HIGH gap or failing validation | Hand off to `/fix` |
| **BLOCKED** | Scope or architecture issue requiring wish revision | Escalate to human |

## Dispatch

**The reviewer must not be the implementor.** Always dispatch review as a separate subagent.

| Runtime | Detection | Pattern |
|---------|-----------|---------|
| Claude Code | `Task` tool available | `Task(model: "sonnet", isolation: "worktree", prompt: "<review prompt>")` |
| Codex | `CODEX_ENV` or native API | `codex_subagent(task: "<review prompt>", sandbox: true)` |
| OpenClaw | `term` CLI available | `term spawn --name "reviewer-<slug>" --model sonnet` |

Default to **Claude Code** when detection is ambiguous.

## Rules
- Never mark PASS without evidence — verify, don't assume.
- Never ship with CRITICAL or HIGH gaps.
- Never implement fixes during review — hand off to `/fix`.
- Every FAIL includes actionable fix (file, command, what to change).
- Keep output concise, severity-ordered, and executable.
