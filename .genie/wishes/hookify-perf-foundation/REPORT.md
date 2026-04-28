# Hookify Perf Foundation — Delivery Report

> **Group 2 — pgserve tuning audit** (rolling document; Groups 1/3/4/5 will append their sections in subsequent waves).

**Author:** engineer-2
**Date:** 2026-04-28
**Wish:** `hookify-perf-foundation`

---

## 1. Scope of this section

This section documents the pgserve tuning pass: the workload profile harness, the canonical `postgresql.conf` patch, and the rationale per setting. The post-tuning measurements (apply + rerun + numerical deltas) are intentionally NOT performed here — they will be folded into Group 5's bench harness window so the before/after numbers are taken under the same daemon-mode steady state that Group 1 introduces.

What is delivered now:
- `scripts/pgserve-profile.ts` — sampling harness (`--duration 30m` per the wish; bounds-checked args).
- `scripts/pgserve-apply-tuning.ts` — idempotent apply / dry-run / revert against `~/.genie/data/pgserve/postgresql.conf`.
- `.genie/wishes/hookify-perf-foundation/postgresql.conf.patch` — the canonical managed-block patch.
- `.genie/wishes/hookify-perf-foundation/profile-sample-30s.json` — a 30-second harness validation run that doubles as a "before" snapshot of the live genie workload aggregates (real numbers; cache hit ratio, peak connections, top-tables — but no top-N queries because the live instance has `pg_stat_statements` unloaded).
- `.genie/wishes/hookify-perf-foundation/profile-baseline-pss-synthetic.json` — synthetic-instance top-5 P50/P99 baseline (added by fix-loop 1, Resolution path b — see §3.2).
- `.genie/wishes/hookify-perf-foundation/loadgen-baseline-pss.ts` — preserved load-gen script that produced the synthetic baseline (reproducibility; see §3.2).

Group 5 will produce the matching "after" snapshot and write the bench-window comparison into Section 5 of this document.

---

## 2. Hardware & PG version baseline

| Field | Value |
|---|---|
| CPU | Intel Xeon Platinum 8160 — 80 vCPU |
| RAM | 64 GiB total (≈ 49 GiB free, 7.9 GiB shared, 8.1 GiB buff/cache at sample) |
| Storage | NVMe (`nvme-pool/subvol-…`, ~65 GiB free of 100 GiB on the genie volume) |
| PostgreSQL | 18.2 (compiled by gcc 7.5) |
| pgserve port | 19642 (default, no `GENIE_PG_PORT` override active) |
| pgserve flags | `--port 19642 --host 127.0.0.1 --data ~/.genie/data/pgserve --log warn --no-stats --no-cluster --pgvector` |
| `genie` DB size | 12 GB |

Important context: **pgserve shares this host with the genie daemon, scheduler, TUI, hooks, and 5+ active worktrees** — tuning is sized for a non-dedicated workload.

---

## 3. "Before" workload profile (30 s sample, live genie load)

Captured by `bun run scripts/pgserve-profile.ts --duration 30s --sample-interval-ms 5000 --top-n 10`. Full JSON: `profile-sample-30s.json`.

> **Update (fix-loop 1, Resolution path b — disposable instance):** the live profile cannot expose top-N P50/P99 because `pg_stat_statements` is not loaded into `shared_preload_libraries` on the live instance, and the live instance cannot be safely restarted to enable it (Group 1 engineer-1 plus genie itself plus dog-fooders plus tracer-perf are all live against pgserve). To still produce a defensible baseline, a parallel pgserve was spun up on port 19742 with `pg_stat_statements` pre-loaded and a synthetic-but-representative workload was replayed against it. See §3.2 below for the top-5 results and the explicit caveats. The aggregate live numbers in this section are unchanged and remain the live anchor.

**Aggregate deltas over 30 s on the `genie` database:**

| Metric | Value | Note |
|---|---|---|
| `xact_commit` | 12 371 | ≈ 412 commits/s — the per-event-fork churn the wish targets |
| `blks_hit` | 1 440 190 | shared-buffer hits |
| `blks_read` | 185 | physical reads |
| Cache hit ratio | **99.987 %** | already excellent — tuning targets per-query latency, not hit ratio |
| Peak `numbackends` | 45 | confirms the wish premise: pre-daemon mode keeps ~45 connections idle from spawn fan-out |
| Peak `waiting_locks` | 0 | no contention observed during sample |
| Longest active query | 0 s | OLTP-heavy, no analytical queries running |

