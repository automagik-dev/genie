# Wish: genie resume — Session-Resilient Agent Recovery

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `genie-resume` |
| **Date** | 2026-03-20 |
| **Design** | [DESIGN.md](../../brainstorms/genie-resume/DESIGN.md) |

## Summary

Make genie agents immortal by default. When a tmux pane dies (crash, reboot, OOM, manual kill), the daemon auto-resumes the agent with its full Claude Code conversation context via `--resume <sessionId>`. Adds `genie resume <name>` for manual recovery. Zero new infrastructure — extends the existing daemon orphan reconciliation, agent registry, and spawn flow. ~343 LOC.

## Scope

### IN
- `genie resume <name>` CLI command — respawns suspended/failed agent with `--resume <sessionId>`
- `genie resume --all` — resume all eligible agents in one shot
- `--no-auto-resume` flag on `genie spawn` — opt-out for throwaway agents
- Daemon auto-resume — extend `reconcileOrphans()` to attempt resume before marking `failed`
- Reboot recovery — extend `recoverOnStartup()` to auto-resume previously-running agents
- Agent interface fields: `autoResume`, `resumeAttempts`, `lastResumeAttempt`
- RunState extension: `failed → spawning` transition (guarded by retry budget)
- `genie ls` shows resume status for suspended/failed agents

### OUT
- Codeman-style 10-state respawn machine, adaptive timing, health scoring
- AI-powered idle detection
- TUI dashboard (Recon-style)
- tmux-resurrect/continuum layout serialization
- New persistence layer or module (reuse agent-registry + PG)
- Circuit breaker state machine (max retries is sufficient)

## Decisions

| Decision | Rationale |
|----------|-----------|
| `genie resume`, not `resurrect` | Mirrors `claude --resume`, `codex resume`. Ecosystem consistency. |
| Auto-resume by default (opt-out) | Agents should be immortal. Users disable for one-shot agents with `--no-auto-resume`. |
| Extend daemon, no new module | Daemon already has orphan detection, heartbeats, liveness, systemd, logging. ~100 LOC delta. |
| Max 3 auto-resume attempts, 60s cooldown | Prevents infinite loops. Structurally broken agents stop retrying. |
| Manual `genie resume` resets retry counter | User intervention = fresh budget. Only auto-resume exhausts the counter. |
| `genie stop` preserves auto-resume | `stop` → `suspended` → daemon will auto-resume. `kill` for permanent termination. |

## Success Criteria

- [ ] `genie resume <name>` respawns a suspended/failed agent with its Claude session ID
- [ ] `genie resume --all` resumes all eligible agents (has sessionId + retries remaining)
- [ ] Daemon auto-resumes dead agents within 5m of pane death
- [ ] Auto-resume is default — no flag needed to enable
- [ ] `genie spawn <name> --no-auto-resume` disables auto-resume for that agent
- [ ] After 3 failed auto-resume attempts, agent is permanently `failed` with `agent_resume_exhausted` log
- [ ] Manual `genie resume` resets the retry counter
- [ ] Daemon startup (reboot recovery) auto-resumes previously-running agents
- [ ] All resume events in `~/.genie/logs/scheduler.log` as structured JSON
- [ ] `genie ls` shows resume attempt count and auto-resume flag
- [ ] Resume respects `GENIE_MAX_CONCURRENT`
- [ ] `bun run check` passes (typecheck + lint + tests)

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Agent registry + RunState extensions |
| 2 | engineer | CLI: `genie resume` command + `--no-auto-resume` on spawn |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Daemon auto-resume: extend orphan reconciliation + reboot recovery |

### Wave 3 (after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | `genie ls` resume status + tests |
| review | reviewer | Full PR review |

## Execution Groups

### Group 1: Agent Registry + RunState Extensions
**Goal:** Add resume tracking fields to Agent interface and open `failed → spawning` RunState transition.

**Deliverables:**
1. `src/lib/agent-registry.ts` — Add to Agent interface:
   - `autoResume?: boolean` (default `true`)
   - `resumeAttempts?: number` (default `0`)
   - `lastResumeAttempt?: string` (ISO timestamp)
   - `maxResumeAttempts?: number` (default `3`)
2. `src/lib/run-spec.ts` — Add `'spawning'` to `RUN_STATE_TRANSITIONS.failed` array

