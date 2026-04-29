# Design: Hookify Performance Foundation (delivery #1)

| Field | Value |
|-------|-------|
| **Slug** | `hookify-perf-foundation` |
| **Date** | 2026-04-28 |
| **WRS** | 100/100 |
| **Umbrella vision** | Genie as the universal Claude Code hookify layer — one CC hook entry system-wide, daemon multiplexes to genie-internal handlers AND third-party tools (Token Optimizer, etc.) that opt in. |
| **This delivery** | First micro-delivery: eliminate the per-event performance hit (bun cold-start + PG connect storm). NO registration-architecture change yet. |

## Problem

Every Claude Code tool event currently forks `genie hook dispatch`, paying ~80–200 ms of bun cold-start, opening a fresh Postgres connection, running a chain of 3+ handlers, then dying. Process-local caches (`syncedSessions`, `enrichedSessions`, `EventCircuitBreaker`) get a 0% hit rate because each invocation lives in a process that immediately exits. Under sustained agent activity this produces a context-switch storm (~477 k cs/sec measured), Postgres connection churn (~10 transient idle conns/sec), and an LXC-amplified loadavg of 587 even though real CPU sits at 25%. Operations don't fail, but the host is heating for no reason.

## Scope

### IN
1. **Native binary** `genie-hook` produced by `bun build --compile`, packaged with genie, ≤ 20 MB.
2. **Daemon socket listener** at `~/.genie/hook.sock` (length-prefixed JSON), hosted by `genie serve --headless`.
3. **In-daemon dispatcher** — port `dispatch()` from `src/hooks/index.ts` to run inside the daemon process. Existing `Handler[]` registry runs unchanged; in-memory caches (`syncedSessions`, `enrichedSessions`, `EventCircuitBreaker`) retain state across events; single pooled Postgres connection.
4. **F1 fallback** — when the socket is missing or times out the binary returns empty JSON to Claude Code (allow-by-default, never blocks the tool) and appends a `hook.fallback` record to `~/.genie/hook-fallback.log`.
5. **Hook-injector update** — `src/hooks/inject.ts:34-40` (`buildDispatchCommand()`) updated: detect compiled `genie-hook` binary at install location (e.g., `~/.genie/bin/genie-hook`), prefer it; fall back to existing `bun .../genie.js hook dispatch` command when the binary is absent (dev/test/CI). New `genie spawn` runs migrate `settings.json` to the binary path.
6. **Persistent performance telemetry** — every daemon-mode dispatch emits per-handler timing spans through the existing `startSpan/endSpan` plumbing at `src/hooks/index.ts:172-191` (verified by reviewer: `src/lib/emit.ts:344-387` enqueues, background flusher writes to `genie_runtime_events` table; `isWideEmitEnabled()` toggle exists at `src/lib/observability-flag.ts:35-37`). New SQL migration `src/db/migrations/05X_hook_perf_baseline_view.sql` defines view `hook_perf_baseline` with columns `(event_name, tool_name, handler_name, p50_1h, p99_1h, p50_24h, p99_24h, p50_7d, p99_7d, sample_count_24h)` using PostgreSQL `PERCENTILE_CONT` over the timing rows.
7. **`genie doctor` surfacing** — `genie doctor` flags fallback-log entries from the last 5 min and prints current-vs-7d baseline RTT per handler with a regression flag at >50% P99 increase.
8. **Pgserve tuning pass** — collect a 30-min workload profile under representative genie usage and ship a tuned `postgresql.conf` patch for `~/.genie/data/pgserve`. Before/after numbers (query latency, cache hit ratio, hottest-query throughput) captured in the delivery report.

### OUT
- Third-party hook absorption (Token Optimizer, ultratoken, etc. continue to register their own CC hooks).
- Plugin registration API for external handlers.
- Hot-reload of handler code.
- Migration tooling that rewrites foreign hooks inside user `settings.json`.
- Auto-restart / remediation of the daemon (observability only this round).
- Client-side hardcoded deny rules (deny-class handlers fully rely on daemon; outage = silent-allow, by design).
- Cross-host / remote daemon.
- Removal of the bun-based `genie hook dispatch` command (kept as dev/test/CI fallback).

## Approach

**Shape: D — compiled thin client + daemon socket** (chosen over A: config-trim, B: native-binary-only, C: daemon-socket-only). Rationale: D is the only option that lands the perf win **and** stands up the daemon as the host for future hookify deliveries; A/B can't host the umbrella vision and C leaves the cold-start cost untouched.

### Hot path
```
CC event ──► genie-hook (native, ~1ms cold start)
              │
              ├─ length-prefixed JSON over UDS ──► genie serve --headless
              │                                       │
              │                                       ├─ resolve handlers (in-process)
              │                                       ├─ run chain (caches HOT, PG pool reused)
              │                                       ├─ emit per-handler spans
              │                                       └─ return result
              │
              └─ stdout ──► CC
```

