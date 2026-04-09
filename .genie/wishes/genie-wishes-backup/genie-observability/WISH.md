# Wish: Genie Observability & Learning Layer

| Field | Value |
|-------|-------|
| **Status** | DEFERRED |
| **Slug** | `genie-observability` |
| **Date** | 2026-03-20 |
| **Design** | [DESIGN.md](../../brainstorms/work-fire-forget/DESIGN.md) |
| **depends-on** | `pgserve-embed` |

## Summary

Build the observability and learning CLI on top of pgserve. Track agent metrics, error patterns, prompt effectiveness, and machine state. Enable `genie metrics`, `genie errors`, and `genie trace` commands for debugging and optimization. Annotate runs for training data.

## Scope

### IN
- `genie metrics` — summary stats: runs, success rate, avg duration, by role/provider/model
- `genie errors` — recurring error patterns with occurrence count and resolution status
- `genie trace <trace-id>` — full chain: trigger → run → heartbeats → audit events → result
- Agent metrics collection: hook into `genie done` and `genie spawn` to record spawn_latency_ms, run_duration_ms, outcome
- Error pattern extraction: on run failure, fingerprint the error, upsert to error_patterns
- Prompt outcome tracking: after `/review` verdict, record prompt_hash + verdict + fix_loops
- Run annotation: `genie annotate <run-id> --label quality=good` for training data
- Machine state snapshots: integrate with scheduler heartbeat loop (or standalone collector)

### OUT
- No dashboards or web UI
- No external metrics export (Prometheus, Datadog) — Tier 3
- No AI-powered error analysis — just storage and retrieval
- No changes to agent prompts or behavior
- No NATS integration

## Decisions

| Decision | Rationale |
|----------|-----------|
| CLI-first, no dashboards | Genie is a CLI tool. Operators query via terminal. Web UI is Tier 3. |
| Error fingerprinting via hash | Normalize error message, hash it. Group recurring errors automatically. |
| Prompt hash, not full prompt | Store hash + first 500 chars. Full prompts are in wish files, not DB. |
| Annotation is manual | Human labels runs as good/bad. No auto-labeling yet. |

## Success Criteria

- [ ] `genie metrics` shows total runs, success rate, avg duration for last 24h
- [ ] `genie metrics --role engineer` filters by role
- [ ] `genie metrics --since 7d` filters by time window
- [ ] `genie errors` shows top 10 recurring errors with count and last_seen
- [ ] `genie errors --unresolved` filters to unresolved only
- [ ] `genie trace <id>` shows complete chain with timestamps
- [ ] `genie annotate <run-id> --label quality=good` updates run annotations
- [ ] Agent metrics auto-recorded on every `genie done` (duration, outcome)
- [ ] Error patterns auto-extracted on run failure
- [ ] `bun run check` passes

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Metrics collection hooks + `genie metrics` CLI |
| 2 | engineer | Error pattern extraction + `genie errors` CLI |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | `genie trace` + `genie annotate` + prompt outcomes |

### Wave 3 (after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review all changes |

## Execution Groups

### Group 1: Metrics collection + CLI

**Goal:** Auto-record agent performance metrics and expose via CLI.

**Deliverables:**
1. Hook into `genie done` and run completion paths:
   - On completion: INSERT into `agent_metrics` (role, provider, model, wish_slug, group_name, spawn_latency_ms, run_duration_ms, outcome, error_category)
   - `spawn_latency_ms`: diff between trigger `fired_at` and run `started_at` (if available)
   - `run_duration_ms`: from run record `duration_ms` computed column
   - `outcome`: derived from exit_code and run status
2. Create `src/term-commands/metrics.ts`:
   - `genie metrics` — aggregate: total runs, success rate (%), avg duration, by time window
   - `genie metrics --role <role>` — filter by agent role
   - `genie metrics --provider <provider>` — filter by provider
   - `genie metrics --since <duration>` — time window (1h, 24h, 7d, 30d)
   - `genie metrics --json` — JSON output
3. Register in `src/genie.ts`

