# Wish: Genie Workflow Engine — Transition Table Runtime

| Field | Value |
|-------|-------|
| **Status** | BRAINSTORM |
| **Slug** | `genie-workflow-engine` |
| **Date** | 2026-03-25 |
| **depends-on** | `genie-boards` (must ship first — provides schema + board CLI) |
| **Design** | From Mar 20 office session: [PIPELINE-FINAL.md](/home/genie/agents/sofia/.genie/brainstorms/office-session-2026-03-20/PIPELINE-FINAL.md) |

## Summary

The runtime that brings boards to life. Reads the `gate`, `action`, `transitions`, `on_fail`, `parallel` fields on board columns and executes them. PG NOTIFY listener reacts to stage changes, dispatches agents, handles loops/branches/parallel, escalates on failure.

## Key Capabilities (from Mar 20 pipeline design)

- **Fix loops** — review finds issue → `/fix` → loop back to review. QA fails → `/fix` → loop back to QA. Internal to the column — stage doesn't change until loop succeeds.
- **Conditional gates per task type** — bug auto-advances from draft, feature waits for human. Same column, different behavior based on task metadata.
- **Parallel sub-steps** — review column spawns coding agents + council simultaneously. Column completes when all sub-steps done.
- **Side-effects** — review can CREATE new tasks in triage column. A column action isn't limited to advancing — it can produce new work.
- **Configurable ship** — PR to main, WhatsApp message, document delivery, custom action. Per-task, not per-board.
- **Release bundling** — human selects combination from ship column to bundle into a versioned release.
- **External triggers** — PR merge, webhook, cron → trigger column transitions.
- **Crash recovery** — reconciliation sweep catches missed NOTIFY events. Idempotent replays.

## Transition Table Model

```typescript
// Each column can have multiple transitions (not just "advance to next")
type Transition = {
  event: "complete" | "fail" | "approve" | "reject" | "pr_merge" | "timeout" | "external",
  target: string,          // column name: "review", "qa", "triage", "ship"
  condition?: string,      // "fix_count < 2", "qa_passed", "task.type == 'bug'"
  action?: string,         // skill to run on transition: "/fix", "/trace"
  create_task?: boolean,   // side-effect: create new task in target column
}
```

Example: review column transitions:
```json
[
  {"event": "complete", "target": "qa", "condition": "no_critical_gaps"},
  {"event": "fail", "target": "review", "action": "/fix", "condition": "fix_count < 2"},
  {"event": "fail", "target": "blocked", "condition": "fix_count >= 2"},
  {"event": "complete", "target": "triage", "create_task": true, "condition": "has_deferred_issues"}
]
```

## Status: NEEDS BRAINSTORM

This wish requires a full `/brainstorm` session to design:
- The transition table schema in detail
- The listener state machine
- Crash recovery + reconciliation sweep
- How parallel sub-steps coordinate completion
- How external events (PR merge) feed into transitions
- Escalation paths (concrete: who gets notified, how)
- How conditional gates evaluate task metadata

The `genie-boards` wish ships the schema fields. This wish builds the brain.
