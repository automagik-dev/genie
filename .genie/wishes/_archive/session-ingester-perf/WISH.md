# WISH: Session Ingester Performance & Memory Fix

**Status:** DRAFT
**Priority:** P0 — blocks all observability/self-improvement work
**Repo:** repos/genie/
**Branch:** fix/session-ingester-perf

## Problem

The session ingester (`src/lib/session-ingester.ts`) runs every 60s inside the scheduler daemon's heartbeat loop. It currently:

- **Blocks the event loop** with synchronous `statSync()` and `readSync()` on every JSONL file (4,121 files across 331 project dirs)
- **Hammers Postgres** with an N+1 query pattern: 3N+1 queries per cycle (SELECT + INSERT + UPDATE per session)
- **Re-fetches everything** every cycle — no caching of worker maps, session metadata, or "fully caught up" files
- **Allocates large buffers** for each file read without streaming
- **Runs inside the heartbeat timer** — slow ingestion delays heartbeats, snapshots, and worker events
- **Has zero observability** — no metrics on how long ingestion takes or how many bytes are processed

At scale (100+ concurrent sessions), this creates memory pressure and event loop stalls that cascade into the zombie process problem.

## Current Architecture

```
Every 60s (heartbeat timer):
  collectHeartbeats()
  collectMachineSnapshot()
  emitWorkerEvents()
  ingestSessions()          ← BLOCKS EVERYTHING ABOVE IF SLOW
    discoverJsonlFiles()    → 331 dirs, 4121 files
    buildWorkerMap()        → SELECT * FROM agents (every time)
    FOR EACH file:
      statSync(path)        → BLOCKING syscall
      ensureSession()       → SELECT + INSERT per session
      readSync(fd, buf)     → BLOCKING read, full buffer alloc
      parseJsonlContent()   → string parse
      batchInsertContent()  → good (batched INSERT)
      UPDATE sessions       → 1 query per session
```

**Data flow:**
- `session_content` table: assistant text, tool I/O (from JSONL)
- `audit_events` table: cost, tokens, latency (from OTel receiver — separate, real-time)
- `sessions replay` joins both by session_id + timestamp

**Current consumers (3 CLI commands, nothing automated):**
- `genie sessions list` — table of recent sessions
- `genie sessions replay <id>` — interleaved content + OTel timeline
- `genie sessions search <query>` — full-text search via PG GIN index

## Target Architecture

```
Every 60s (heartbeat timer):
  collectHeartbeats()
  collectMachineSnapshot()
  emitWorkerEvents()
  scheduleIngestion()       ← NON-BLOCKING: queues work, returns immediately

Ingestion worker (async, off heartbeat path):
  discoverJsonlFiles()      → same scan
  filterChanged()           → skip files with unchanged mtime (cached)
  buildWorkerMap()          → cached, refresh every 5min or on agent change
  BATCH changed files:
    stat (async, Promise.all batched)
    ensureSession (batched: INSERT ... ON CONFLICT DO UPDATE)
    read (async fs.promises, streaming)
    parseJsonlContent()
    batchInsertContent()    → same batched INSERT (already good)
    batchUpdateOffsets()    → single UPDATE ... FROM VALUES(...)
  emitIngestionMetrics()    → duration_ms, files_scanned, files_changed, bytes_read, rows_inserted
```

## Acceptance Criteria

### Must Have (P0)
1. **Async I/O**: Replace all `statSync`/`readSync`/`openSync`/`closeSync` with async equivalents
2. **Batch queries**: Collapse N+1 pattern into batch operations — single INSERT ON CONFLICT for sessions, single UPDATE for offsets
3. **Off-heartbeat execution**: Ingestion must not block the heartbeat timer — either run in a separate setInterval or use a non-blocking queue
4. **File change detection**: Cache file mtime/size, skip files that haven't changed since last successful ingestion
5. **Worker map caching**: Cache buildWorkerMap result with 5-minute TTL, invalidate on agent registry changes
6. **Ingestion metrics**: Log duration_ms, files_scanned, files_changed, bytes_read, rows_inserted per cycle (to stdout or audit_events)

### Should Have (P1)
7. **Streaming reads**: Replace full-buffer allocation with streaming line reader for large JSONL deltas
8. **Configurable concurrency**: Limit concurrent file reads (default: 20) to avoid fd exhaustion
9. **Session retention**: Add configurable max age for session_content rows (default: 30 days), run cleanup in retention pass
10. **Backpressure**: If ingestion cycle exceeds 30s, skip next cycle and log warning

### Nice to Have (P2)
11. **Incremental discovery**: Cache the project dir listing, only re-scan every 5 minutes
12. **Health endpoint**: Expose ingestion lag (time since last successful full cycle) via scheduler health check

## Execution Groups

### Group 1: Core Performance Fix (P0 items 1-4)
**Files:** `src/lib/session-ingester.ts`
- Replace sync I/O with async
- Batch session upserts into single query
- Batch offset updates into single query
- Add mtime cache to skip unchanged files
- Move ingestion off heartbeat timer path

### Group 2: Caching & Metrics (P0 items 5-6)
**Files:** `src/lib/session-ingester.ts`, `src/lib/scheduler-daemon.ts`
- Add in-memory worker map cache with TTL
- Add ingestion cycle metrics emission
- Wire metrics into scheduler health reporting

### Group 3: Robustness (P1 items 7-10)
**Files:** `src/lib/session-ingester.ts`, `src/lib/scheduler-daemon.ts`
- Streaming JSONL reader
- Concurrency limiter for file reads
- Session content retention policy
- Backpressure/skip mechanism

### Group 4: Polish (P2 items 11-12)
**Files:** `src/lib/session-ingester.ts`, `src/lib/scheduler-daemon.ts`
- Incremental directory discovery cache
- Health endpoint for ingestion lag

## Validation

```bash
# Unit: ingestion with mock fs should complete without blocking
bun test src/lib/__tests__/session-ingester.test.ts

# Integration: full cycle should complete in <5s for 1000 files
bun test src/lib/__tests__/session-ingester.integration.test.ts

# Metrics: verify ingestion emits duration/count metrics
genie sessions ingest --verbose 2>&1 | grep -E 'duration_ms|files_changed'

# Regression: existing CLI commands still work
genie sessions list --json | jq length
genie sessions search "test" --json | jq length

# Memory: no growth over 10 cycles
node --max-old-space-size=256 -e "for(let i=0;i<10;i++) await ingestSessions()"
```

## Context

**Why this matters now:** The ingester is the foundation for all session-level observability. Self-improvement loops, behavioral learning, and cost optimization all depend on reliable, performant session capture. Right now the pipeline captures data but the capture mechanism itself is a performance liability — it blocks the heartbeat, creates memory pressure, and has no visibility into its own health. Fix the foundation before building intelligence on top.

**What exists beyond the ingester:**
- OTel receiver captures real-time metrics (cost, tokens, latency) into audit_events — this is healthy and separate
- No automated consumer of session data exists yet — only 3 manual CLI commands
- The intelligence layer (pattern extraction, behavioral feedback, self-improvement) is the next wish after this one is stable
