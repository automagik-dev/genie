# Wish: Workflow Action Engine — Make the Pipeline Real

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `workflow-action-engine` |
| **Date** | 2026-04-05 |
| **Design** | [DESIGN.md](../../brainstorms/workflow-engine-runtime/DESIGN.md) |
| **Adopts** | `workflow-engine-runtime` (prior DRAFT, refined here) |
| **Consolidates** | #852 (webhook), #853 (A2A), #854 (human-approval), #855 (MCP), #856 (fan-out) |

## Summary

Board columns define gates, actions, transitions, and auto-advance — but nothing executes them. This wish builds the runtime that connects the schema to actual behavior. After this, dropping a task into a column triggers its action, the action returns a **decision**, the decision is evaluated against the column's **transition graph** to route the task, and the full execution is recorded in PG for audit.

## What It Does (User Perspective)

You define a board with columns. Each column has an action and transitions:

```
[Triage]  →  [Build]  →  [Review]  →  [QA]  →  [Done]
  gate: agent     gate: agent    gate: human+agent  gate: agent
  action: /work   action: /work  action: /review    action: !bun test
  auto_advance: true             transitions:       auto_advance: true
                                   pass → QA
                                   fail → Build
                                   unclear → Trace
                                   stuck → Triage
```

You drop a task into Triage. What happens:
1. **Gate check** — is the actor (human/agent) allowed to enter this column? Agent-gated → only agents can move tasks here.
2. **Action fires** — `/work` spawns an engineer agent who starts coding.
3. **Action completes** — the agent returns a **decision**: `{"action": "advance"}`.
4. **Transition evaluation** — engine checks column's `transitions[]`. If a transition matches the decision's event, route there. If no match and `auto_advance=true`, move to next column.
5. **Next column** — task enters Build. Repeat: gate check → action → decision → route.
6. **Human gate** — task reaches Review. If `gate: human`, auto-advance stops. A human must act.
7. **Review decision** — reviewer returns `{"action": "route", "event": "pass"}` → transitions say `pass → QA`. Task moves to QA.
8. **Script action** — QA column runs `!bun test`. Script returns `{"action": "advance"}` on exit 0, `{"action": "fail"}` on non-zero.
9. **On-fail** — if action fails and `on_fail` is set, invoke it (max 2 retries, then BLOCKED).

**The pipeline is a graph, not a line.** Transitions route tasks to any column based on action results. Auto-advance is just the default edge when no transition matches.

## Decision Protocol

Every action returns a **decision** — a JSON object that tells the engine what to do next:

| Decision | Meaning | Engine behavior |
|----------|---------|-----------------|
| `{"action": "advance"}` | Success, move forward | Follow `auto_advance` to next column, or evaluate transitions |
| `{"action": "advance", "to": "QA"}` | Success, move to specific column | Route directly to named column |
| `{"action": "route", "event": "pass"}` | Emit event for transition matching | Match against `transitions[].event`, route to `target` |
| `{"action": "hold", "approval": "felipe"}` | Block until human approves | Send approval request, task stays in column |
| `{"action": "fail", "reason": "..."}` | Action failed | Trigger `on_fail` handler, or BLOCKED after 2 retries |
| `{"action": "notify", "channel": "whatsapp", "to": "felipe", "message": "..."}` | Notify + advance | Send notification via Omni, then advance |
| `{"action": "spawn", "agent": "reviewer", "skill": "/review"}` | Spawn agent | Dispatch agent, wait for their decision |

**Fallback for non-JSON output:** If an action returns plain text (e.g. script stdout), the engine wraps it:
- Exit 0 → `{"action": "advance"}`
- Exit non-zero → `{"action": "fail", "reason": "<stderr>"}`

## Scope

### IN
- **PG migrations** — `task_action_runs` and `task_gate_evaluations` tables
- **Gate enforcement** — `moveTask()` checks actor type vs `column.gate` before allowing transition
- **Action dispatcher** — when task enters a column with an action, dispatch it
- **Decision evaluator** — parse action output as decision, evaluate against transitions
- **Transition routing** — match decision event against `transitions[].event`, route to `target` column
- **Auto-advance** — when no transition matches and `auto_advance=true`, move to next column by position
- **On-fail handler** — when action fails and `on_fail` is set, invoke it (max 2 retries)
- **Context carry-over** — action output stored in `task_action_runs`, available as input context for next action
- **Action types:**
  - `/skill` → spawn agent with skill (e.g. `/work`, `/review`, `/qa`, `/trace`)
  - `!command` → run shell command, parse stdout as decision (or wrap exit code)
  - `https://url` → POST task context to URL, parse response as decision
  - `agent://name` → dispatch to named agent via `genie send`, await decision
