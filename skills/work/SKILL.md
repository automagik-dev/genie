---
name: work
description: "Execute an approved wish in dependency order with scoped workers, independent review, bounded repairs, and verified completion."
---

# Work

Read the wish and require persisted `APPROVED`, or `IN_PROGRESS` for a resume. The coordinator sets `IN_PROGRESS` before execution and owns task completion and review evidence. Documents remain the instruction source.

Use the selected lifecycle authority: standalone uses the task flow below; Orca uses `references/orca-coordinator.md`. Do not infer Orca mode from the app being installed or open. A refusal from the selected authority is a blocker, not permission to switch state stores.

## Dispatch

Derive ready waves from WISH.md’s Execution Strategy and per-group `depends-on`. A standalone DB row being `ready` does not prove its dependencies are met; the DAG lives in the document.

Delegate each independent group through the active runtime’s native surface, using the plan’s portable role and supported runtime configuration. Inherit the active model unless the user or an evidenced capacity diagnosis authorizes a change. If delegation is unavailable, report that limitation; do not pretend independent review occurred.

Give each worker its goal, deliverables, criteria, validation, dependencies, owned files, relevant context, and stop conditions. Include task identifiers when available. Keep doing independent coordination/integration work while workers run.

Parallel writers need disjoint file ownership or dedicated worktrees; otherwise sequence them. Shared-workspace workers do not change repo-level git state (`checkout`, `switch`, `reset`, `stash`, `rebase`) or commit: only the coordinator moves HEAD and arranges isolation. Reviewers remain read-only. Reuse or steer a live worker rather than spawning a duplicate.

## Standalone claims

Before mutation, including shared environment setup, the assigned worker claims its group:

```bash
genie task checkout <task-id> --worker <name>
```

A losing claimant stands down. Keep setup claimed until validated; shared prerequisites belong to an explicit group. Do not reclaim another live worker’s claim merely because time has passed.

Inspect `genie task list --wish <slug>` or `genie board --wish <slug>` as needed. If the CLI/DB or legacy task rows are unavailable, say so and track groups in WISH.md; preserve dependencies, file ownership, review, and validation. This fallback never bypasses a live claim conflict or an Orca authority refusal.

## Complete a group

1. Receive the worker’s result and inspect the changed scope and evidence.
2. Dispatch a different reviewer through `review` against the group’s criteria. Append returned evidence under `## Review Results`; reviewers do not edit the wish.
3. Route FIX-FIRST through `fix`, carrying its per-group budget `B` (default 2) and counters. An `overdesigned-plan` returns to planning; a user-approved simplification invalidates superseded evidence and requires fresh review.
4. Obtain the separate quality pass for security, maintainability, and performance. Its repair cap is one loop, separate from `B`.
5. Verify the group’s checks and actual diff. Use checks that can disprove the changed behavior; preserve repository-required aggregate gates. Shared runtime, schema, dependency, executable artifact, CI/release, broad-refactor, or uncertain-impact changes require the full gate and affected build/end-to-end checks. Validation is never zero. Reuse current applicable evidence; rerun for changed code, failures, or unresolved concerns. A passing full suite is valid; missing scope rationale alone is a write-up gap.
6. Only after SHIP and passing validation, the coordinator runs:

```bash
genie task done <task-id>
```

Recompute the next wave from the wish. Use native notifications or the runtime’s structured waits. Leave unresolved groups in progress with their diagnosis, counters, and next route; continue independent groups.

## Delivery

When groups finish, perform required integrated execution/PR review and checks. Keep the wish `IN_PROGRESS` through PR and CI. Only an authorized merge and required QA/release evidence establish `SHIPPED`. Report the exact verified state, remaining gaps, and artifact links; a worker notification is not delivery evidence by itself.
