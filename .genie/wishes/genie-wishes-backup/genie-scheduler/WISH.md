# Wish: Genie Scheduler Daemon

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `genie-scheduler` |
| **Date** | 2026-03-20 |
| **Design** | [DESIGN.md](../../brainstorms/work-fire-forget/DESIGN.md) |
| **depends-on** | `pgserve-embed`, `fire-and-forget` |

## Summary

Build the scheduler daemon that fires triggers from pgserve. Supports time-based and interval triggers via `genie schedule` CLI. Runs as a systemd service with lease-based claiming, reboot recovery, and orphan reconciliation. Uses the RunSpec/RunState model from Codex patterns.

## Scope

### IN
- `genie schedule create/list/cancel/retry/history` CLI commands
- `genie daemon install/start/stop/status/logs` CLI commands
- Scheduler daemon: LISTEN/NOTIFY + 30s poll fallback
- Lease-based trigger claiming: `SELECT FOR UPDATE SKIP LOCKED`
- RunSpec/RunState state machine
- Idempotency keys for double-fire prevention
- Reboot recovery: reclaim expired leases, reconcile orphaned runs
- Catch-up storm prevention: jitter + max_concurrent + global cap
- trace_id propagation: trigger → spawn env (`GENIE_TRACE_ID`) → run record
- Heartbeat collection every 60s
- Orphan reconciliation every 5m
- systemd service template generation
- Structured JSON logging to `~/.genie/logs/scheduler.log`

### OUT
- No NATS event ingress (Tier 2 — separate wish)
- No Omni integration
- No event-based triggers (only time/interval in Tier 1)
- No web UI or dashboard
- No distributed scheduler (single machine only)

## Decisions

| Decision | Rationale |
|----------|-----------|
| LISTEN/NOTIFY + 30s poll | NOTIFY is low-latency. Poll is safety net if NOTIFY missed. |
| Lease timeout from RunSpec (default 5m) | Different tasks need different timeouts. Configurable per schedule. |
| Jitter on catch-up | Random 0-30s prevents thundering herd after reboot |
| Global concurrency cap (default 5) | Prevent runaway spawns. Configurable via `GENIE_MAX_CONCURRENT` |
| Conservative orphan reconciliation | Mark failed only after 2 missed heartbeats (>2min). Never auto-retry. |
| `--command` not just `--spawn` | Schedules can run any genie command, not just spawn |

## Success Criteria

- [ ] `genie schedule create "nightly-review" --command "genie spawn reviewer" --every "24h"` creates trigger
- [ ] `genie schedule list` shows pending triggers (table format)
- [ ] `genie schedule list --json` returns JSON array
- [ ] `genie schedule list --watch` updates live
- [ ] `genie schedule cancel nightly-review` cancels by name
- [ ] `genie schedule retry <id>` resets failed trigger to pending
- [ ] `genie schedule history <name>` shows past executions
- [ ] Scheduler daemon fires triggers within 5s of `due_at` (p99 over 100 triggers)
- [ ] Idempotency: same key twice → single execution
- [ ] Reboot recovery: expired leases reclaimed, orphaned runs marked failed
- [ ] `genie daemon install` generates working systemd unit
- [ ] `genie daemon status` shows PID, uptime, triggers fired count
- [ ] `genie daemon logs` tails structured JSON log
- [ ] trace_id present in run record and agent's `GENIE_TRACE_ID` env
- [ ] `bun run check` passes

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Scheduler daemon core (loop, leasing, spawning) |
| 2 | engineer | `genie schedule` CLI commands |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | `genie daemon` CLI + systemd template |
| 4 | engineer | Reboot recovery + orphan reconciliation + heartbeats |

### Wave 3 (after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review all changes |

## Execution Groups

### Group 1: Scheduler daemon core

**Goal:** Build the main daemon loop that claims and fires triggers.

**Deliverables:**
1. Create `src/lib/scheduler-daemon.ts`:
   - Main loop: LISTEN on `genie_trigger_due` + 30s poll fallback
   - On trigger due: `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 5`
   - For each: validate idempotency key, check `max_concurrent`, lease, resolve RunSpec, spawn via existing `genie spawn` layer, record run, mark fired
   - Set `GENIE_TRACE_ID` in spawn environment
   - Jitter: `Math.random() * 30000` ms delay on catch-up batches
   - Global concurrency: `GENIE_MAX_CONCURRENT` env (default 5)
   - Structured logging to `~/.genie/logs/scheduler.log`
2. Create `src/lib/run-spec.ts`:
   - RunSpec interface: repo, ref_policy, provider, role, model, command, approval_policy, concurrency_class, lease_timeout_ms
   - RunState type: `spawning | running | waiting_input | completed | failed | cancelled`
   - `resolveRunSpec()` — validate and fill defaults

