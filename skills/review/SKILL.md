---
name: review
description: "Universal reviewer for plans and execution - validates readiness and returns SHIP/FIX-FIRST/BLOCKED with actionable gaps."
---

# /review

Universal review gate. Always run as a subagent — never review your own work inline.

## Flow
1. Detect review target → select pipeline (Plan, Execution, or PR).
2. Run the pipeline checklist below.
3. Run listed validation commands and capture pass/fail output.
4. Classify gaps: CRITICAL / HIGH / MEDIUM / LOW.
5. Return verdict:
   - **SHIP:** no CRITICAL/HIGH gaps, validations pass.
   - **FIX-FIRST:** fixable gaps or failing validations → hand off to `/fix`.
   - **BLOCKED:** scope/architecture issue requiring wish revision.
6. Write actionable next steps (exact fixes, files, commands).

## Pipelines

### Plan Review (wish draft)
Run before `/work`. Checks the wish document quality.

- [ ] Problem statement is one sentence, testable
- [ ] Scope IN has concrete deliverables
- [ ] Scope OUT is not empty — boundaries explicit
- [ ] Every task has acceptance criteria that are testable
- [ ] Tasks are bite-sized and independently shippable
- [ ] Dependencies tagged (`depends-on` / `blocks`)
- [ ] Validation commands exist for each execution group

### Execution Review (completed /work)
Run after `/work`. Checks implementation against wish criteria.

- [ ] All acceptance criteria met with evidence
- [ ] Validation commands run and passing
- [ ] No scope creep — only wish-scoped changes made
- [ ] Work is auditable — commands and outcomes captured
- [ ] No regressions introduced

### PR Review (pre-merge)
Run before merge. Checks the diff against the wish.

- [ ] Diff matches wish scope — no unrelated changes
- [ ] File list matches wish's "Files to Create/Modify"
- [ ] No secrets, credentials, or hardcoded tokens in diff
- [ ] Tests pass (if applicable)
- [ ] Commit messages reference wish slug

## Subagent Rule

**Always dispatch review as a subagent.** The reviewer must not be the implementor.

```
sessions_send(
  agentId: "<self>",
  sessionKey: "agent:<self>:reviewer-<slug>-<timestamp>",
  message: "Review <target> against wish <slug>. Pipeline: <plan|execution|pr>.",
  timeoutSeconds: 120
)
```

## Rules
- Never mark PASS without evidence.
- Never ship with CRITICAL/HIGH gaps.
- Never implement fixes during /review — hand off to `/fix`.
- Keep review output concise, prioritized, and executable.
