# Design: Workflow Engine Runtime

| Field | Value |
|-------|-------|
| **Slug** | `workflow-engine-runtime` |
| **Date** | 2026-03-28 |
| **WRS** | 100/100 |

## Problem
Board columns define gates, actions, auto-advance, and transitions, but nothing enforces or executes them — the pipeline is a passive kanban pretending to be a workflow engine.

## Scope
### IN
- Gate enforcement in moveTask() — check actor type vs column gate
- Action auto-invocation — spawn skill or run shell command when task enters column
- Auto-advance — move task to next column when agent-gated action completes
- On-fail handling — invoke on_fail skill/script when action fails
- task_action_runs table — track action invocations per task
- task_gate_evaluations table — audit trail for gate checks
- Action type dispatch: `/skill` prefix → spawn agent, `!` prefix → shell command

### OUT
- Webhook action type (filed as #852)
- A2A action type (filed as #853)
- Human approval via WhatsApp/Slack (filed as #854)
- MCP tool invocation (filed as #855)
- Conditional fan-out (filed as #856)
- Transition condition evaluator (defer — transitions[] always empty today)
- Role enforcement (defer — roles[] always ["*"] today)
- Parallel flag (defer — parallel always false today)

## Approach
Build a workflow listener that hooks into moveTask(). When a task moves to a new column, the listener reads the column config and dispatches the appropriate action. Uses PG events (genie_runtime_events from PR #831) for completion/failure signals.

Two action types for V1:
- **Skill** (`/work`, `/review`, `/qa`) — spawn agent with skill via genie spawn
- **Script** (`!bun test`, `!make deploy`) — run shell command, capture exit code

## Decisions
| Decision | Rationale |
|----------|-----------|
| PG events over NATS | PR #831 removes NATS dep; PG events are durable + queryable |
| Gate enforcement in moveTask() | Single enforcement point — all moves go through this function |
| task_action_runs table | Need to track started/completed/failed/retries per action |
| Skill prefix `/` + script prefix `!` | Simple string dispatch, extensible for future types |
| Max 2 retries on failure | Prevents infinite loops, matches dream orchestrator pattern |

## Risks & Assumptions
| Risk | Severity | Mitigation |
|------|----------|------------|
| PG single point of failure | Medium | Circuit breaker in runtime-events (PR #831 caveat) |
| Action latency (PG write 5-10ms) | Low | Acceptable for orchestration, not real-time streaming |
| Script injection via action field | Medium | Only board creators set actions; validate no pipes/redirects |
| Infinite auto-advance loop | High | Max chain depth (8 columns) + cycle detection |

## Success Criteria
- [ ] moveTask() rejects agent moving to human-gated column
- [ ] moveTask() rejects human moving to agent-only column (if human+agent not set)
- [ ] Task entering a column with action `/work` spawns an engineer agent
- [ ] Task entering a column with action `!bun test` runs the command and captures exit code
- [ ] Action completion with auto_advance=true moves task to next column automatically
- [ ] Action failure with on_fail set invokes the on_fail action
- [ ] Action failure after 2 retries marks task as blocked
- [ ] task_action_runs table records every action invocation with status
- [ ] task_gate_evaluations table records every gate check with result
- [ ] Full chain works: task dropped in Triage → auto-advance through agent columns → stops at human gate