**Acceptance Criteria:**
- [ ] Agent interface has all 4 new optional fields
- [ ] `RUN_STATE_TRANSITIONS.failed` includes `'spawning'`
- [ ] Existing tests pass — no regressions

**Validation:**
```bash
bun run typecheck && bun test src/lib/agent-registry.test.ts src/lib/run-spec.test.ts
```

**depends-on:** none

---

### Group 2: CLI — `genie resume` Command + `--no-auto-resume`
**Goal:** Add `genie resume <name>` and `genie resume --all` CLI commands, plus `--no-auto-resume` flag on `genie spawn`.

**Deliverables:**
1. `src/term-commands/agents.ts` — Add `handleWorkerResume(name, options)`:
   - Look up agent in registry
   - Verify `claudeSessionId` exists, error if not
   - Reset `resumeAttempts` to 0 (manual = fresh budget)
   - Execute spawn with `--resume <claudeSessionId>` using WorkerTemplate config
   - Update registry: new paneId, state, clear suspendedAt
   - `--all` mode: iterate all suspended/failed agents with sessionId
2. `src/genie.ts` — Register `resume` command with `--all` option
3. `src/term-commands/agents.ts` — Add `--no-auto-resume` option to `handleWorkerSpawn`, set `autoResume: false` in registry when used
4. `src/genie.ts` — Add `--no-auto-resume` flag to spawn command definition

**Acceptance Criteria:**
- [ ] `genie resume <name>` respawns a suspended agent
- [ ] `genie resume --all` resumes all eligible agents
- [ ] `genie spawn <name> --no-auto-resume` sets `autoResume: false` in registry
- [ ] Missing sessionId shows clear error message

**Validation:**
```bash
bun run typecheck
```

**depends-on:** Group 1

---

### Group 3: Daemon Auto-Resume
**Goal:** Extend orphan reconciliation and reboot recovery to attempt resume before marking agents failed.

**Deliverables:**
1. `src/lib/scheduler-daemon.ts` — Add `attemptAgentResume(deps, agentId)` helper:
   - Check `autoResume === true` (default true, so `undefined` = true)
   - Check `resumeAttempts < maxResumeAttempts` (default 3)
   - Check cooldown: `lastResumeAttempt` + 60s < now
   - Check concurrency cap not exceeded
   - Increment `resumeAttempts`, set `lastResumeAttempt`
   - Execute `genie spawn <name> --resume <sessionId>` via `deps.spawnCommand`
   - Log `agent_resume_attempted`, `agent_resume_succeeded`, `agent_resume_failed`, or `agent_resume_exhausted`
2. `src/lib/scheduler-daemon.ts` — Extend `reconcileOrphans()`:
   - Before marking run as `failed`, call `attemptAgentResume()`
   - If resume succeeds, update run status to `running` (not failed)
   - If resume exhausted (3 attempts), mark failed as before
3. `src/lib/scheduler-daemon.ts` — Extend `recoverOnStartup()`:
   - After `reconcileOrphanedRuns()`, scan agent registry for agents with `state !== 'suspended'` and `state !== 'done'` whose panes are dead
   - Attempt resume for each eligible agent
4. Add `resumeAgent` to `SchedulerDeps` interface for testability

**Acceptance Criteria:**
- [ ] Dead agent with `autoResume: true` is auto-resumed within 5m
- [ ] Agent with `autoResume: false` is marked failed (current behavior)
- [ ] After 3 failed attempts, agent is permanently `failed`
- [ ] 60s cooldown between auto-resume attempts
- [ ] Concurrency cap respected — skip if at limit
- [ ] All events logged to scheduler.log
- [ ] Reboot recovery resumes previously-running agents

**Validation:**
```bash
bun run typecheck && bun test src/lib/scheduler-daemon.test.ts
```

**depends-on:** Group 1, Group 2

---

### Group 4: `genie ls` Resume Status + Tests
**Goal:** Surface resume state in agent listing and add comprehensive test coverage.

**Deliverables:**
1. `src/term-commands/agents.ts` — Extend `handleLsCommand()`:
   - For suspended/failed agents, show `resumeAttempts`/`maxResumeAttempts` and `autoResume` flag
   - Example: `suspended (2/3 resumes, auto-resume: on)`