**Top tables by access count over 30 s:**

| Table | seq_scan | idx_scan | inserts | n_live_tup | Observation |
|---|---|---|---|---|---|
| `audit_events` | 0 | **2 591** | 1 081 | 198 276 | Hottest table; insert + index-scan dominated. Indexed reads work — no missing index. |
| `executors` | **2 204** | 50 | 0 | 9 | Tiny table (9 rows), seq_scan is fine — ~73 polls/s. Worth tracking long-term. |
| `agents` | **2 217** | 31 | 0 | 43 | Same pattern as `executors`. Both are good fits for keeping in `shared_buffers`. |
| `teams` | 0 | 540 | 0 | 0 | All-index. |
| `assignments` | 0 | 268 | 0 | 0 | All-index. |
| `genie_runtime_events_p20260428` | 0 | 6 | 6 | 1 783 | Today's partition — wide-emit not flipped on yet (Group 4). After flip-on, expect ≥ 100× more inserts here. |

**Current setting baseline (relevant subset):**

| Setting | Current | Notes |
|---|---|---|
| `shared_buffers` | 128MB | default — too small for a 12 GB DB on a 64 GB host |
| `effective_cache_size` | 4GB | default — under-reports RAM available to OS cache |
| `work_mem` | 4MB | default — sort/hash-spill prone |
| `maintenance_work_mem` | 64MB | default — slow VACUUM/CREATE INDEX |
| `wal_compression` | off | default — wastes WAL on append-heavy workload |
| `wal_writer_flush_after` | 1MB | default |
| `checkpoint_timeout` | 5min | default — frequent checkpoints add write amp |
| `synchronous_commit` | on | default — preserved (see §6) |
| `random_page_cost` | 4 | default — wrong for NVMe; under-favours index scans |
| `effective_io_concurrency` | 16 | already raised from default 1 (prior change) |
| `max_connections` | 1000 | already raised from default 100 (test sharding) |
| `jit` | on | default |
| `shared_preload_libraries` | (empty) | `pg_stat_statements` available but **NOT loaded** — top-N query data unavailable until restart |

### 3.2 Top-5 hottest queries — synthetic-instance P50/P99 baseline

Source: `profile-baseline-pss-synthetic.json` (see file for the full per-query record).
Method: disposable pgserve at port 19742, `shared_preload_libraries='pg_stat_statements'` baked in via `ALTER SYSTEM` + restart, `track_io_timing=on`, schema mirrored for the hot tables (`audit_events`, `agents`, `executors`, `teams`), 30 s of 8-worker concurrent INSERT/SELECT/UPDATE replay sized to mirror the SQL shapes seen in the live 30 s sample (290 179 ops, 9 672 ops/s sustained).

P50 / P99 reporting note: `pg_stat_statements` does not store per-call samples, so true percentiles cannot be computed from the view alone. The estimates below use a Gaussian inverse: **P50 ≈ `mean_exec_time`**, **P99 ≈ `mean_exec_time + 2.33 × stddev_exec_time`**. For right-skewed latencies (max ≈ 7–12× mean here) this *underestimates* the true P99 — actual P99 lies between the estimate and `max_exec_time`. Group 5's bench harness MUST switch to per-call timing spans (the same shape as Group 4's `hook_perf_baseline` view) for the matching "after" comparison.

| # | Query (truncated) | Calls | Total ms | Min ms | P50 ≈ mean | Mean ms | Max ms | Stddev ms | P99 estimate | Rows |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | `SELECT id, event_type, created_at FROM audit_events WHERE entity_type = $2 AND entity_id = $1 ORDER BY created_at DESC LIMIT $3` | 72 586 | 68 331.88 | 0.0085 | **0.94** | 0.9414 | 6.806 | 0.5684 | **2.27** | 1 441 882 |
| 2 | `SELECT id, state, team FROM agents WHERE state = $1` | 58 195 | 11 076.71 | 0.0249 | **0.19** | 0.1903 | 2.376 | 0.0902 | **0.40** | 1 508 461 |
| 3 | `INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details) VALUES (...)` | 72 699 | 3 204.60 | 0.0169 | **0.04** | 0.0441 | 1.843 | 0.0240 | **0.10** | 72 699 |
| 4 | `SELECT id, agent_id, state FROM executors WHERE state = $1` | 43 446 | 1 242.84 | 0.0147 | **0.029** | 0.0286 | 0.538 | 0.0090 | **0.05** | 868 920 |
| 5 | `UPDATE agents SET state = $1 WHERE id = $2` | 14 339 | 675.01 | 0.0032 | **0.047** | 0.0471 | 0.405 | 0.0211 | **0.10** | 14 048 |

