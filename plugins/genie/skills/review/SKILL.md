---
name: review
description: "Validate plans, execution, or PRs against wish criteria — returns SHIP / FIX-FIRST / BLOCKED with severity-tagged gaps."
---

# review — Universal Review Gate

**Runtime syntax:** in Codex, invoke the plugin copy with the owner-qualified `$genie:<skill>` selector; use bare `$<skill>` only when intentionally selecting a user-tier copy (a separately installed personal copy; Genie no longer seeds this tier). Claude Code and Hermes use `/<skill>`. Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active tier.

Validate a design, wish plan, completed execution, or PR against its governing criteria. Dispatch as a subagent — never review your own work inline. The deliverable is findings plus a verdict: report and stop — never implement fixes, however small.

## Context Injection

When spawned as a reviewer subagent, your dispatch prompt carries the curated scope: the target (DESIGN.md, wish draft, completed work, or PR diff), its exact path or commit, and the extracted design or acceptance criteria. Implementation review uses an ephemeral, detached, read-only worktree at the exact candidate commit; it never inspects a concurrently mutable engineer checkout. A design review does not require a wish path; later pipelines include `.genie/wishes/<slug>/WISH.md`. Use the supplied context directly — do not re-parse information already provided.

## When to Use
- After `brainstorm` — validate DESIGN.md before converting it into a wish
- Before `work` — validate a wish plan is ready for execution
- After `work` — verify implementation meets acceptance criteria
- Before merge — check a PR diff against wish scope

## Flow
1. **Detect target** — DESIGN.md, wish draft, completed work, or PR diff.
2. **Select pipeline** — the matching checklist below.
3. **Run checklist** — evaluate each criterion, collecting evidence.
4. **Run validations** — execute validation commands; capture pass/fail output.
5. **Tag gaps** — classify every unmet criterion by severity.
6. **Return verdict** — SHIP, FIX-FIRST, or BLOCKED, with exact fixes (files, commands, what to change) for each gap.

## Escalation Diagnosis

Use this policy before any model or effort change; keep this contract identical in `fix`, `review`, and `work`.

| Cause | Diagnostic evidence | Corrective route |
|-------|---------------------|------------------|
| `model-capacity` | The supplied context is complete, the spec is decidable, the environment works, and attempt output shows the assigned model or effort still cannot perform the reasoning. | May raise model or effort one step, but only with new evidence and available caps. |
| `missing-context` | The attempt identifies absent files, history, criteria, logs, or other inputs needed to decide. | Supply the missing context and retry at the same model and effort; MUST NOT escalate model or effort. |
| `ambiguous-spec` | Two or more materially different behaviors remain consistent with the stated criteria. | Request a human decision or wish clarification; MUST NOT escalate model or effort. |
| `env-tool-failure` | A reproducible environment, dependency, permission, timeout, or tool error prevents valid execution. | Repair or retry the environment/tool, or report blocked with the error; MUST NOT escalate model or effort. |
| `overdesigned-plan` | Gaps cluster in optional machinery that lacks a current criterion or measurement, while a simpler design satisfies the user stories with fewer durable states or recovery paths. | Stop the fix loop and return to `brainstorm`/`wish` to remove or defer the mechanism. Re-review the amended design/plan; MUST NOT spend retries or model escalation defending it. |

Escalation eligibility requires **new evidence** produced since the previous attempt: attach the new failing output or diagnostic result, the correction already tried, and why it rules out the other three causes. A repeated verdict or unchanged failure is not new evidence and cannot authorize a model or effort change.

Model and reasoning effort belong in the active runtime's session or named-agent configuration, never in skill frontmatter. Inherit the active model by default. Only an evidenced `model-capacity` diagnosis may justify one higher-effort fresh agent, with at most two escalation attempts per group. The runtime's highest supported effort is appropriate only for a final gate or similarly demanding review when the user requested it or the evidence warrants it. Further escalation requires an explicit human decision recorded with the wish/group, old and new settings, reason, approver, and timestamp.

If an ordinary reviewer and the `final-gate` disagree, log an appeal with the wish/group, both verdicts and evidence, the contested criterion, and the human resolution. Neither verdict silently overrides the other, and the group remains `in_progress` until the appeal is resolved.

## Pipelines

