# Wish: Workflow Engine Runtime — Make the Pipeline Real

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `workflow-engine-runtime` |
| **Date** | 2026-03-28 |
| **Design** | [DESIGN.md](../../brainstorms/workflow-engine-runtime/DESIGN.md) |
| **depends-on** | PR #831 (PG events migration) must be merged first |

## Summary
Board columns already define gates, actions, auto-advance, and on-fail handlers — but nothing executes them. This wish builds the ~450-line runtime that connects the schema to actual behavior. After this, dropping a task into a column triggers its action, gates prevent unauthorized moves, and auto-advance chains agent columns together until hitting a human gate.

## Scope

### IN
- **PG migrations** — `task_action_runs` and `task_gate_evaluations` tables
- **Gate enforcement** — moveTask() checks actor type vs column gate before allowing transition
- **Action dispatch** — when task enters a column with an action, dispatch it:
  - `/skill` → spawn agent with skill (via genie spawn)
  - `!command` → run shell command, capture exit code + output
- **Auto-advance** — when action completes and column has auto_advance=true, move to next column
- **On-fail handler** — when action fails and column has on_fail set, invoke it (max 2 retries)
- **Workflow listener** — central engine that subscribes to task.moved events and orchestrates the pipeline
- **Tests** — unit tests for gate logic, action dispatch, auto-advance, on-fail