Caveats (load this section into Group 5's "after" interpretation):
- Workload is synthetic. The mix proportions are *modeled on* the live `pg_stat_user_tables` ratios in §3 (audit_events insert+idx-scan dominated; agents/executors seq-scan dominated; teams idx-only) but the absolute throughput (9 672 ops/s) is much higher than the live 412 commits/s — the bench was sized to gather sufficient samples in 30 s, not to mirror live volume. Per-call latency is workload-density-sensitive at the margins (cache thrash, planner re-binding); expect the live "after" numbers to come in ≤ 30 % below these synthetic ones for the same query shape on warm cache.
- The disposable instance has *no other settings* applied — it's stock pgserve defaults, not the tuned conf. So these numbers are the conservative "stock-PG" anchor, not the un-tuned live anchor. The tuning patch's actual P50/P99 deltas will fall out of the Group 5 bench, where the harness runs against the tuned live instance under daemon-mode steady-state.
- pgserve does not bundle `pg_dump` and the host's `pg_dump 17.9` is incompatible with PG18.2 server, so a true schema+data dump-replay was not possible. The minimal schema in the disposable instance covers the hot tables and indexes only.

Reproduce locally:
```bash
# 1. Start a disposable pgserve on port 19742 with pg_stat_statements loaded:
mkdir -p /tmp/pgserve-pss-baseline
pgserve --port 19742 --host 127.0.0.1 --data /tmp/pgserve-pss-baseline --log warn --no-stats --no-cluster &
sleep 5
PGPASSWORD=postgres psql -h 127.0.0.1 -p 19742 -U postgres \
  -c "ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';" \
  -c "ALTER SYSTEM SET track_io_timing = on;"
# Restart pgserve, then:
PGPASSWORD=postgres psql -h 127.0.0.1 -p 19742 -U postgres \
  -c "CREATE DATABASE genie;"
PGPASSWORD=postgres psql -h 127.0.0.1 -p 19742 -U postgres -d genie \
  -c "CREATE EXTENSION pg_stat_statements;"
# Apply minimal schema (audit_events, agents, executors, teams + indexes — see git history of this report).
# Then run the preserved load-gen script for 30 s:
LOADGEN_PORT=19742 bun .genie/wishes/hookify-perf-foundation/loadgen-baseline-pss.ts 30
# Inspect:
PGPASSWORD=postgres psql -h 127.0.0.1 -p 19742 -U postgres -d genie \
  -c "SELECT calls, total_exec_time, mean_exec_time, stddev_exec_time, max_exec_time, left(query, 80) FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%' ORDER BY total_exec_time DESC LIMIT 5;"
```

---

## 4. Tuning patch — per-setting rationale

The patch lives at `.genie/wishes/hookify-perf-foundation/postgresql.conf.patch` and is installed by `bun run scripts/pgserve-apply-tuning.ts --apply`. Settings grouped by category. Each entry: **what / why / risk.**

### 4.1 Memory

- **`shared_buffers = 4GB`** *(was 128MB; restart required)*
  PG default targets 128 MiB hosts. The genie DB is 12 GB; the working set fits comfortably in a 4 GiB cache. Why not the textbook 25 % (16 GiB)? pgserve is non-dedicated — the daemon, TUI, scheduler, and worktrees all coexist on the same 64 GiB host. 4 GiB (≈ 6 %) leaves headroom.
  *Risk:* requires full pgserve restart. Mitigated by the apply script's clear restart-vs-reload prompt.

- **`effective_cache_size = 16GB`** *(was 4GB; reload-only, no allocation)*
  Planner hint, not an allocation. Tells the planner roughly how much OS page cache + shared_buffers is available. With 49 GiB free RAM, 16 GiB is the conservative floor. Higher value → planner favours index scans for selective queries.

- **`work_mem = 16MB`** *(was 4MB; reload-only)*
  Per-sort / per-hash budget. genie's hottest aggregation paths (the upcoming `hook_perf_baseline` view's `PERCENTILE_CONT`, JSONB scans on `audit_events`) spill at 4 MiB. 16 MiB raises the spill threshold without OOM risk: with `max_connections = 1000` and (in steady-state) ≤ 50 active queries holding ≤ 2 work_mem units each, ceiling ≈ 1.6 GiB.