- **Workflow listener** — central engine subscribing to task.moved events
- **CLI approve/reject** — `genie task approve #<seq>` / `genie task reject #<seq>`
- **Tests** — unit tests for gate logic, action dispatch, transition routing, auto-advance, on-fail

### OUT
- MCP tool invocation (`mcp://`) — deferred, needs MCP server infra
- Conditional fan-out (`fan://`) — deferred, needs parallel task model
- Role enforcement (`roles[]` always `["*"]`)
- `parallel` flag (always false)
- UI/TUI changes — engine is backend-only, views consume via existing PG queries
- `approve://` as separate action type — approval is a **decision**, not an action. Any action can return `{"action": "hold", "approval": "..."}`.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Actions return decisions (JSON) | Programmable: any action can drive any routing. Scripts, webhooks, agents all speak the same protocol. |
| Transitions = graph routing | Columns are nodes, transitions are edges. Decision events match transition events to pick the edge. More powerful than linear advance. |
| Auto-advance = default edge | When no transition matches and auto_advance=true, go to next by position. Preserves simple linear flows. |
| `approve://` is NOT a separate action type | Approval is a decision output (`{"action": "hold", "approval": "..."}`) that any action can return. This means a script can decide "this needs human review" at runtime. |
| Plain text fallback | Scripts that don't output JSON still work: exit 0 = advance, non-zero = fail. Low friction for simple automation. |
| Max 2 retries, chain depth 20 | Prevents infinite loops from misconfigured boards |
| PG events for completion signals | `genie_runtime_events` + `pg_notify` — durable, queryable, already in the codebase |

## Success Criteria

- [ ] `moveTask()` rejects unauthorized actor for column gate
- [ ] Gate evaluations logged in `task_gate_evaluations` table
- [ ] Skill action (`/work`) spawns agent when task enters column
- [ ] Script action (`!bun test`) runs command, parses stdout as decision
- [ ] Webhook action (`https://ci.example.com`) POSTs task context, parses response as decision
- [ ] Agent action (`agent://reviewer`) dispatches to named agent, awaits decision
- [ ] Decision `{"action": "route", "event": "pass"}` matches transition and routes to target column
- [ ] Decision `{"action": "hold", "approval": "felipe"}` blocks task until `genie task approve`
- [ ] Decision `{"action": "advance", "to": "QA"}` routes directly to named column
- [ ] Auto-advance works when no transition matches and `auto_advance=true`
- [ ] On-fail invoked on action failure, max 2 retries then BLOCKED
- [ ] Auto-advance chain stops at human-gated column
- [ ] Context carry-over: previous action output available as input for next action
- [ ] Action runs recorded in `task_action_runs` with full audit trail
- [ ] Full integration test: task flows through graph with branching transitions
- [ ] `genie task approve` / `genie task reject` CLI commands work
- [ ] `bun run check` passes (typecheck + lint + tests)

## Execution Strategy

### Wave 1 (parallel — schema + gate enforcement)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | PG migrations: `task_action_runs` + `task_gate_evaluations` |
| 2 | engineer | Gate enforcement in `moveTask()` + gate evaluation logging |

### Wave 2 (after Wave 1 — core engine)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Action dispatcher + decision evaluator + transition router + run tracking |
| 4 | engineer | Auto-advance engine + chain depth limit + on-fail handler |

### Wave 3 (after Wave 2 — action types + CLI)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | Webhook action (`https://`) + agent action (`agent://`) |
| 6 | engineer | Approval hold decision + `genie task approve/reject` CLI |

### Wave 4 (integration)
| Group | Agent | Description |
|-------|-------|-------------|
| 7 | engineer | Workflow listener wired into scheduler-daemon + integration test |
| review | reviewer | Full review of Groups 1-7 |

## Execution Groups

### Group 1: PG Migrations
**Goal:** Create the two tracking tables the runtime needs.

