# Wish: Hookify Performance Foundation

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `hookify-perf-foundation` |
| **Date** | 2026-04-28 |
| **Author** | felipe@namastex.ai |
| **Appetite** | L (~2 weeks) |
| **Branch** | `wish/hookify-perf-foundation` |
| **Design** | [DESIGN.md](../../brainstorms/hookify-perf-foundation/DESIGN.md) |

## Summary

Move Claude Code hook dispatch out of fork-per-event mode into a long-lived daemon (`genie serve --headless`) accessed by a compiled native client over `~/.genie/hook.sock`. Eliminates ~80–200 ms bun cold-start, kills Postgres connection churn, restores process-local handler caches, and ships persistent per-handler timing telemetry plus a data-driven pgserve tuning pass. Operations-first F1 fallback (fail-open + audit log) keeps Claude Code responsive when the daemon is down. This is delivery #1 of the umbrella "genie hookify layer over Claude Code" vision; third-party hook absorption and plugin registration are explicitly deferred.

## Scope

### IN

- Native binary `genie-hook` produced by `bun build --compile`, packaged with genie, ≤ 20 MB.
- Daemon socket listener at `~/.genie/hook.sock` (length-prefixed JSON), hosted by `genie serve --headless`.
- In-daemon dispatcher — port `dispatch()` from `src/hooks/index.ts` to run inside the daemon. Existing `Handler[]` registry runs unchanged; in-memory caches (`syncedSessions`, `enrichedSessions`, `EventCircuitBreaker`) retain state across events; single pooled Postgres connection.
- F1 fallback in the binary: socket missing / timeout → return empty JSON to Claude Code, append `{event, tool, command, ts, agent_id}` to `~/.genie/hook-fallback.log`. Append-only, size-capped, rate-limited by `(event, tool, reason)`.
- Hook-injector update at `src/hooks/inject.ts:34-40` (`buildDispatchCommand()`): detect compiled binary at install location, prefer it, fall back to existing `bun .../genie.js hook dispatch` when the binary is absent.
- Persistent performance telemetry via existing `startSpan/endSpan` plumbing at `src/hooks/index.ts:172-191` (writes through `src/lib/emit.ts:344-387` to `genie_runtime_events`); `isWideEmitEnabled()` flipped on by default for hook subsystem in daemon mode.
- New SQL migration `src/db/migrations/05X_hook_perf_baseline_view.sql` defining view `hook_perf_baseline` with columns `(event_name, tool_name, handler_name, p50_1h, p99_1h, p50_24h, p99_24h, p50_7d, p99_7d, sample_count_24h)` using `PERCENTILE_CONT`.
- `genie doctor --perf` subcommand: prints current vs. 7 d baseline P50/P99 per handler, flags any P99 regression > 50 %, surfaces last-5-min fallback-log entries as HIGH-severity.
- Pgserve tuning pass: 30-min workload profile under representative genie load (`pg_stat_statements` top-N, buffer-cache hit ratio, lock waits, connection saturation) feeding a tuned `postgresql.conf` patch for `~/.genie/data/pgserve` with rationale per setting.
- Bench harness at `test/hooks/genie-hook-perf.test.ts` driving 100 tool-events/sec for 60 s and asserting the performance targets.
- Daemon-outage integration test at `test/hooks/daemon-outage.test.ts` proving F1 fallback + log + `genie doctor` flag.
- Delivery report at `.genie/wishes/hookify-perf-foundation/REPORT.md` capturing before/after numbers (latency, PG conns, vmstat cs, cache hit ratio, pgserve tuning deltas).

### OUT