**Acceptance Criteria:**
- [ ] `agent_metrics` row created on every run completion
- [ ] `genie metrics` shows summary with real data
- [ ] Filters by role, provider, time window work correctly
- [ ] Handles empty database gracefully (no runs yet)

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** none

---

### Group 2: Error pattern extraction + CLI

**Goal:** Auto-extract recurring error patterns and expose via CLI.

**Deliverables:**
1. Create `src/lib/error-patterns.ts`:
   - `extractErrorPattern(run)` — called on run failure
   - Normalize error: strip timestamps, paths, UUIDs → create fingerprint hash
   - UPSERT to `error_patterns`: increment `occurrence_count`, update `last_seen`, store context
2. Create `src/term-commands/errors.ts`:
   - `genie errors` — top 10 by occurrence_count, show fingerprint, message, count, last_seen, resolved
   - `genie errors --unresolved` — filter to resolved=false
   - `genie errors --since <duration>` — time window
   - `genie errors resolve <fingerprint> --resolution "Fixed by ..."` — mark resolved
   - `genie errors --json` — JSON output
3. Register in `src/genie.ts`

**Acceptance Criteria:**
- [ ] Run failure auto-creates/updates error_patterns row
- [ ] Same error twice → occurrence_count=2, not duplicate rows
- [ ] `genie errors` shows patterns sorted by occurrence_count desc
- [ ] `genie errors resolve` marks pattern as resolved

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** none

---

### Group 3: Trace + annotate + prompt outcomes

**Goal:** Full request tracing, run annotation, and prompt effectiveness tracking.

**Deliverables:**
1. Create `src/term-commands/trace.ts`:
   - `genie trace <trace-id>` — query across tables by trace_id:
     - trigger (when created, when fired)
     - run (status, duration, pane, worker)
     - heartbeats (timeline of state changes)
     - audit_events (all transitions)
     - agent_metrics (performance)
   - Display as timeline with timestamps
2. Add `genie annotate <run-id> --label <key>=<value>`:
   - UPDATE runs SET annotations = annotations || '{"key": "value"}'
   - Support multiple labels: `--label quality=good --label speed=fast`
3. Hook into `/review` verdict path:
   - After review completes: INSERT `prompt_outcomes` (run_id, prompt_hash, role, verdict, fix_loops)
   - `prompt_hash`: hash of the prompt bundle used for the run
4. Register in `src/genie.ts`

**Acceptance Criteria:**
- [ ] `genie trace <id>` shows complete timeline across all tables
- [ ] `genie annotate <run> --label quality=good` updates run's annotations JSONB
- [ ] Review verdict auto-records prompt_outcomes row
- [ ] Handles missing trace_id gracefully (not found message)

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** Group 1, Group 2

---

## QA Criteria

- [ ] Run an agent end-to-end → `genie metrics` shows the run
- [ ] Force a failure → `genie errors` shows the pattern
- [ ] Run with trace_id → `genie trace <id>` shows full chain
- [ ] Annotate a run → `genie db query "SELECT annotations FROM runs WHERE id='...'"` shows labels
- [ ] No performance regression on `genie done` or `genie spawn` from metrics hooks
- [ ] `bun run check` passes

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Metrics INSERT adds latency to `genie done` | Low | Async INSERT (fire-and-forget). Don't block agent exit. |
| Error fingerprinting too aggressive (different errors same hash) | Medium | Include error_category in fingerprint. Tune normalization. |
| prompt_outcomes depend on /review integration point | Medium | Hook at review verdict output. Graceful skip if not available. |

## Files to Create/Modify

```
src/lib/error-patterns.ts        — NEW: error extraction + fingerprinting
src/term-commands/metrics.ts     — NEW: genie metrics CLI
src/term-commands/errors.ts      — NEW: genie errors CLI
src/term-commands/trace.ts       — NEW: genie trace + genie annotate
src/term-commands/state.ts       — hook metrics collection into genie done
src/genie.ts                     — register metrics/errors/trace/annotate commands
```