- **`maintenance_work_mem = 512MB`** *(was 64MB; reload-only)*
  Used by `CREATE INDEX`, `VACUUM`, `ALTER TABLE`. Default `autovacuum_max_workers = 3`, so peak budget ≈ 1.5 GiB. With 64 GiB RAM this is fine; speeds up nightly VACUUM and one-shot index builds during migrations significantly.

- **`hash_mem_multiplier = 2.0`** *(was 1.0 default; reload-only)*
  Effective hash budget = `work_mem * hash_mem_multiplier`. PG13+ pattern. Hash joins and grouping on `audit_events` benefit; sorts unaffected.

### 4.2 WAL & checkpoints

- **`wal_compression = lz4`** *(was off; reload-only, PG14+)*
  Compresses full-page writes during checkpoints. Append-heavy workload (412 commits/s, 1 081 inserts/30 s on `audit_events` alone, soon to be 100× more on `genie_runtime_events`) directly benefits. LZ4 has the lowest decoder cost.
  *Risk:* tiny CPU cost on checkpoint, none on reads. Modern PG default lean is to enable.

- **`wal_writer_flush_after = 2MB`** *(was 1MB; reload-only)*
  How much WAL the writer accumulates before flushing. NVMe absorbs 2 MiB writes without measurable latency impact, halving fsync count.

- **`max_wal_size = 4GB` / `min_wal_size = 1GB`** *(was 1GB / 80MB; reload-only)*
  Keeps more WAL preallocated; fewer recycled-segment churn events under burst. Disk cost on a 65 GiB-free volume is negligible.

- **`checkpoint_timeout = 15min`** *(was 5min; reload-only)*
  Default 5 min triggers a checkpoint every 5 min regardless of dirty ratio. With max_wal_size raised to 4 GiB, 15 min lets the time-trigger and size-trigger compete fairly. Result: fewer checkpoints → less write amplification → smoother CPU profile.

- **`checkpoint_completion_target = 0.9`** *(unchanged; default in PG18)*
  Documented for clarity. PG18 default is already 0.9; reaffirmed so future readers don't have to grep.

### 4.3 Durability — `synchronous_commit` (intentionally NOT relaxed cluster-wide)

The wish flags this with "documented durability tradeoff for `genie_runtime_events` if loosened." The decision: **`synchronous_commit = on` stays globally**.