**Acceptance Criteria:**
- [ ] Daemon loop processes due triggers within 5s
- [ ] Lease prevents double-claiming (concurrent daemon test)
- [ ] Jitter applied on batch catch-up (>3 triggers at once)
- [ ] `GENIE_TRACE_ID` set in spawned agent's environment
- [ ] Log file created with structured JSON entries

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** none

---

### Group 2: `genie schedule` CLI commands

**Goal:** Full CLI for managing schedules and triggers.

**Deliverables:**
1. Create `src/term-commands/schedule.ts`:
   - `genie schedule create <name> --command <cmd> --at <time> | --every <interval> | --after <duration>`
   - `genie schedule list [--json] [--watch]`
   - `genie schedule cancel <name|id> [--filter <expr>]`
   - `genie schedule retry <name|id>`
   - `genie schedule history <name|id> [--limit N]`
2. Time parsing: support "10m", "2h", "24h", "2026-03-21T09:00", cron expressions
3. Register commands in `src/genie.ts`

**Acceptance Criteria:**
- [ ] `create` inserts schedule + first trigger into PG
- [ ] `list` shows table with name, type, next_due, status
- [ ] `list --json` returns parseable JSON
- [ ] `list --watch` refreshes every 2s
- [ ] `cancel` sets schedule enabled=false and skips pending triggers
- [ ] `retry` resets failed trigger to pending with new due_at
- [ ] `history` shows past runs with status, duration, exit_code

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** none

---

### Group 3: `genie daemon` CLI + systemd template

**Goal:** Daemon lifecycle management and systemd integration.

**Deliverables:**
1. Add to `src/term-commands/daemon.ts`:
   - `genie daemon install` — generate `~/.config/systemd/user/genie-scheduler.service`, enable with `systemctl --user enable`
   - `genie daemon start [--foreground]` — start scheduler. `--foreground` for systemd ExecStart.
   - `genie daemon stop` — stop gracefully
   - `genie daemon status` — running/stopped, PID, uptime, triggers fired, last error
   - `genie daemon logs [--follow] [--lines N]` — tail `~/.genie/logs/scheduler.log`
2. Register commands in `src/genie.ts`

**Acceptance Criteria:**
- [ ] `daemon install` creates valid systemd unit file
- [ ] `daemon start` launches scheduler in background
- [ ] `daemon stop` sends SIGTERM, daemon exits gracefully
- [ ] `daemon status` shows accurate state
- [ ] `daemon logs` shows structured JSON log entries

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** Group 1

---

### Group 4: Reboot recovery + orphan reconciliation + heartbeats

**Goal:** Ensure scheduler recovers cleanly from crashes and reboots.

**Deliverables:**
1. In `src/lib/scheduler-daemon.ts` startup:
   - Reclaim expired leases: `UPDATE triggers SET status='pending' WHERE status='leased' AND leased_until < now()`
   - Reconcile orphaned runs: for runs with status='running', check if pane alive. If dead, mark failed.
2. Heartbeat collector (every 60s):
   - For each run with status='running': check pane alive, detect state (idle/working/permission), INSERT heartbeat
   - If 2 consecutive heartbeats show pane dead: UPDATE run status='failed'
3. Machine snapshot (every 60s):
   - Count active workers, teams, tmux sessions
   - Record CPU/memory if available
   - INSERT machine_snapshot

**Acceptance Criteria:**
- [ ] After restart with expired leases: triggers reset to pending
- [ ] Orphaned runs (pane dead, status running) marked failed within 2 heartbeats
- [ ] Heartbeat records exist for active runs
- [ ] Machine snapshots recorded periodically
- [ ] No false positives: running agents not marked as failed

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** Group 1

---

## QA Criteria

- [ ] Create schedule → daemon fires trigger → agent spawns → agent completes → run recorded
- [ ] Kill daemon mid-execution → restart → orphans reconciled, no duplicate fires
- [ ] Same idempotency key submitted twice → single run
- [ ] 50 due triggers at boot → jitter prevents thundering herd, all fire within 60s
- [ ] `genie schedule history` shows complete execution trail
- [ ] `genie trace <trace-id>` chains trigger → run → heartbeats
- [ ] `bun run check` passes

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| systemd not available (Docker, macOS) | Medium | `daemon start --foreground` works without systemd. Document alternatives. |
| Lease timeout too short for slow spawns | Medium | Configurable via RunSpec.lease_timeout_ms |
| Clock skew on shared machines | Low | Single pgserve instance = single clock. No distributed clocks. |
| Log file growth | Low | `genie db prune --older 30d` for cleanup |

## Files to Create/Modify

```
src/lib/scheduler-daemon.ts      — NEW: main daemon loop, leasing, spawning
src/lib/run-spec.ts              — NEW: RunSpec/RunState interfaces
src/term-commands/schedule.ts    — NEW: genie schedule create/list/cancel/retry/history
src/term-commands/daemon.ts      — NEW: genie daemon install/start/stop/status/logs
src/genie.ts                     — register schedule + daemon commands
```