- Third-party hook absorption (Token Optimizer, ultratoken, etc. continue to register their own CC hooks; coexistence only).
- Plugin registration API for external handlers.
- Hot-reload of handler code.
- Migration tooling that rewrites foreign hooks inside user `~/.claude/settings.json`.
- Auto-restart / active remediation of the daemon (observability only this round).
- Client-side hardcoded deny rules for `branch-guard` / `orchestration-guard` (deny-class handlers fully rely on daemon; outage = silent-allow, by design — operationally mitigated via fallback log + `genie doctor`).
- Cross-host / remote daemon.
- Removal of the bun-based `genie hook dispatch` command (kept as dev/test/CI fallback).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Shape D — compiled thin client + daemon socket (over A: config-trim, B: native-binary-only, C: daemon-socket-only) | Largest perf win and the only shape that hosts the umbrella hookify vision. A/B can't host future deliveries; C leaves cold-start cost untouched. |
| 2 | Daemon owner: existing `genie serve --headless` | Already long-lived, already owns pgserve / scheduler / event-router. No new process. |
| 3 | Socket: `~/.genie/hook.sock` (UDS) | Per-user, no port conflicts, matches existing genie state convention. |
| 4 | Compile via `bun build --compile` | Reuses TS code; no Rust/Go bring-up; ~10–20 MB static binary. |
| 5 | Fallback semantics: F1 (fail-open silent + audit log) | Operations must never stop. Daemon-down ≠ CC-frozen. Audit-log gap during outage is acceptable, observable, and bounded. |
| 6 | Self-heal via observability only this delivery | Fallback log + `genie doctor` surface enough for an operator to act. Active remediation is delivery #2+. |
| 7 | Wire protocol: length-prefixed JSON over UDS | Trivial framing; first-class Bun + Node support; no HTTP overhead. |
| 8 | Persist performance telemetry through existing `startSpan/endSpan` | Wiring already exists at `src/hooks/index.ts:172-191`; just toggle on by default in daemon mode and add aggregation view. |
| 9 | Include pgserve tuning in this delivery | Real workload data exists; tuning is config-only and tightly coupled to daemon-mode steady-state baseline; safe to ship together. |

## Success Criteria

### Performance targets (bench harness, 100 tool-events/sec for 60 s)
- [ ] Hot-path RTT (blocking events): P50 ≤ 3 ms, P99 ≤ 25 ms.
- [ ] Hot-path RTT (non-blocking events): P99 ≤ 5 ms.
- [ ] Fallback-path latency (daemon down): P99 ≤ 2 ms.
- [ ] PG connections steady-state: ≤ 2 (read pool + write pool).
- [ ] Process spawns per Claude tool call: 1 (the `genie-hook` binary).
- [ ] `vmstat cs` under bench load: ≤ 50 000/sec (10× reduction vs. baseline).

### Functional gates
- [ ] `genie-hook` binary built via `bun build --compile`, ≤ 20 MB, ships in genie package.
- [ ] `genie serve --headless` listens on `~/.genie/hook.sock` and runs the dispatcher in-process with a pooled Postgres connection.
- [ ] Existing `Handler[]` registry runs unchanged inside the daemon; `syncedSessions` and `enrichedSessions` cache hit count > 0 under sustained load (verified by span data).
- [ ] Forced 30 s daemon outage: CC tools remain responsive; every skipped event lands in `~/.genie/hook-fallback.log`; `genie doctor` flags the outage; `genie events list --kind hook` shows the gap-and-resume pattern after restart.
- [ ] Hook-injector writes the binary path; falls back to `bun .../genie.js hook dispatch` when the binary is absent.

### Telemetry & regression detection
- [ ] Every daemon-mode dispatch emits per-handler timing spans to PG via existing `startSpan/endSpan` (no new instrumentation code).
- [ ] SQL view `hook_perf_baseline` returns rolling P50/P99 per `(event, tool, handler)` over 1 h / 24 h / 7 d windows.
- [ ] `genie doctor --perf` prints current vs. 7 d baseline and flags any handler with a P99 regression > 50 %.

### Pgserve tuning
- [ ] 30-min workload profile collected during representative genie usage (top-N queries by total time, buffer-cache hit ratio, lock waits, max concurrent connections).
- [ ] Tuned `postgresql.conf` patch committed for `~/.genie/data/pgserve` with rationale per setting.
- [ ] Before/after numbers captured in `REPORT.md`: query latency P50/P99, cache hit ratio, hottest-query throughput.

### Delivery report
- [ ] `REPORT.md` includes before/after for hot-path RTT, PG connection count, `vmstat cs`, cache hit ratio, and pgserve tuning deltas.
- [ ] F1 fallback risk for deny-class handlers documented prominently with operator runbook.