Rationale: pgserve is the source of truth for wish state, worker registry, mailbox, and runtime events. Losing the last-second of commits on a host crash for the first three is not acceptable. `genie_runtime_events` is the only table where the loss is acceptable (it's telemetry, reconstructable from process logs).

Recommended pattern (code-level, not a config setting): the daemon's emit path in `src/lib/emit.ts` should issue
```sql
SET LOCAL synchronous_commit = off;
```
inside the transaction that inserts into `genie_runtime_events`. This narrows the durability relaxation to exactly the rows it's safe for. Group 1 (daemon dispatcher port) is the right home for that change — flagged here so it doesn't get lost.

### 4.4 I/O & planner

- **`random_page_cost = 1.1`** *(was 4; reload-only)*
  Default 4 is calibrated for spinning disk. NVMe random-read latency is within ~10 % of sequential. Per the PG performance literature, 1.1 is the standard NVMe value. Effect: planner stops penalising index scans on selective predicates. Big win on the `audit_events` hot path.

- **`effective_io_concurrency = 200`** *(was 16; reload-only)*
  Bitmap heap scan prefetch budget. NVMe handles 200+ concurrent reads. Already raised to 16 by an earlier change; bumping to 200 captures the rest.

- **`jit = off`** *(was on; reload-only)*
  JIT compilation pays off only when query execution time exceeds the compile time (typically > 100 ms / > 100 k rows). genie's hot path is sub-ms hook lookups and dispatcher inserts. JIT compile cost (≈ 5–20 ms per query) is pure overhead for these. Long analytical queries (`hook_perf_baseline` view from Group 4) operate on ≤ 7 d × 100 events/s ≈ 60 M rows worst case — borderline JIT territory. Net: turn off cluster-wide; revisit per-query if Group 4's bench shows the view spending > 500 ms.

### 4.5 Stats & observability

- **`shared_preload_libraries = 'pg_stat_statements'`** *(was empty; restart required)*
  Enables top-query telemetry. The profile harness (`pgserve-profile.ts`) already detects whether the extension is loaded and emits `pg_stat_statements` deltas when present; without it, the top-N section in profile JSON is `null` (current state). After applying the patch and restarting pgserve, the operator must run `CREATE EXTENSION pg_stat_statements;` in the `genie` database (the apply script's exit message reminds them).

- **`pg_stat_statements.max = 10000`** *(was 5000 default; reload-only)*
  genie's varied query shapes (per-shard test DBs, per-team queries, runtime-events partitions) blow past 5 k entries quickly. 10 k buys a longer rolling window before eviction.

- **`pg_stat_statements.track = top`** *(reaffirmed default)*
  Top-level statements only — avoids double-counting nested function calls. Documented for clarity.

- **`track_io_timing = on`** *(was off; reload-only)*
  Enables I/O timing in `pg_stat_statements`, `EXPLAIN (ANALYZE, BUFFERS)`, and `pg_stat_database`. Required to diagnose disk-vs-cache regressions in Group 5 bench.

- **`track_activity_query_size = 4096`** *(was 1024; reload-only)*
  Default 1 KiB truncates the longest-query field in `pg_stat_activity`. With JSONB-heavy genie queries, 4 KiB preserves enough text to identify the query.

- **`log_min_duration_statement = 1000ms`** *(was off; reload-only)*
  Logs queries slower than 1 s to stderr. genie's hot paths are sub-ms; 1 s is a clear "this is broken" threshold without log flooding.

### 4.6 Autovacuum

- **`autovacuum_vacuum_scale_factor = 0.1`** *(was 0.2; reload-only)*
  Trigger threshold = `autovacuum_vacuum_threshold + scale_factor * n_live_tup`. On `audit_events` (198 k rows), default fires at 50 + 0.2 × 198 k ≈ 39 k dead tuples; tightened fires at ≈ 19 k. Smaller dead-tuple piles → smaller VACUUM windows → less I/O during burst.

- **`autovacuum_analyze_scale_factor = 0.05`** *(was 0.1; reload-only)*
  Same idea, applied to ANALYZE — more frequent statistics refresh on rapidly-growing tables (`genie_runtime_events`).

- **`autovacuum_naptime = 30s`** *(was 1min; reload-only)*
  How often the autovacuum launcher wakes. 30 s halves the latency between threshold-cross and vacuum start on the hottest tables.

---

## 5. Before / after

The full apply + restart + measure cycle is deferred to Group 5's bench harness so the post-tuning numbers are taken under daemon-mode steady-state (Group 1). The "before" anchors below combine the live aggregate measurements (cache hit ratio, peak connections, insert throughput — all real, all from the live workload) with the synthetic-instance top-5 P50/P99 from §3.2 (defensible "stock-PG" anchor — see the synthetic-baseline caveats in §3.2 before reading the deltas literally).

| Metric | Before — anchor | Anchor source | After (post-tuning + Group 1 daemon) | Δ |
|---|---|---|---|---|
| **Top-5 query P50** (audit_events idx-scan) | **0.94 ms** | synthetic, §3.2 | TBD | TBD |
| **Top-5 query P50** (agents seq-scan) | **0.19 ms** | synthetic, §3.2 | TBD | TBD |
| **Top-5 query P50** (audit_events insert) | **0.04 ms** | synthetic, §3.2 | TBD | TBD |
| **Top-5 query P50** (executors seq-scan) | **0.03 ms** | synthetic, §3.2 | TBD | TBD |
| **Top-5 query P50** (agents UPDATE pk) | **0.05 ms** | synthetic, §3.2 | TBD | TBD |
| **Top-5 query P99 (Gaussian-inverse estimate)** | rank1 **2.27 ms** / rank2 **0.40 ms** / rank3 **0.10 ms** / rank4 **0.05 ms** / rank5 **0.10 ms** | synthetic, §3.2 | TBD | TBD |
| **Top-5 query max observed** | rank1 6.81 ms / rank2 2.38 ms / rank3 1.84 ms / rank4 0.54 ms / rank5 0.40 ms | synthetic, §3.2 | TBD | TBD |
| `genie` DB cache hit ratio | 99.987 % (live) / 99.99997 % (synthetic) | live + synthetic | TBD | TBD |
| Peak concurrent connections | **45** (live, pre-daemon spawn-fanout) | live, §3 | ≤ 2 (target) | TBD |
| `audit_events` insert throughput | ≈ 36/s (live) | live, §3 | TBD | TBD |
| `vmstat 1` cs/sec | (Group 5 captures baseline) | — | (target ≤ 50 000/s) | TBD |
| WAL bytes per minute | TBD | — | TBD (expect lower with `wal_compression = lz4`) | TBD |

**Group 5 protocol — required to make the table comparable:**
1. Run the bench against the *tuned, live* pgserve (after §7 step 4 restart) under daemon-mode steady state from Group 1 — not against the disposable instance.
2. Use Group 4's `hook_perf_baseline` view (PERCENTILE_CONT over per-call timing spans) for the "after" P50/P99 — *not* `pg_stat_statements`'s mean/stddev. The Gaussian-inverse estimates above are a known underestimate of true P99 for right-skewed latencies; comparing them to true PERCENTILE_CONT P99 would unfairly favour the "after" side.
3. Capture the same five SQL shapes by `queryid` (rank-1: audit_events `WHERE entity_type AND entity_id ORDER BY created_at`; rank-2: agents `WHERE state`; rank-3: audit_events INSERT; rank-4: executors `WHERE state`; rank-5: agents UPDATE).
4. If the daemon-mode work changes the SQL shapes (e.g., session-sync cache short-circuits some `WHERE state` polls), document the shape delta inline next to the rank.

---

## 6. Reversibility

The tuning is a single managed block bracketed by `# >>> genie pgserve tuning (managed block) >>>` / `# <<< … <<<`. Three rollback levels:

1. **Soft rollback** (preferred): `bun run scripts/pgserve-apply-tuning.ts --revert` strips the managed block. A reload (`pg_ctl -D ~/.genie/data/pgserve reload`) reverts every reload-only setting to its prior value; a `genie serve restart` reverts the restart-required ones (`shared_buffers`, `shared_preload_libraries`).
2. **Backup restore**: each `--apply` writes `postgresql.conf.bak.<timestamp>` next to the live conf. Copy the latest one over `postgresql.conf` and restart pgserve to replay the exact prior file, byte for byte.
3. **Nuclear**: `genie serve stop && rm ~/.genie/data/pgserve/postgresql.conf` followed by re-init from the pgserve binary's defaults. Last resort — only useful if the conf becomes corrupt.

**Restart-required settings** (always need `genie serve restart`, not just reload):
- `shared_buffers = 4GB`
- `shared_preload_libraries = 'pg_stat_statements'`
- `wal_buffers` (not changed in this patch but documented for completeness)
- `max_connections` (not changed; already at 1000)

Every other setting in the patch is reload-only.

---

## 7. Operator runbook — applying the tuning

```bash
# 1. Profile the current workload (long form — captures pg_stat_statements deltas if loaded)
cd ~/workspace/repos/genie
bun run scripts/pgserve-profile.ts --duration 30m \
  --out .genie/wishes/hookify-perf-foundation/profile-before.json

# 2. Preview the change
bun run scripts/pgserve-apply-tuning.ts --dry-run

# 3. Apply (writes managed block + .bak file)
bun run scripts/pgserve-apply-tuning.ts --apply

# 4. Restart pgserve (required because shared_buffers + shared_preload_libraries changed)
genie serve restart

# 5. Enable pg_stat_statements in the genie database (one-time, after restart)
PGPASSWORD=postgres psql -h 127.0.0.1 -p 19642 -U postgres -d genie \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;'

# 6. Profile post-tuning under matching workload conditions
bun run scripts/pgserve-profile.ts --duration 30m \
  --out .genie/wishes/hookify-perf-foundation/profile-after.json

# 7. Roll back if regressions appear
bun run scripts/pgserve-apply-tuning.ts --revert && genie serve restart
```

The before/after profile JSON pair is the input to Group 5's REPORT.md update.

---

## 8. F1 fallback operator runbook (referenced; full text from Group 5)

This section will be authored by Group 5 alongside the bench harness. It belongs here because the wish requires "F1 fallback risk for deny-class handlers documented prominently with operator runbook" in `REPORT.md`. Placeholder so the table-of-contents is stable for later groups; do not delete during Group 5 work.

---