### Fallback (F1) path
```
CC event ──► genie-hook
              │
              ├─ connect ~/.genie/hook.sock → ENOENT/ECONNREFUSED/timeout
              ├─ append {event, tool, ts, reason} to ~/.genie/hook-fallback.log
              └─ stdout = "" (allow)   ──► CC continues
```
Daemon (and `genie doctor`) tail the fallback log. Self-heal in this delivery is observation only — remediation lands in delivery #2+.

### Wire protocol

Length-prefixed JSON:

```
4-byte big-endian uint32 (payload length) | UTF-8 JSON payload
```

Same framing in both directions. Trivial to implement with Bun's `Bun.connect` / `Bun.listen` and node's `net.createServer`.

### Telemetry
- `startSpan('hook.delivery', ...)` already exists in `src/hooks/index.ts:172`. Daemon-mode dispatch flips `isWideEmitEnabled()` to default-on for the hook subsystem. No new instrumentation code.
- New SQL view `hook_perf_baseline`: computes percentiles using the existing event timing rows; columns `(event_name, tool_name, handler_name, p50_1h, p99_1h, p50_24h, p99_24h, p50_7d, p99_7d, sample_count_24h)`.
- `genie doctor --perf` queries the view, compares to the 7d window, and flags `>50%` P99 regressions.

### Pgserve tuning pass
- Profile collection under steady genie load: `pg_stat_statements` top-N queries, buffer cache hit ratio, lock-wait counts, `max_connections` headroom, replication-irrelevant.
- Tune candidates (decided from data, not guesses): `shared_buffers`, `effective_cache_size`, `work_mem`, `maintenance_work_mem`, `wal_compression`, `wal_writer_flush_after`, `checkpoint_*`, `synchronous_commit` (consider `off` for runtime-events table only — durability tradeoff documented).
- Patch lands as a versioned config under `~/.genie/data/pgserve/`; before/after captured in the delivery report so we can repeat the exercise as workload evolves.

### Backwards compatibility
- The bun `genie hook dispatch` command stays callable (dev/test/CI use it; it remains the fallback the injector writes when the binary is absent).
- Existing `settings.json` files keep working until the next `genie spawn` rewrites them with the binary path.
- The in-daemon dispatcher imports the same `src/hooks/handlers/*` modules — no handler code changes.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Shape D — compiled thin client + daemon socket | Largest perf win and the only shape that hosts the umbrella hookify vision. |
| Daemon owner: existing `genie serve --headless` | Already long-lived, already owns pgserve / scheduler / event-router. No new process. |
| Socket: `~/.genie/hook.sock` (UDS) | Per-user, no port conflicts, matches existing genie state convention. |
| Compile via `bun build --compile` | Reuses TS code; no Rust/Go bring-up; ~10–20 MB static binary. |
| Fallback: F1 (fail-open silent) | Operations must never stop. Daemon-down ≠ CC-frozen. Audit-log gap during outage is acceptable and visible. |
| Self-heal via observability only this delivery | Fallback log + `genie doctor` surface enough for an operator to act. Active remediation is delivery #2+. |
| Wire protocol: length-prefixed JSON over UDS | Trivial framing; first-class Bun + Node support; no HTTP overhead. |
| Persist performance telemetry through existing `startSpan/endSpan` | Wiring is already in `src/hooks/index.ts:172-191`; just turn it on by default in daemon mode and add an aggregation view. |
| Include pgserve tuning in this delivery | Real workload data exists now; tuning is config-only and tightly coupled to the daemon-mode steady-state baseline; safe to ship in the same wish. |

## Risks & Assumptions