## Execution Strategy

| Wave | Groups | Mode | Notes |
|------|--------|------|-------|
| 1 | Group 1, Group 2 | parallel | Daemon dispatcher port and pgserve tuning are independent; can run concurrently. |
| 2 | Group 3 | sequential after Wave 1 | Native binary + injector + smoke test depend on stable daemon protocol from Group 1. |
| 3 | Group 4 | sequential after Wave 2 | Telemetry view + `genie doctor --perf` depend on the binary emitting events. |
| 4 | Group 5 | sequential after Wave 3 | Bench harness, acceptance gates, delivery report depend on all prior groups. |

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Daemon socket listener + in-daemon dispatcher port + caches verified hot |
| 2 | engineer | Pgserve workload profile + tuned `postgresql.conf` patch |
| 3 | engineer | Native binary `genie-hook` + F1 fallback path + hook-injector update + binary smoke test |
| 4 | engineer | SQL migration for `hook_perf_baseline` view + `genie doctor --perf` subcommand |
| 5 | qa | Bench harness, daemon-outage integration test, delivery report with before/after numbers |

---

## Execution Groups

### Group 1: Daemon socket listener + in-daemon dispatcher
**Goal:** Move `dispatch()` out of fork-per-event mode into a long-lived listener inside `genie serve --headless`, with handler caches and PG pool retained across events.

**Deliverables:**
1. UDS listener at `~/.genie/hook.sock` added to `genie serve --headless` startup (length-prefixed JSON framing in both directions).
2. Daemon-mode dispatcher reuses `src/hooks/index.ts` `dispatch()` logic but executes in-process; handler imports happen once at daemon boot.
3. Single pooled `pg.Pool` (or pgserve equivalent) replaces per-call `getConnection()` in the hook write path.
4. `syncedSessions` (`src/hooks/handlers/session-sync.ts:30`) and `enrichedSessions` (`src/hooks/handlers/brain-inject.ts:23`) caches verified to retain state across events (cache-hit counter exposed in span data).
5. `EventCircuitBreaker` (`src/lib/runtime-events.ts`) state persists across events.
6. Socket lifecycle: created on daemon start, removed on clean shutdown, stale-socket detection on startup.

**Acceptance Criteria:**
- [ ] Sending a JSON event over `~/.genie/hook.sock` returns the same shape `dispatch()` produces today.
- [ ] Two consecutive events from the same agent see the second `session-sync` resolve from cache (no PG round-trip).
- [ ] PG connection count stays at ≤ 2 during a 60 s burst of events.
- [ ] PG pool configured with explicit min/max size ensuring exactly 2 steady-state connections (one read pool, one write pool, or equivalent per pgserve backend); pool config asserted in test, not just observed at runtime.
- [ ] Clean `genie serve stop` removes the socket file.
- [ ] Stale socket on next start is detected and replaced.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun run check && bun test src/hooks src/serve
```

**depends-on:** none

---

### Group 2: Pgserve tuning audit
**Goal:** Replace guessed pgserve config with a tuned `postgresql.conf` patch backed by 30 min of representative workload data.

**Deliverables:**
1. Workload profile script that captures, under representative genie load: `pg_stat_statements` top-N by total time, buffer-cache hit ratio, lock-wait counts, max concurrent connections, longest-running queries.
2. Tuned `postgresql.conf` patch for `~/.genie/data/pgserve` covering: `shared_buffers`, `effective_cache_size`, `work_mem`, `maintenance_work_mem`, `wal_compression`, `wal_writer_flush_after`, `checkpoint_*`, `synchronous_commit` (with documented durability tradeoff for `genie_runtime_events` if loosened).
3. Rationale per setting recorded in `REPORT.md` (driven by the profile, not guesses).

**Acceptance Criteria:**
- [ ] Workload profile captured and saved to the wish folder.
- [ ] `postgresql.conf` patch present with per-setting rationale.
- [ ] Reversibility documented (rollback procedure noted).
- [ ] Before/after numbers logged for at least: query latency P50/P99 on hottest 5 queries, cache hit ratio, peak concurrent connections.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun run scripts/pgserve-profile.ts --duration 30m && bun run scripts/pgserve-apply-tuning.ts --dry-run
```