### OUT
- Webhook actions (#852)
- A2A actions (#853)
- Human approval via messaging (#854)
- MCP tool invocation (#855)
- Conditional fan-out (#856)
- Transition condition evaluator (transitions[] not used yet)
- Role enforcement (roles[] always ["*"])
- Parallel flag (always false)
- UI/TUI changes

## Decisions

| Decision | Rationale |
|----------|-----------|
| PG events for completion signals | PR #831 gives us genie_runtime_events + pg_notify — durable, queryable |
| Gate enforcement inside moveTask() | Single choke point — all task moves go through this function |
| Action prefix dispatch (`/` skill, `!` script) | Simple, extensible — add new prefixes for new types |
| task_action_runs table | Need audit trail: who ran what, when, result, retries |
| Max 2 retries before BLOCKED | Prevents infinite loops, matches proven dream pattern |
| Chain depth limit = 20 | Prevents infinite auto-advance cycles |

## Success Criteria

- [ ] moveTask() rejects unauthorized actor for column gate
- [ ] Gate evaluations logged in task_gate_evaluations table
- [ ] Skill action (`/work`) spawns agent when task enters column
- [ ] Script action (`!bun test`) runs command, captures exit code
- [ ] Action run recorded in task_action_runs (started → completed/failed)
- [ ] auto_advance=true moves task to next column on action success
- [ ] on_fail invoked on action failure
- [ ] Task marked BLOCKED after 2 failed retries
- [ ] Auto-advance chain stops at human-gated column
- [ ] Full integration test: task flows Triage→Work→Review with auto-advance stopping at Review (human gate)

## Execution Strategy

### Wave 1 (parallel — schema + gate enforcement)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | PG migrations: task_action_runs + task_gate_evaluations |
| 2 | engineer | Gate enforcement in moveTask() + gate evaluation logging |

### Wave 2 (after Wave 1 — action dispatch)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Action dispatcher: skill (`/`) + script (`!`) dispatch |
| 4 | engineer | task_action_runs recording (started/completed/failed/retries) |

### Wave 3 (after Wave 2 — auto-advance + on-fail)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | Auto-advance engine + chain depth limit |
| 6 | engineer | On-fail handler + retry logic (max 2) |

### Wave 4 (after Wave 3 — integration)
| Group | Agent | Description |
|-------|-------|-------------|
| 7 | engineer | Workflow listener: tie it all together, subscribe to events |
| review | reviewer | Full review of Groups 1-7 |

## Execution Groups

### Group 1: PG Migrations
**Goal:** Create the two tracking tables the runtime needs.

**Deliverables:**
1. `src/db/migrations/011_workflow_runtime.sql`:
   - `task_action_runs` table: id, task_id, column_id, board_id, action (text), action_type (skill/script), status (started/completed/failed), agent_id, exit_code, output (text), error (text), retries (int), started_at, completed_at
   - `task_gate_evaluations` table: id, task_id, column_id, board_id, gate_type, actor_type, actor_id, result (allowed/denied), reason (text), created_at
   - Indexes on task_id, board_id, status

**Acceptance Criteria:**
- [ ] Migration runs without errors on existing DB
- [ ] Tables created with correct columns and indexes
- [ ] Idempotent (IF NOT EXISTS)

**Validation:**
```bash
genie db migrate && genie db query "SELECT column_name FROM information_schema.columns WHERE table_name = 'task_action_runs'" && genie db query "SELECT column_name FROM information_schema.columns WHERE table_name = 'task_gate_evaluations'"
```

**depends-on:** PR #831 merged

---

### Group 2: Gate Enforcement
**Goal:** moveTask() checks column gate before allowing the transition.

**Deliverables:**
1. In `src/lib/task-service.ts` moveTask():
   - After resolving column, read column.gate from board JSONB
   - Check actor type: 'human' gate → reject if actor is agent; 'agent' gate → reject if actor is human; 'human+agent' → allow both
   - Log evaluation to task_gate_evaluations table
   - Return clear error: "Gate denied: column X requires human actor"
2. Tests in `src/lib/task-service.test.ts`

**Acceptance Criteria:**
- [ ] Agent cannot move task to human-gated column
- [ ] Human can move task to any column (human or human+agent)
- [ ] Gate evaluation recorded in task_gate_evaluations
- [ ] Clear error message on gate denial

**Validation:**
```bash
bun test src/lib/task-service.test.ts
```

**depends-on:** Group 1

---

### Group 3: Action Dispatcher
**Goal:** When a task enters a column with an action, dispatch it.

**Deliverables:**
1. New file `src/lib/workflow-engine.ts`:
   - `dispatchAction(taskId, column, repoPath)` function
   - If action starts with `/` → skill: run `genie spawn engineer --skill <action> --session <project-session>`
   - If action starts with `!` → script: run shell command via `execSync`, capture exit code + stdout
   - If action is null → no-op
   - Record action start in task_action_runs table
2. Wire into moveTask() — after successful move, call dispatchAction()

**Acceptance Criteria:**
- [ ] Skill action spawns agent with correct skill
- [ ] Script action runs command and captures exit code
- [ ] Null action does nothing
- [ ] Action start recorded in task_action_runs

**Validation:**
```bash
bun test src/lib/workflow-engine.test.ts
```

**depends-on:** Group 1

---

### Group 4: Action Run Tracking
**Goal:** Record action lifecycle in task_action_runs.

**Deliverables:**
1. In `src/lib/workflow-engine.ts`:
   - `recordActionStart(taskId, columnId, action, actionType, agentId?)` → INSERT
   - `recordActionComplete(runId, exitCode?, output?)` → UPDATE status=completed
   - `recordActionFailed(runId, error, retryCount)` → UPDATE status=failed
   - Subscribe to PG runtime events for action completion signals
2. Emit `genie.task.<id>.action.completed` and `genie.task.<id>.action.failed` events

**Acceptance Criteria:**
- [ ] Action start creates task_action_runs row with status=started
- [ ] Action completion updates row with status=completed + timestamp
- [ ] Action failure updates row with status=failed + error
- [ ] Events emitted on completion/failure

**Validation:**
```bash
bun test src/lib/workflow-engine.test.ts
```

**depends-on:** Group 3

---

### Group 5: Auto-Advance Engine
**Goal:** When an action completes and column has auto_advance=true, move to next column.

**Deliverables:**
1. In `src/lib/workflow-engine.ts`:
   - `handleActionComplete(taskId, runId)` function
   - Read column.auto_advance from board JSONB
   - If true: call moveTask() to next column (position + 1)
   - Chain depth counter — max 20 to prevent infinite loops
   - Stop chaining when hitting a column with no action or human gate
2. Tests for chain behavior

**Acceptance Criteria:**
- [ ] auto_advance=true moves task to next column on success
- [ ] auto_advance=false leaves task in current column
- [ ] Chain stops at human-gated column
- [ ] Chain stops at max depth 20
- [ ] Chain stops at column with no action

**Validation:**
```bash
bun test src/lib/workflow-engine.test.ts
```

**depends-on:** Group 4

---

### Group 6: On-Fail Handler
**Goal:** When an action fails and on_fail is set, invoke it. Max 2 retries.

**Deliverables:**
1. In `src/lib/workflow-engine.ts`:
   - `handleActionFailed(taskId, runId, error)` function
   - Check column.on_fail from board JSONB
   - If set and retries < 2: dispatch on_fail action, increment retry
   - If retries >= 2: mark task as blocked, emit blocked event
   - If on_fail is null: mark task as blocked immediately
2. Tests for retry behavior

**Acceptance Criteria:**
- [ ] on_fail action invoked on failure
- [ ] Retry count incremented
- [ ] Task blocked after 2 retries
- [ ] Task blocked immediately if no on_fail defined

**Validation:**
```bash
bun test src/lib/workflow-engine.test.ts
```

**depends-on:** Group 4

---

### Group 7: Workflow Listener
**Goal:** Central engine that ties everything together.

**Deliverables:**
1. In `src/lib/workflow-engine.ts`:
   - `startWorkflowListener()` function — subscribes to task events via PG LISTEN/NOTIFY
   - On task.moved → dispatch action (Group 3)
   - On action.completed → handle auto-advance (Group 5)
   - On action.failed → handle on-fail (Group 6)
   - Graceful shutdown — stop listening on daemon exit
2. Wire into scheduler-daemon.ts startup
3. Integration test: create board with software template, create task, move to Triage → auto-advance through agent columns → stop at human gate

**Acceptance Criteria:**
- [ ] Listener starts with daemon
- [ ] Listener processes task.moved events
- [ ] Listener processes action.completed events
- [ ] Listener processes action.failed events
- [ ] Full chain integration test passes
- [ ] Graceful shutdown on daemon stop

**Validation:**
```bash
bun test src/lib/workflow-engine.test.ts && bun test
```

**depends-on:** Groups 5, 6

---

## QA Criteria

- [ ] Full test suite passes (existing + new tests)
- [ ] Board with software template: task auto-flows through agent columns
- [ ] Human gate blocks auto-advance — requires manual move
- [ ] Script action (`!echo hello`) runs and captures output
- [ ] Failed action triggers on_fail, retries, then blocks
- [ ] task_action_runs table has complete audit trail
- [ ] task_gate_evaluations table has gate check history
- [ ] No regressions — existing moveTask() behavior preserved for tasks without boards

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| PR #831 not merged | BLOCKING | Must merge before starting Group 1 |
| PG LISTEN/NOTIFY missed events | Medium | Hybrid polling fallback (PR #831 pattern) |
| Script injection via action field | Medium | Validate: no pipes, redirects, or semicolons in script actions |
| Infinite auto-advance loop | High | Max chain depth 20 + cycle detection |
| Agent spawn fails silently | Medium | Record failure in task_action_runs, trigger on_fail |

## Files to Create/Modify

```
# CREATE
src/db/migrations/011_workflow_runtime.sql
src/lib/workflow-engine.ts
src/lib/workflow-engine.test.ts

# MODIFY
src/lib/task-service.ts (gate enforcement in moveTask)
src/lib/task-service.test.ts (gate tests)
src/lib/scheduler-daemon.ts (start workflow listener)
```
