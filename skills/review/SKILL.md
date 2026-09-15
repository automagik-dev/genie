---
name: review
description: "Independently assess designs, plans, implementations, PRs, or repository quality; return evidence and SHIP, FIX-FIRST, or BLOCKED without applying fixes."
---

# Review

The reviewer is different from the author and remains read-only. Return findings and a verdict; the caller owns fixes, records, task state, and delivery. The reviewer never mutates files or task state and posts nothing to the card: at the same moment the coordinator appends the evidence block to WISH.md it relays a one-line pointer with `genie task comment <task-id> --worker orchestrator -- 'review: SHIP|FIX-FIRST|BLOCKED — <gap count or summary>'`. The card comment is the pointer; WISH.md keeps the evidence. Assess the requested scope against user criteria and repository contracts.

## Target and evidence

Identify the target path, diff/commit, criteria, and relevant checks. For a PR, inspect the complete diff and individual commits in chronological order. For committed work under concurrent modification, the coordinator provides an immutable snapshot at the exact SHA; it also owns setup and cleanup. Reviewers never change repo-level git state. For uncommitted work, name the snapshot reviewed and invalidate the verdict if it changes.

Use current code and command output. Run relevant checks, or inspect current attributable results that cover the exact artifact; say which evidence was reused. Do not infer coverage from filenames or a worker’s claim. Preserve required full/integration/release gates. Shared runtime, schema, dependencies, executable artifacts, CI/release, broad refactors, or uncertain impact require the repository full gate plus affected builds/end-to-end checks. Zero validation is insufficient. A passing full suite is valid evidence; missing scope rationale alone is at most MEDIUM.

## Pipelines

### Design Review

Check that the problem, IN/OUT scope, chosen approach, alternatives, risks, and testable success criteria agree. The Simplicity Case must justify each additional mechanism with a current need. No unresolved placeholder may masquerade as a decision.

Return the exact content digest as `reviewed-sha256`, computed with the design-evidence helper bundled by `brainstorm` or `wish`. It excludes only the bounded evidence block. The caller passes that value unchanged to stamping; never recompute it for content you did not review. Missing/stale evidence requires fresh design review.

### Plan Review

Check the actual template/schema, linked design’s current SHIP evidence, concrete deliverables and exclusions, per-group criteria and validation, dependency order, file ownership, feasible dispatch, and aggregate delivery gates. Deferred machinery must remain out of implementation.

### Implementation / PR Review

Trace every criterion to code and evidence. Check correctness, failure behavior, compatibility, security, maintainability, performance where relevant, regression risk, and scope. Validate actual affected boundaries, including installed/compiled artifacts when source execution would miss a behavior. For deeper audits, select a relevant lens below; natural-language requests such as “review performance” are sufficient.

## Audit lenses

Load only the lens needed by the request. These are advisory evidence guides, not extra mandatory panels:

| Audit | Resource |
|---|---|
| Architecture and simplicity | `references/lenses/architecture.md` |
| Types, lint, duplication, dead code | `references/lenses/code-quality.md` |
| Documentation and contributor experience | `references/lenses/dx.md` |
| Performance | `references/lenses/perf.md` |
| Test quality | `references/lenses/qa.md` |
| Repository hygiene | `references/lenses/repo-hygiene.md` |
| Security and supply chain | `references/lenses/supply-chain.md` |

## Severity and verdict

| Severity | Meaning | Blocking |
|---|---|---|
| CRITICAL | Demonstrated security exposure, data loss, or severe outage | Yes |
| HIGH | Broken criterion, correctness defect, major performance/compatibility failure | Yes |
| MEDIUM | Bounded maintainability or evidence-write-up gap | No |
| LOW | Optional style or naming improvement | No |

Unjustified stateful machinery is a HIGH gap. If removing it changes the governing approach, return BLOCKED with `overdesigned-plan` for replanning.

- **SHIP:** no CRITICAL/HIGH gaps and required validation passes.
- **FIX-FIRST:** actionable blocking gaps or failed validation.
- **BLOCKED:** missing scope, design decision, environment, or evidence prevents a valid assessment.

Each finding names severity, file/line or command, concrete trigger and impact, evidence, and a correction. Distinguish confirmed findings from unresolved hypotheses. Return coverage and limitations even when there are no findings.

## Handoff

Return target SHA/path, criteria covered, commands/results, verdict, findings, and reviewer identity/time. The caller appends plan/execution/PR evidence under the wish’s `## Review Results`:

- Plan SHIP → APPROVED; FIX-FIRST → FIX-FIRST; BLOCKED → BLOCKED.
- Implementation/PR review leaves the wish IN_PROGRESS.
- Only authorized merge plus required QA/release evidence establishes SHIPPED.

For repairs, the caller uses `fix`, preserving its budget `B` (default 2), attempts, and cause-specific escalation limits. An unclear cause calls for investigation through `report`; it does not demonstrate model capacity. Preserve opposing review evidence for resolution. A verdict authorizes neither edits nor publication by itself.

## Orca mode

For explicitly selected Orca work, the coordinator dispatches a different agent with a read-only scope, exact artifact, criteria, and current validation evidence. Apply the same validation policy above; the integrated result must pass required checks before SHIP. Begin the response with `VERDICT: SHIP`, `VERDICT: FIX-FIRST`, or `VERDICT: BLOCKED`. Deliver it through Orca's current worker protocol. A completion notification proves delivery, not a passing verdict; the coordinator records evidence and handles resource cleanup.