### Design Review (after `brainstorm`)
- [ ] Problem is explicit, consequential, and readable one way
- [ ] Scope has concrete IN and OUT boundaries that fit one wish
- [ ] Chosen approach names its rationale and rejected alternatives
- [ ] Simplicity Case states the simplest complete design; every added mechanism has a present requirement or measurement, and future complexity has a concrete adoption trigger
- [ ] Current state is bounded and history is separated before deltas, sharding, caches, or distributed synchronization are considered
- [ ] Decisions are consistent with the approach and repository constraints
- [ ] Risks and assumptions name mitigations or explicit acceptance
- [ ] Success criteria are testable without requiring execution-group details
- [ ] Next step is `wish`; DESIGN.md contains no TODO/TBD placeholders

### Plan Review (before `work`)
- [ ] Problem statement is one sentence and testable
- [ ] Scope IN has concrete deliverables; Scope OUT is explicit
- [ ] Every task has testable acceptance criteria
- [ ] Tasks are bite-sized and independently shippable
- [ ] Dependencies tagged (`depends-on` / `blocks`)
- [ ] Validation commands exist for each execution group
- [ ] Simplicity Case is executable: no group builds machinery marked deferred, and every stateful mechanism maps to a current success criterion

### Execution Review (after `work`)
- [ ] All acceptance criteria met with evidence
- [ ] Validation commands run and passing
- [ ] No scope creep — only wish-scoped changes
- [ ] Work is auditable — commands and outcomes captured
- [ ] Quality pass: security, maintainability, correctness
- [ ] No regressions introduced
- [ ] Implementation did not introduce caches, synchronization states, configuration, or abstractions absent from the approved Simplicity Case

### PR Review (before merge)
- [ ] Diff matches wish scope — no unrelated changes
- [ ] File list matches wish's "Files to Create/Modify"
- [ ] No secrets, credentials, or hardcoded tokens in diff
- [ ] Tests pass (if applicable)
- [ ] Commit messages reference wish slug

## Severity & Verdicts

In design and plan review, unjustified stateful machinery—such as speculative caches, deltas, sharding, background coordination, or retry state machines—is a HIGH gap because it creates permanent correctness and maintenance obligations without delivering a current criterion. If removing it changes the governing approach, return BLOCKED with `overdesigned-plan` and replan instead of asking a fixer to preserve it.

| Severity | Meaning | Blocks? |
|----------|---------|---------|
| CRITICAL | Security flaw, data loss, crash | Yes |
| HIGH | Bug, major perf issue | Yes |
| MEDIUM | Code smell, minor issue | No |
| LOW | Style, naming preference | No |

| Verdict | Condition | Next step |
|---------|-----------|-----------|
| **SHIP** | Zero CRITICAL/HIGH gaps, validations pass | See SHIP next-steps |
| **FIX-FIRST** | Any CRITICAL/HIGH gap or failing validation | Auto-invoke `fix` |
| **BLOCKED** | Scope, architecture, or execution issue prevents a valid verdict | Diagnose the cause and take its corrective route |

### Persistence handoff

The reviewer is read-only. Return a timestampable evidence block containing
the review context, target SHA/path, commands and outcomes, verdict, and gaps.
For a design review, return the exact reviewed-content SHA-256 defined by the
bounded evidence block in DESIGN.md as `reviewed-sha256`; the invoking
orchestrator passes that value unchanged to the stamp command as
`--reviewed-sha256`. Stamping rejects a current design that differs from the
reviewed content, verification rejects any later edit, and the reviewer never
recomputes a digest for content it did not review. For plan,
execution, PR, and local integration review, the orchestrator appends the block under the wish's
`## Review Results` and owns every durable transition:

- plan SHIP → `APPROVED`; plan FIX-FIRST → `FIX-FIRST`; plan BLOCKED → `BLOCKED`;
- execution and PR verdicts are appended while the wish remains `IN_PROGRESS`;
- only proven mainline integration plus required QA changes the wish to `SHIPPED`; unresolved post-merge local mirroring,
  archival, or lane cleanup is recorded separately and must not be hidden.

Do not claim the next stage is active until the orchestrator confirms the
write. Never edit WISH.md, the brainstorm jar, or task state as the reviewer.

### SHIP next-steps