**Deliverables:**
1. `src/db/migrations/027_workflow_runtime.sql`:
   - `task_action_runs` table: id, task_id, column_id, board_id, action (text), action_type (skill/script/webhook/agent), status (started/completed/failed), decision (jsonb — the action's output decision), agent_id, exit_code, output (text), error (text), retries (int), context_in (jsonb — carry-over from previous run), started_at, completed_at
   - `task_gate_evaluations` table: id, task_id, column_id, board_id, gate_type, actor_type, actor_id, result (allowed/denied), reason (text), created_at
   - Indexes on task_id, board_id, status

**Acceptance Criteria:**
- [ ] Migration runs without errors on existing DB
- [ ] Tables created with correct columns and indexes
- [ ] Idempotent (IF NOT EXISTS)

**Validation:**
```bash
bun run typecheck && bun test src/lib/board-service.test.ts
```

**depends-on:** none

---

### Group 2: Gate Enforcement
**Goal:** `moveTask()` checks column gate before allowing the transition.

**Deliverables:**
1. In `src/lib/task-service.ts` moveTask():
   - After resolving column, read `column.gate` from board JSONB
   - Check actor type: 'human' gate → reject if actor is agent; 'agent' gate → reject if actor is human; 'human+agent' → allow both
   - Log evaluation to `task_gate_evaluations` table
   - Return clear error: "Gate denied: column X requires human actor"
2. Tests in `src/lib/task-service.test.ts`

**Acceptance Criteria:**
- [ ] Agent cannot move task to human-gated column
- [ ] Human can move task to human or human+agent column
- [ ] Gate evaluation recorded in task_gate_evaluations
- [ ] Clear error message on gate denial

**Validation:**
```bash
bun test src/lib/task-service.test.ts
```

**depends-on:** Group 1

---

### Group 3: Action Dispatcher + Decision Evaluator + Transition Router
**Goal:** When a task enters a column with an action, dispatch it, parse the decision, and route via transitions.

**Deliverables:**
1. New file `src/lib/workflow-engine.ts`:
   - `dispatchAction(taskId, column, board, repoPath)` — detect action prefix, execute
   - `parseDecision(output, exitCode?)` — parse stdout/response as decision JSON, fallback to exit code wrapping
   - `evaluateDecision(decision, column, board)` — match decision against column's `transitions[]`:
     - If `decision.action === "route"` and `decision.event` matches a transition → route to `transition.target`
     - If `decision.action === "advance"` and `decision.to` → route to named column
     - If `decision.action === "advance"` and `column.auto_advance` → move to next by position
     - If `decision.action === "hold"` → mark task held, send approval request
     - If `decision.action === "fail"` → invoke on_fail handler
     - If `decision.action === "notify"` → send notification via Omni, then advance
     - If `decision.action === "spawn"` → dispatch agent, await their decision
   - `recordActionStart/Complete/Failed()` → INSERT/UPDATE `task_action_runs`
   - Load previous column's run output as `context_in` for current run
2. Wire into `moveTask()` — after successful move, call `dispatchAction()`
3. Emit runtime events for action.completed and action.failed

**Acceptance Criteria:**
- [ ] Skill action spawns agent with correct skill
- [ ] Script action runs command, parses stdout as decision
- [ ] Decision with matching transition routes to correct target column
- [ ] Decision with no matching transition falls through to auto_advance
- [ ] Action lifecycle recorded in task_action_runs
- [ ] Context carry-over works

**Validation:**
```bash
bun test src/lib/workflow-engine.test.ts
```

**depends-on:** Group 1

---

### Group 4: Auto-Advance + On-Fail
**Goal:** Chain actions together and handle failures.

**Deliverables:**
1. In `src/lib/workflow-engine.ts`:
   - `handleActionComplete(taskId, runId)`:
     - Parse decision from completed run
     - Evaluate against transitions
     - If routed: call `moveTask()` to target column
     - If auto_advance and no transition match: move to next column by position
     - Chain depth counter — max 20
     - Stop at human-gated column
   - `handleActionFailed(taskId, runId, error)`:
     - Read `column.on_fail` from board JSONB
     - If set and retries < 2: dispatch on_fail action, increment retry
     - If retries >= 2 or no on_fail: mark task BLOCKED
2. Tests for graph routing, chain behavior, and retry limits

**Acceptance Criteria:**
- [ ] Transition routing works: decision event → matching transition → target column
- [ ] Auto-advance works when no transition matches
- [ ] Chain stops at human-gated column
- [ ] Chain stops at max depth 20
- [ ] On-fail invoked on failure, max 2 retries
- [ ] Task BLOCKED after exhausting retries

**Validation:**
```bash
bun test src/lib/workflow-engine.test.ts
```

**depends-on:** Group 3

---

### Group 5: Webhook + Agent Action Types
**Goal:** HTTP and agent-dispatch action types.

**Deliverables:**
1. Webhook handler in `src/lib/workflow-engine.ts`:
   - POST to URL with JSON body: `{task_id, task_title, column, board, context_in}`
   - Parse response body as decision JSON
   - Timeout (30s) → `{"action": "fail", "reason": "timeout"}`
2. Agent handler:
   - Parse `agent://<name>` → `genie send '<task context>' --to <name>`
   - Agent signals completion via runtime event with decision
   - Configurable timeout (default 30min)
3. Tests with mock HTTP server

**Acceptance Criteria:**
- [ ] Webhook POSTs task context, parses response as decision
- [ ] Timeout → fail decision
- [ ] Agent action dispatches to named agent
- [ ] Agent completion detected via runtime event

**Validation:**
```bash
bun test src/lib/workflow-engine.test.ts
```

**depends-on:** Group 3

---

### Group 6: Approval Hold + CLI
**Goal:** Handle `hold` decisions and CLI approve/reject.

**Deliverables:**
1. In `src/lib/workflow-engine.ts`:
   - Hold handler: when decision is `{"action": "hold", "approval": "<approver>"}`:
     - Mark task_action_run as `held`
     - Send approval request via Omni (if connected)
     - Task stays in column until approved
   - On approval → re-evaluate as `{"action": "advance"}`
   - On rejection → re-evaluate as `{"action": "fail", "reason": "rejected by <actor>"}`
2. CLI commands in `src/term-commands/task.ts`:
   - `genie task approve #<seq>` — approve held task, triggers advance
   - `genie task reject #<seq>` — reject held task, triggers on_fail
3. Tests

**Acceptance Criteria:**
- [ ] Hold decision blocks task in column
- [ ] `genie task approve` advances the task
- [ ] `genie task reject` triggers on_fail
- [ ] Approval request sent to Omni when connected

**Validation:**
```bash
bun test src/lib/workflow-engine.test.ts
```

**depends-on:** Group 3

---

### Group 7: Workflow Listener + Integration Test
**Goal:** Central engine wired into scheduler-daemon, with full graph integration test.

**Deliverables:**
1. In `src/lib/workflow-engine.ts`:
   - `startWorkflowListener()` — subscribes to task events via PG LISTEN/NOTIFY
   - On task.moved → dispatch action
   - On action.completed → evaluate decision → route
   - On action.failed → handle on-fail
   - Graceful shutdown
2. Wire into `src/lib/scheduler-daemon.ts` startup
3. Integration test: create board with transitions (software template), create task, move to Triage → auto-advance through agent columns → branch at Review (pass → QA, fail → Build) → stop at human gate

**Acceptance Criteria:**
- [ ] Listener starts with daemon
- [ ] Full graph routing integration test passes
- [ ] Task branches correctly at transition points
- [ ] Graceful shutdown

**Validation:**
```bash
bun test src/lib/workflow-engine.test.ts && bun run check
```

**depends-on:** Groups 4, 5, 6

---

## VNext (deferred)

- **MCP tool invocation** (`mcp://`) — needs MCP server infrastructure
- **Conditional fan-out** (`fan://`) — needs parallel task model
- **Transition condition evaluator** — `condition` field on transitions for expression-based routing
- **Role enforcement** — check actor role against `column.roles[]`
- **Parallel execution** — `column.parallel=true` runs multiple actions concurrently

## Files to Create/Modify

```
# CREATE
src/db/migrations/027_workflow_runtime.sql
src/lib/workflow-engine.ts
src/lib/workflow-engine.test.ts

# MODIFY
src/lib/task-service.ts (gate enforcement in moveTask)
src/lib/task-service.test.ts (gate tests)
src/lib/scheduler-daemon.ts (start workflow listener)
src/term-commands/task.ts (approve/reject commands)
```