**depends-on:** none

---

### Group 3: Native binary + F1 fallback + hook injector
**Goal:** Compile the thin client, wire F1 fallback, and update the hook injector so new agents get the binary path.

**Deliverables:**
1. Build pipeline: `bun build --compile src/hooks/dispatch-client.ts --outfile dist/genie-hook` produces a static binary ≤ 20 MB.
2. Client logic: read JSON from stdin → length-prefix → connect `~/.genie/hook.sock` → write payload → read response → write to stdout → exit. On `ENOENT`/`ECONNREFUSED`/timeout → exit with empty stdout AND append `{event, tool, command, ts, agent_id, reason}` to `~/.genie/hook-fallback.log` (append-only, size-capped at 100 MB, rate-limited per `(event, tool, reason)` key).
3. Hook-injector update at `src/hooks/inject.ts:34-40` (`buildDispatchCommand()`): detect compiled binary at `~/.genie/bin/genie-hook` (or wherever install places it), prefer it; fall back to existing `bun .../genie.js hook dispatch` command when binary absent.
4. Smoke test `test/hooks/genie-hook-binary.test.ts`: builds the binary and exercises representative payloads (PreToolUse Bash/Read/Edit/SendMessage; PostToolUse:SendMessage; UserPromptSubmit; Stop) with a stub daemon.

**Acceptance Criteria:**
- [ ] Binary builds reproducibly and is ≤ 20 MB.
- [ ] Smoke test passes for all representative payloads.
- [ ] Binary returns empty stdout and writes a fallback record when socket is absent.
- [ ] Existing `bun .../genie.js hook dispatch` command still works as a fallback for environments without the binary.
- [ ] `genie spawn` writes `settings.json` pointing at the binary path when present.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun build --compile src/hooks/dispatch-client.ts --outfile dist/genie-hook && bun run test/hooks/genie-hook-binary.test.ts
```

**depends-on:** Group 1

---

### Group 4: Telemetry view + `genie doctor --perf`
**Goal:** Make per-handler P50/P99 trends queryable and surface regressions in `genie doctor`.

**Deliverables:**
1. SQL migration `src/db/migrations/05X_hook_perf_baseline_view.sql` defining view `hook_perf_baseline` with columns `(event_name, tool_name, handler_name, p50_1h, p99_1h, p50_24h, p99_24h, p50_7d, p99_7d, sample_count_24h)` using `PERCENTILE_CONT` window functions over `genie_runtime_events` timing spans.
2. View test at `test/db/migrations/hook_perf_baseline.test.ts` asserting shape + percentile correctness on synthetic event rows.
3. `genie doctor --perf` subcommand: queries `hook_perf_baseline`, prints current vs. 7 d baseline RTT per handler, flags any handler with P99 regression > 50 %, surfaces last-5-min fallback-log entries as HIGH-severity output.
4. Daemon-mode dispatcher flips `isWideEmitEnabled()` default-on for hook subsystem (verify env-var fallback still honored).

**Acceptance Criteria:**
- [ ] Migration runs cleanly on a fresh pgserve instance.
- [ ] View test passes against synthetic data.
- [ ] `genie doctor --perf` exits 0 on healthy state, exits non-zero when any P99 regression > 50 % is detected.
- [ ] Fallback-log entries within last 5 min appear in `genie doctor` output with HIGH severity.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun run test/db/migrations/hook_perf_baseline.test.ts && bun run test/hooks/doctor-perf.test.ts
```

**depends-on:** Group 3

---

### Group 5: Bench harness, daemon-outage test, delivery report
**Goal:** Prove the performance targets and capture before/after numbers.

**Deliverables:**
1. Bench harness `test/hooks/genie-hook-perf.test.ts`: spawns daemon, drives 100 tool-events/sec for 60 s through the binary, records P50/P99/max RTT per event class (blocking, non-blocking), asserts targets.
2. Brain-inject latency-injection scenario in the bench (simulate a slow brain query) — confirms P99 targets hold or surfaces a tightening fix (per-handler timeout, async fire-and-forget).
3. Daemon-outage integration test `test/hooks/daemon-outage.test.ts`: kill daemon for 30 s mid-bench, verify CC stays responsive, verify every skipped event lands in fallback log, verify `genie doctor --perf` flags it.
4. Delivery report `REPORT.md` in the wish folder with before/after numbers for hot-path RTT (P50/P99), PG connection count, `vmstat cs`, cache hit ratio, pgserve tuning deltas, plus the F1 fallback operator runbook.