2. `src/__tests__/resume.test.ts` — New test file:
   - Manual resume happy path (suspended → respawned)
   - Manual resume with missing sessionId (error case)
   - Manual resume resets retry counter
   - `--all` mode resumes multiple agents
   - Auto-resume via daemon mock (happy path)
   - Auto-resume exhausted after 3 attempts
   - Cooldown enforcement (skip if too recent)
   - Opt-out via `--no-auto-resume`
   - Concurrency cap blocks resume (skip)
   - Reboot recovery scenario

**Acceptance Criteria:**
- [ ] `genie ls` shows resume status for suspended/failed agents
- [ ] All 10 test cases pass
- [ ] `bun run check` passes (typecheck + lint + dead-code + tests)

**Validation:**
```bash
bun run check
```

**depends-on:** Group 3

---

## QA Criteria

- [ ] `genie spawn test-agent` then kill the tmux pane → daemon auto-resumes within 5m
- [ ] `genie stop test-agent` then `genie resume test-agent` → agent resumes with conversation context
- [ ] `genie spawn throwaway --no-auto-resume` then kill pane → NOT auto-resumed, marked failed
- [ ] Kill daemon (`genie daemon stop`), kill agent pane, start daemon (`genie daemon start`) → agent auto-resumed on startup
- [ ] Kill agent pane 3 times in rapid succession → after 3rd failure, permanently marked failed
- [ ] `genie resume --all` with 3 suspended agents → all 3 resume
- [ ] `genie ls` shows correct resume attempt count and auto-resume flag
- [ ] No regressions: `bun run check` passes

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Claude `--resume` fails on expired session ID | Medium | Caught as resume failure, decrements retry budget |
| Concurrent resume (daemon + manual) | Medium | `acquireLock` on registry serializes all mutations |
| Infinite respawn loop | High | Max 3 attempts + 60s cooldown. Manual `genie resume` resets counter. |
| Daemon not running | Low | `genie resume` works standalone. Auto-resume is daemon bonus. |
| Concurrency cap blocks all resumes | Low | Skip and retry on next 5m cycle. Cap will clear as agents complete. |

---

## Review Results

### Plan Review — 2026-03-20

**Verdict: SHIP**

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Problem statement is one sentence and testable | PASS |
| 2 | Scope IN has concrete deliverables | PASS |
| 3 | Scope OUT is explicit | PASS |
| 4 | Every task has testable acceptance criteria | PASS |
| 5 | Tasks are bite-sized and independently shippable | PASS |
| 6 | Dependencies tagged | PASS |
| 7 | Validation commands exist for each group | PASS |

**Gaps (none blocking):**
- MEDIUM: G1 and G2 marked parallel but G2 depends-on G1 — verified safe because new Agent fields are `?:` optional (no compile error when absent)
- LOW: Test location `src/__tests__/` vs colocated — precedent exists (`events.test.ts`), correct for cross-cutting tests

**All referenced files verified:**
- `src/lib/agent-registry.ts` — Agent interface at line 31, `claudeSessionId` at line 57
- `src/lib/run-spec.ts` — `RUN_STATE_TRANSITIONS` at line 28, `failed: []` confirmed terminal
- `src/lib/scheduler-daemon.ts` — `reconcileOrphans()` at line 572, `recoverOnStartup()` at line 492
- `src/term-commands/agents.ts` — `SpawnOptions` at line 740, `handleWorkerStop` at line 1011
- `src/lib/idle-timeout.ts` — `suspendWorker()` at line 69
- `src/lib/scheduler-daemon.test.ts` — exists
- `src/lib/run-spec.test.ts` — exists

---

## Files to Create/Modify

```
src/lib/agent-registry.ts          — +15 LOC (4 new Agent fields)
src/lib/run-spec.ts                — +3 LOC (failed → spawning transition)
src/lib/scheduler-daemon.ts        — +80 LOC (attemptAgentResume, extend reconcile + recovery)
src/term-commands/agents.ts        — +75 LOC (handleWorkerResume + --no-auto-resume + ls status)
src/genie.ts                       — +20 LOC (resume command + --no-auto-resume flag)
src/__tests__/resume.test.ts       — +150 LOC (10 test cases) [NEW]
```
