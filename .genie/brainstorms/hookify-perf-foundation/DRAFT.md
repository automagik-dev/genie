# Draft: Hookify Performance Foundation (delivery #1)

| Field | Value |
|-------|-------|
| **Slug** | `hookify-perf-foundation` |
| **Date** | 2026-04-28 |
| **WRS** | 100/100 |
| **Umbrella vision** | Genie as the universal Claude Code hookify layer — one CC hook entry system-wide, daemon multiplexes to genie-internal handlers AND third-party tools (Token Optimizer, etc.) that opt in. |
| **This delivery** | First micro: eliminate the per-event performance hit (bun cold-start + PG connect storm). NO registration-architecture change yet. |

## Context (from /trace investigation, 2026-04-28)

- Symptom: load avg 587 with only 25% CPU, no D-state procs. LXC amplification confirmed; real cost = bun cold-start + PG churn.
- Mechanism: every Claude tool event → fork `genie hook dispatch` (bun ~80–200ms, ~150 MB RSS) → open new PG conn → write event → die.
- Wasted state: process-local caches (`syncedSessions`, `enrichedSessions`, `EventCircuitBreaker`) get 0% hit rate because they live in a process that immediately exits.
- Other tools (Token Optimizer's `[Token Optimizer] Quality bar already fully installed.` etc.) ALSO install their own CC hooks in `~/.claude/settings.json`, so we coexist with foreign hooks today.
- Existing daemon: `genie serve --headless` (pid 406601 in current snapshot) already owns pgserve, scheduler, event-router, inbox-watcher.

## Open questions
- Scope of delivery #1 — config trim only, native compile only, daemon socket only, or thin-client + daemon?
- How aggressive on backwards-compat? Existing `genie hook dispatch` is wired via JSON in settings — must keep working during transition.
- What's the perf target? (e.g., "median hook RTT < 5 ms", "P99 < 25 ms", "PG conns at steady state ≤ 1")
- How do we measure? (existing `startSpan/endSpan` + `isWideEmitEnabled` — usable today?)
- Fallback when daemon down — fail-open (allow tool, log) or fail-closed (deny)?

## Decisions
| Decision | Rationale |
|----------|-----------|
| **Shape: D — compiled thin client + daemon socket** | Largest perf win (cold-start ~80ms → ~1ms, PG churn → 0). Establishes daemon as host for future hookify features (plugin registry, third-party absorption). B/A would have to be redone later; C is half-measure. |
| Daemon owner: existing `genie serve --headless` | Already running, already owns pgserve / scheduler / event-router. No new long-lived process. |
| Socket path: `~/.genie/hook.sock` (UDS) | Matches existing genie state convention; per-user; no port conflicts. |
| Compile target: `bun build --compile` → static `genie-hook` binary | Already a bun project; reuses TS code; ~10MB binary; no Rust/Go bring-up. |
| **Fallback: F1 (fail-open silent)** | Operations must never stop. Daemon down ≠ CC frozen. Skipped hooks accept the audit-log gap during outage. |
| **Self-heal via observability** | Binary appends a fallback record (`hook.fallback` event) to a structured log (`~/.genie/hook-fallback.log`) on every socket failure; daemon (and `genie doctor`) tail it to detect patterns and trigger remediation (restart, alert, surface in TUI). The fix loop comes from observation, not synchronous retry. |
| Wire protocol: length-prefixed JSON over UDS | Trivial framing; bun + node both have first-class support; no HTTP overhead. |
| **Performance telemetry persisted** — reuse `startSpan/endSpan` + `runtime-events` + `isWideEmitEnabled` already in `src/hooks/index.ts:172-191`. Every hook dispatch writes per-handler timing rows to PG so historical baselines and week-over-week regressions are observable. | Wiring exists — turn it on by default for daemon-mode dispatch, add aggregation queries / view so `genie doctor` shows P50/P99 per handler over rolling windows. |
| **Pgserve tuning audit** included in this delivery | Real workload data now exists (genie has been live long enough to characterize). Tune embedded pgserve `postgresql.conf` (`shared_buffers`, `work_mem`, `max_connections`, WAL settings, `effective_cache_size`) based on measured hot-path queries — not guesses. Config-only, ships safely alongside the daemon work. |

## Risks
| Risk | Severity | Mitigation |
|------|----------|------------|
| Long daemon outage → audit-log gap | Medium | Fallback log captures the fact-of-skip; gaps detectable post-hoc; self-heal closes outage window quickly. |
| `branch-guard` / `orchestration-guard` (deny-class handlers) silently allowed during outage | Medium | Either accept (rationale: never block CC) or designate small client-side ruleset for hardcoded denies. Decision deferred to next question. |
| Compiled binary divergence (CC settings.json points to old `bun .../genie.js hook dispatch`) | Low | Hook injector (`src/hooks/inject.ts`) updated to write the binary path; existing settings get migrated by `genie spawn`. |
| Daemon flap → fallback-log spam | Low | TTL + size cap on fallback log; rate-limit identical fallback events. |

## Success Criteria

### Performance targets (measured on bench harness, 100 tool-events/sec for 60 s)
- [ ] Hot-path RTT (blocking events): **P50 ≤ 3 ms, P99 ≤ 25 ms**.
- [ ] Hot-path RTT (non-blocking events): **P99 ≤ 5 ms**.
- [ ] Fallback-path latency (daemon down): **P99 ≤ 2 ms**.
- [ ] PG connections steady-state: **≤ 2** (read pool + write pool).
- [ ] Process spawns per Claude tool call: **1** (the `genie-hook` binary).
- [ ] `vmstat cs` under bench load: **≤ 50 000/sec** (10× reduction vs. baseline).

### Functional gates
- [ ] `genie-hook` binary built via `bun build --compile`, ≤ 20 MB, ships in genie package.
- [ ] `genie serve --headless` listens on `~/.genie/hook.sock` and runs the dispatcher in-process with pooled PG.
- [ ] Existing `Handler[]` registry runs unchanged inside the daemon; `syncedSessions` and `enrichedSessions` caches retain state across events (verified by tracing cache hits in observability).
- [ ] Forced 30-s daemon outage: CC tools remain responsive; every skipped event lands in `~/.genie/hook-fallback.log`; `genie doctor` flags the outage; `genie events list --kind hook` shows the gap-and-resume pattern after restart.
- [ ] Hook-injector writes the binary path; falls back to `bun .../genie.js hook dispatch` when binary missing (dev/test/CI).

### Telemetry & regression detection
- [ ] Every daemon-mode dispatch emits per-handler timing spans to PG via existing `startSpan/endSpan` (plumbed at `src/hooks/index.ts:172-191`); no new instrumentation required.
- [ ] Aggregation view `hook_perf_baseline` returns rolling P50/P99 per `(event, tool, handler)` over 1 h / 24 h / 7 d windows.
- [ ] `genie doctor --perf` prints current vs. 7 d baseline and flags any handler with P99 regression > 50 %.

### Pgserve tuning
- [ ] 30-min workload profile collected during representative genie usage (top-N queries by total time, buffer-cache hit ratio, lock waits, max concurrent connections).
- [ ] Tuned `postgresql.conf` patch committed to `~/.genie/data/pgserve` config (or wherever the embedded config lives) with rationale per setting.
- [ ] Before/after numbers captured: query latency P50/P99, cache hit ratio, hottest-query throughput.

## Scope

### IN
1. Native binary `genie-hook` produced by `bun build --compile`, packaged with genie.
2. Daemon socket listener at `~/.genie/hook.sock` (length-prefixed JSON), hosted by `genie serve --headless`.
3. In-daemon dispatcher — port `dispatch()` from `src/hooks/index.ts` to run inside the daemon. Existing `Handler[]` registry runs unchanged; in-memory caches (`syncedSessions`, `enrichedSessions`, `EventCircuitBreaker`) finally retain state; single pooled PG connection.
4. F1 fallback path: socket missing / timeout → binary returns empty JSON, appends `hook.fallback` record to `~/.genie/hook-fallback.log`.
5. Hook-injector update: `src/hooks/inject.ts` writes the binary path; bun fallback for dev environments where binary is absent.
6. Observability: `hook.fallback` records visible in `genie events list` once daemon is up; per-handler timing spans already plumbed via `startSpan/endSpan`.
7. Performance targets (see Success Criteria).
8. `genie doctor` surfacing of recent fallback events.
9. **Persistent performance telemetry**: per-handler timing spans always emitted in daemon-mode dispatch; aggregation query / view (`hook_perf_baseline`) returning rolling P50/P99 per `(event, tool, handler)` over 1h/24h/7d windows. Surfaced in `genie doctor` and `genie events`.
10. **Pgserve tuning pass**: 30-min workload profile (top-N queries by total time, buffer-cache hit ratio, lock waits, connection pool saturation) feeding a tuned `postgresql.conf` patch for `~/.genie/data/pgserve`. Before/after numbers captured in the wish report.

### OUT
- Third-party hook absorption (Token Optimizer, etc. coexist as independent CC hooks).
- Plugin registration API for external handlers.
- Hot-reload of handler code.
- Migration tooling that rewrites foreign hooks in user `settings.json`.
- Auto-restart of the daemon (observability only — remediation lands later).
- Client-side hardcoded deny rules (deny-class handlers fully rely on daemon; accept silent-allow during outage).
- Cross-host / remote daemon.
- Removal of `genie hook dispatch` bun command (kept for dev/test/CI).

## Notes
- Out of scope for this delivery: third-party hook absorption, plugin registration API, Token-Optimizer migration. Those are deliveries #2+.