| Risk | Severity | Mitigation |
|------|----------|------------|
| Long daemon outage → audit-log gap | Medium | Fallback log captures every skipped event with timestamp + reason; gaps detectable post-hoc; `genie doctor` flags them. |
| Deny-class handlers (`branch-guard` in particular) silently allowed during daemon outage — **permission elevation risk** | **High** | **Operational guarantee + observable mitigation.** During an outage `branch-guard`'s deny on destructive git operations (push to main/master) becomes silent-allow. Mitigations baked into this delivery: (1) every fallback event written to `~/.genie/hook-fallback.log` with `{event, tool, command, ts, agent_id}` so post-hoc audit is always possible; (2) `genie doctor` flags ANY fallback entry within the last 5 min as a HIGH-severity surface; (3) delivery report explicitly documents the elevation window and the operator runbook ("daemon outage → audit fallback log for any Bash entries before resuming"); (4) outage-duration target of < 30 s validated by the daemon-outage success-criteria gate. Active client-side ruleset and auto-remediation are explicitly delivery #2+. |
| `orchestration-guard` (advisory, not blocking) silently skipped during outage | Low | Advisory context-injection; silent-skip is safe — at worst an agent gets less guidance for a few seconds. |
| Compiled binary divergence vs. existing `settings.json` | Low | Injector writes binary path on next `genie spawn`; old bun command stays valid as fallback. |
| Daemon flap → fallback-log spam | Low | Append-only log with TTL + size cap; identical fallback events rate-limited by `(event, tool, reason)` key. |
| `bun build --compile` incompatibilities (native modules, dynamic imports) | Medium | Reviewer audit confirmed handlers use lazy dynamic imports cleanly (e.g., `brain-inject.ts:38` `await import(BRAIN_PKG)`). Smoke test `test/hooks/genie-hook-binary.test.ts` builds the binary and exercises representative payloads (PreToolUse: Bash/Read/Edit/SendMessage; PostToolUse:SendMessage; UserPromptSubmit; Stop) before flip-over. |
| `brain-inject` external service latency could blow P99 RTT target | Medium | `brain-inject` already wraps in try/catch and returns `null` on any failure; in daemon mode the `enrichedSessions` cache prevents re-querying after first success per session (now actually working). Bench harness includes a brain-inject latency-injected scenario; if P99 still misses we either tighten the timeout (currently no per-handler timeout — add one) or down-grade to async fire-and-forget for first-call enrichment. |
| pgserve tuning regresses some untested workload | Low | Patch is reversible (config-only); before/after numbers capture the win and bound the risk; tunables apply only to `~/.genie/data/pgserve`, not host PG. |
| Telemetry volume blows up runtime-events table | Low | Existing `EventCircuitBreaker` (now actually working in daemon mode) caps PG writes; runtime-events retention pruning already exists. |

## Success Criteria

### Validation commands
```bash
# Full gate (must pass before delivery is shipped)
bun run check                                            # typecheck + lint + dead-code + test
bun run test/hooks/genie-hook-binary.test.ts             # bun build --compile smoke test
bun run test/hooks/genie-hook-perf.test.ts               # bench harness, asserts P50/P99 targets
bun run test/hooks/daemon-outage.test.ts                 # F1 fallback + log + genie doctor flag
bun run test/db/migrations/hook_perf_baseline.test.ts    # SQL view shape + percentile correctness
```

### Performance targets (bench harness: 100 tool-events/sec for 60 s)
- [ ] Hot-path RTT (blocking events): **P50 ≤ 3 ms, P99 ≤ 25 ms**.
- [ ] Hot-path RTT (non-blocking events): **P99 ≤ 5 ms**.
- [ ] Fallback-path latency (daemon down): **P99 ≤ 2 ms**.
- [ ] PG connections steady-state: **≤ 2** (read pool + write pool).
- [ ] Process spawns per Claude tool call: **1** (the `genie-hook` binary).
- [ ] `vmstat cs` under bench load: **≤ 50 000/sec** (10× reduction vs baseline).

### Functional gates
- [ ] `genie-hook` binary built via `bun build --compile`, ≤ 20 MB, ships in genie package.
- [ ] `genie serve --headless` listens on `~/.genie/hook.sock` and runs the dispatcher in-process with a pooled Postgres connection.
- [ ] Existing `Handler[]` registry runs unchanged inside the daemon; `syncedSessions` and `enrichedSessions` caches retain state across events (verified by counting cache-hits in span data, which must be > 0 under sustained load).
- [ ] Forced 30 s daemon outage: CC tools remain responsive; every skipped event lands in `~/.genie/hook-fallback.log`; `genie doctor` flags the outage; `genie events list --kind hook` shows the gap-and-resume pattern after restart.
- [ ] Hook-injector writes the binary path; falls back to `bun .../genie.js hook dispatch` when the binary is absent.

### Telemetry & regression detection
- [ ] Every daemon-mode dispatch emits per-handler timing spans to PG via the existing `startSpan/endSpan` (no new instrumentation code).
- [ ] SQL view `hook_perf_baseline` returns rolling P50/P99 per `(event, tool, handler)` over 1 h / 24 h / 7 d windows.
- [ ] `genie doctor --perf` prints current vs 7 d baseline and flags any handler with a P99 regression > 50%.

### Pgserve tuning
- [ ] 30-min workload profile collected during representative genie usage (top-N queries by total time, buffer-cache hit ratio, lock waits, max concurrent connections).
- [ ] Tuned `postgresql.conf` patch committed to `~/.genie/data/pgserve` config with rationale per setting.
- [ ] Before/after numbers captured: query latency P50/P99, cache hit ratio, hottest-query throughput.
