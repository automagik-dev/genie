---
name: review
description: "Validate plans, execution, or PRs against wish criteria — returns SHIP / FIX-FIRST / BLOCKED with severity-tagged gaps."
---

# /review — Universal Review Gate

Validate any artifact against its wish criteria. Dispatch as a subagent — never review your own work inline.

## Context Injection

This skill receives its scope from the dispatch layer:
- **Target** — what is being reviewed (wish draft, completed work, or PR diff)
- **Wish path** — `.genie/wishes/<slug>/WISH.md` in the shared worktree
- **Injected criteria** — acceptance criteria extracted from the wish

If context is injected, use it directly. Do not re-parse for information already provided.

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

## Council Participation

When a council team is active, the review can incorporate council perspectives:
- Post review findings to team chat for council input via `genie chat post --team <team>`
- Council members may surface risks or blind spots missed by the standard checklist
- Council input is advisory — the verdict is still determined by the checklist

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
| **SHIP** | Zero CRITICAL/HIGH gaps, validations pass | See SHIP Next-Steps below |
| **FIX-FIRST** | Any CRITICAL/HIGH gap or failing validation | Auto-invoke `/fix` |
| **BLOCKED** | Scope or architecture issue requiring wish revision | Escalate to human |

### SHIP Next-Steps (context-dependent)

| Review Context | On SHIP |
|---------------|---------|
| Plan review (after `/brainstorm`) | Proceed to `/wish` to create executable plan |
| Plan review (after `/wish`) | Proceed to `/work` to execute the plan |
| Execution review (after `/work`) | Create PR targeting `dev` |
| PR review (before merge) | Merge to `dev` (agents) or approve for human merge |

### Auto-Invocation on FIX-FIRST

When the verdict is FIX-FIRST:
1. Auto-invoke `/fix` with the severity-tagged gap list.
2. After `/fix` completes, re-run `/review` (max 2 fix loops).
3. If still FIX-FIRST after 2 loops, escalate as BLOCKED.

### Unclear Root Cause

When a failure is found but the root cause is unclear:
- Invoke `/trace` to investigate before dispatching `/fix`.
- `/trace` produces a diagnosis report; `/fix` uses it to apply the correction.

## Dispatch

**The reviewer must not be the engineer.** Always dispatch review as a separate subagent.

```bash
# Spawn a reviewer subagent
genie agent spawn reviewer
```

## Task Lifecycle Integration (v4)

When a PG task exists for the reviewed work, log the verdict as a task comment:

| Verdict | Task Action |
|---------|-------------|
| **SHIP** | `genie task comment #<seq> "SHIP — all criteria passed"` |
| **FIX-FIRST** | `genie task comment #<seq> "FIX-FIRST: [gap list]"` then `genie task move #<seq> --to build` |
| **BLOCKED** | `genie task block #<seq> --reason "<reason>"` |

**Graceful degradation:** If no PG task exists for the reviewed work, skip all `genie task` commands. Verdict logging is an enhancement — the review flow must never fail due to missing tasks.

## Example

After `/work` completes wish `fix-dispatch-initial-prompt`, the orchestrator dispatches `/review`:

```bash
genie agent spawn reviewer
genie agent send 'Review wish fix-dispatch-initial-prompt execution. Criteria:
1. initialPrompt added to all 5 dispatch call sites
2. protocolRouter.sendMessage kept as backup with warning logging
3. bun test passes
4. bun run typecheck clean
Check: gh pr diff 746, then run validations.' --to reviewer
```

Reviewer output:

```
## Review: fix-dispatch-initial-prompt (Execution)

### Checklist
- [x] All acceptance criteria met — 5/5 call sites have initialPrompt
- [x] Validation: bun test — 1137 pass, 0 fail
- [x] Validation: bun run typecheck — clean
- [x] No scope creep — only dispatch.ts and team.ts modified
- [x] No regressions — test count unchanged

### Gaps
(none)

### Verdict: SHIP
Next: create PR targeting dev
```

## Rules
- Never mark PASS without evidence — verify, don't assume.
- Never ship with CRITICAL or HIGH gaps.
- Never implement fixes during review — hand off to `/fix`.
- Every FAIL includes actionable fix (file, command, what to change).
- Keep output concise, severity-ordered, and executable.

## Turn close (required)

Every session MUST end by writing a terminal outcome to the turn-session contract. This is how the orchestrator reconciles executor state — skipping it leaves the row open and blocks auto-resume.

- `genie done` — work completed, acceptance criteria met
- `genie blocked --reason "<why>"` — stuck, needs human input or an unblocking signal
- `genie failed --reason "<why>"` — aborted, irrecoverable error, or cannot proceed

Rules:
- Call exactly one close verb as the last action of the session.
- `blocked` / `failed` require `--reason`.
- `genie done` inside an agent session (GENIE_AGENT_NAME set) closes the current executor; it does not require a wish ref.