**Acceptance Criteria:**
- [ ] Bench asserts and meets all six performance targets in the wish.
- [ ] Daemon-outage test asserts F1 semantics (fallback log written, CC responsive, doctor flags).
- [ ] `REPORT.md` shows ≥ 10× reduction in `vmstat cs` and ≥ 5× reduction in PG connection count vs. baseline captured at the start of Group 1.
- [ ] Delivery report includes the F1 deny-class handler operator runbook.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun run test/hooks/genie-hook-perf.test.ts && bun run test/hooks/daemon-outage.test.ts && cat .genie/wishes/hookify-perf-foundation/REPORT.md | head -200
```

**depends-on:** Group 1, Group 2, Group 3, Group 4

---

## Dependencies

No cross-wish dependencies. This wish is self-contained; the umbrella "hookify layer" is decomposed into future micro-deliveries that will depend on this one.

## QA Criteria

After merge to `dev`:
- [ ] `genie serve --headless` exposes `~/.genie/hook.sock`; `lsof -U | grep hook.sock` shows the listener.
- [ ] Spawning a fresh agent: `cat ~/.claude/teams/<team>/settings.json | jq '.hooks'` shows the binary path.
- [ ] Sustained agent activity for 10 min: `pg_stat_activity` shows ≤ 2 PG connections from the daemon; `vmstat 1 5` shows `cs` an order of magnitude below baseline.
- [ ] `genie doctor --perf` exits 0 and prints non-empty baseline data per handler.
- [ ] Forced kill of `genie serve --headless` for 30 s: CC tool calls keep working; `~/.genie/hook-fallback.log` has matching entries; `genie doctor` flags HIGH on next run.
- [ ] On daemon restart: `genie events list --kind hook --since 5m` shows the gap-and-resume pattern.

## Assumptions / Risks

| # | Assumption / Risk | Severity | Mitigation |
|---|-------------------|----------|------------|
| 1 | Deny-class handlers (`branch-guard`) silently allowed during daemon outage — permission elevation risk | High | Fallback log captures every skipped event with full payload; `genie doctor` flags last-5-min entries as HIGH; delivery report documents operator runbook ("daemon outage → audit fallback log for any Bash entries"); outage-duration target of < 30 s validated by daemon-outage gate. Active client-side ruleset deferred to delivery #2+. |
| 2 | Long daemon outage → audit-log gap | Medium | Fallback log captures fact-of-skip; gaps detectable post-hoc; `genie doctor` flags them. |
| 3 | `bun build --compile` incompatibilities (native modules, dynamic imports) | Medium | Reviewer audit confirmed handlers use lazy dynamic imports cleanly. Smoke test in Group 3 exercises representative payloads before flip-over. |
| 4 | `brain-inject` external service latency could blow P99 RTT target | Medium | Already wraps in try/catch; `enrichedSessions` cache (now actually working) prevents re-querying after first success per session. Bench includes a brain-inject latency-injected scenario; if P99 still misses we add a per-handler timeout or move first-call enrichment to async fire-and-forget. |
| 5 | Compiled binary divergence vs. existing `settings.json` | Low | Injector writes binary path on next `genie spawn`; old bun command stays valid as fallback. |
| 6 | Daemon flap → fallback-log spam | Low | Append-only log with TTL + size cap (100 MB); identical fallback events rate-limited by `(event, tool, reason)` key. |
| 7 | pgserve tuning regresses untested workload | Low | Patch is reversible (config-only); before/after numbers bound the risk; tunables apply only to `~/.genie/data/pgserve`, not host PG. |
| 8 | Telemetry volume blows up `genie_runtime_events` table | Low | Existing `EventCircuitBreaker` (now actually working in daemon mode) caps PG writes; runtime-events retention pruning already exists. |