| Review context | On SHIP |
|---------------|---------|
| Design review (after `brainstorm`) | Proceed to `wish` to create the executable plan |
| Plan review (after `wish`) | Proceed to `work` to execute the plan |
| Execution review (after `work`) | GitHub-backed → create PR targeting authoritative `main`; zero remotes → prepare the validated local integration candidate |
| PR review (before merge) | Record SHIP evidence for third-party GitHub merge; never merge locally into GitHub-backed `main` |
| Local integration review | After candidate QA, review the closure commit containing staged `SHIPPED`; archive that exact commit and clean its lanes before fast-forwarding unchanged local `main` to it |

### FIX-FIRST loop
1. Diagnose first. For `overdesigned-plan`, return to `brainstorm`/`wish` without consuming a fix attempt.
2. Otherwise auto-invoke `fix` with the severity-tagged gap list.
3. After `fix` completes, re-run `review` (max 3 fix loops).
4. Still FIX-FIRST after 3 loops → return BLOCKED with an Escalation Diagnosis; never raise model or effort automatically.

When a failure's root cause is unclear, invoke `trace` before dispatching `fix` — `fix` then applies the cause-specific correction from the trace report. An unclear cause is not evidence of `model-capacity`.

## Dispatch

**Reviewer ≠ engineer.** The orchestrator dispatches review as a separate subagent via the native delegation surface — an agent never reviews its own work. Follow-ups to a running reviewer go through native follow-up messaging. For change-types that warrant deeper scrutiny, the orchestrator also convenes a **Lens Panel** (below); those lenses advise, but the checklist still owns the verdict.

## Lens Panels

When the change-type warrants it, the orchestrator dispatches **lens reviewers** alongside the standard reviewer — each a separate subagent whose prompt carries its lens file (path + content) and the curated review scope. Convene a lens only when the change actually touches its surface; lenses advise, but the verdict still comes from the checklist above — never from a lens.

| Change-type | Advisory lens |
|-------------|---------------|
| Auth / secrets / dependency changes | sibling `supply-chain/SKILL.md` |
| Hot-path or latency-sensitive code | sibling `perf/SKILL.md` |
| Public API / CLI surface | sibling `dx-docs/SKILL.md` |
| Module-boundary / architecture moves | sibling `architecture/SKILL.md` |
| Test-strategy changes | sibling `qa/SKILL.md` |
| Plan / wish reviews | `references/lenses/questioner.md` |

Resolve `references/lenses/questioner.md` from the directory containing this
loaded `SKILL.md`. Resolve a sibling lane from that skill directory's parent
(for example `../supply-chain/SKILL.md`). If a separately installed skill is
missing a sibling, mark that advisory lane unavailable instead of guessing a
source-checkout or global plugin path.

## Verdict Reporting

The verdict plus severity-tagged gaps ARE the review output — deliver them in your final message. For a plan or PR, the invoking orchestrator persists the returned block in git. The reviewer never mutates files or task state:

| Verdict | Orchestrator's next move |
|---------|-------------------------|
| **SHIP** | Execution review → return the exact reviewed commit for PM integration, validation, lane cleanup, and `genie task done <task-id>`; plan review → advance to the next lifecycle stage |
| **FIX-FIRST** | Auto-invoke `fix` with the gap list; the task stays `in_progress` until a clean re-review |
| **BLOCKED** | Take the diagnosed corrective route; the task stays `in_progress` |

`genie task done` belongs to the orchestrator after a clean verdict, integration, validation, and lane cleanup — never to the reviewer.

## Rules
- Never mark PASS without evidence from this session — verify, don't assume.
- Never ship with CRITICAL or HIGH gaps.
- Report findings and stop — no unrequested fixes; corrections belong to `fix`.
- Every FAIL includes an actionable fix (file, command, what to change).
- Keep output concise, severity-ordered, and executable.

## Session close (required)

When spawned as a native subagent, your final message IS the completion signal — the orchestrator is notified when you finish; do not poll or emit a separate contract call. State the verdict, then end with exactly one terminal outcome as the last word:

- **done** — review completed; verdict (SHIP / FIX-FIRST / BLOCKED) and severity-tagged gaps stated.
- **blocked** — could not complete the review (missing artifact, unrunnable validation). State exactly what you need.
- **failed** — aborted or irrecoverable. State why.

`blocked` / `failed` must include a one-line reason.
