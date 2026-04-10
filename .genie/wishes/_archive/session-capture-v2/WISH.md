# WISH: Session Capture v2 — Filewatch + Lazy Backfill + Tool Event Extraction

**Status:** DRAFT
**Priority:** P0 — replaces broken session ingester
**Repo:** repos/genie/
**Branch:** feat/session-capture-v2
**Supersedes:** session-ingester-perf (that wish is now obsolete)

## Problem

The current session ingester polls 4,121+ JSONL files every 60 seconds with synchronous I/O, blocking the heartbeat timer. It has no backfill capability — new users get zero historical data. It doesn't discover subagent sessions. It competes with its own heartbeat for CPU time. And it only captures raw text — there's no structured extraction of tool calls, so we can't answer "what was agent X doing on task Y" or debug proprietary CLI usage (genie, omni, rlmx).

Meanwhile, our OTel receiver (push-based, real-time, async) works perfectly for metrics. The session content pipeline should be just as clean — and extract structured tool event data alongside the raw content.

## Architecture

Three independent capture layers, each doing one thing well:

```
┌──────────────────────────────────────────────────────────────┐
│                    SESSION CAPTURE v2                         │
├──────────────────┬──────────────────┬────────────────────────┤
│  FILEWATCH       │  BACKFILL        │  OTEL (existing)       │
│  (ongoing)       │  (one-time)      │  (real-time)           │
│                  │                  │                        │
│  fs.watch on     │  Single worker   │  Already working       │
│  ~/.claude/      │  One file at a   │  Push-based            │
│  projects/       │  time, newest    │  metrics/events        │
│                  │  first           │                        │
│  Reacts to file  │  64KB chunks     │  HTTP POST             │
│  changes only    │  sleep(100ms)    │  → audit_events        │
│  Reads from      │  between files   │                        │
│  stored offset   │                  │  Zero filesystem       │
│  → PG            │  Pauses when     │  access                │
│                  │  filewatch has   │                        │
│  Zero CPU when   │  live work       │  No changes needed     │
│  idle            │  → PG            │                        │
└──────────────────┴──────────────────┴────────────────────────┘
```

**Data split:**
- `session_content` — raw assistant text, tool I/O for chat reconstruction in UI (unchanged)
- `tool_events` — **NEW** structured per-call records with full I/O, auto-parsed sub-tool, Genie context
- `audit_events` — cost, tokens, latency, tool decisions (from OTel receiver, unchanged)
- `sessions replay` joins all three by session_id + timestamp

## Discovery: Sessions + Subagents

JSONL files live in two locations:

```
~/.claude/projects/<project-hash>/sessions/<session-id>.jsonl          # main sessions
~/.claude/projects/<project-hash>/<session-id>/subagents/<sub-id>.jsonl  # subagent sessions
```

Discovery must scan both. Subagent sessions get `parent_session_id` set to the containing directory's session ID.

## Shared Core: `ingestFile(path, fromOffset)`

Both filewatch and backfill call the same function. No code duplication.

```typescript
async function ingestFile(
  sql: SqlClient,
  sessionId: string,
  jsonlPath: string,
  projectPath: string,
  fromOffset: number,
  opts?: { chunkSize?: number; parentSessionId?: string }
): Promise<{ newOffset: number; rowsInserted: number }>
```

- Reads from `fromOffset` to EOF (or `fromOffset + chunkSize` for backfill)
- Async I/O only (`fs.promises.open`, `fileHandle.read`)
- **Line-safe chunked reads**: reads `chunkSize` bytes, then scans backward from end of buffer to find the last `\n`. Only parses complete lines. Returns the offset of the last complete newline as `newOffset`, not the end of the buffer. Incomplete trailing bytes are left for the next read cycle — no line buffer state needed across calls.
  ```
  Example: 64KB chunk ends mid-line at byte 65536
  → scan backward, find last \n at byte 65412
  → parse bytes [fromOffset .. fromOffset+65412]
  → return newOffset = fromOffset + 65412
  → next read starts at 65412, re-reads the partial line + new data
  ```
- Batch INSERT to `session_content` via unnest (existing pattern, already good)
- **Tool event extraction** (same parse pass, same transaction):
  - Identifies ToolUse and ToolResult content blocks in each JSONL entry
  - Pairs them by `tool_use_id` in-memory during the parse pass
  - Extracts `sub_tool` automatically from input (see Sub-Tool Extraction below)
  - Stores full `input_raw` and `output_raw` — no truncation, data bounded by Claude's own tool limits
  - Denormalizes `agent_id, team, wish_slug, task_id` from session metadata onto each `tool_events` row
  - Batch INSERT to `tool_events` via unnest in the same transaction
  - Orphaned calls (ToolUse with no matching ToolResult) → `output_raw = NULL`, indicates crash
- **Offset committed to PG immediately**: single `UPDATE sessions SET last_ingested_offset = $newOffset` runs inside the same transaction as the batch INSERT for both `session_content` and `tool_events`. If any fails, all roll back — no orphaned offsets, no data loss on crash. This is what "committed" means for resume (criterion #8).
- Returns new offset and counts for caller to update in-memory cache

### Sub-Tool Extraction (automatic, no hardcoded categories)

```typescript
function extractSubTool(toolName: string, input: unknown): string | null {
  const obj = input as Record<string, unknown>;
  switch (toolName) {
    case 'Bash':
      // Full first line of command: "genie spawn engineer", "omni send --to X", "git push"
      return (obj?.command as string)?.split('\n')[0]?.trim() || null;
    case 'Read':
    case 'Write':
    case 'Edit':
      return (obj?.file_path as string) || null;
    case 'Grep':
      return (obj?.pattern as string) || null;
    case 'Glob':
      return (obj?.pattern as string) || null;
    case 'Agent':
      return (obj?.subagent_type as string) || null;
    case 'Skill':
      return (obj?.skill as string) || null;
    default:
      return null; // Unknown tools get sub_tool=NULL — no crash, just missing enrichment
  }
}
```

No enum. No category map. Raw data in, raw sub-tool out. The data teaches us what to look for. Query with `LIKE`, `~`, or full-text to discover patterns.

## Layer 1: Filewatch (Ongoing, Event-Driven)

Watches `~/.claude/projects/` recursively for JSONL file changes. Reacts only when a file is written — zero CPU when idle.

**Implementation:**
- Use `fs.watch` with `recursive: true` (Linux 5.9+ via inotify, supported on this server)
- Filter events: only `.jsonl` files, only `change` events (not `rename`)
- Debounce: 500ms per file (Claude Code writes multiple lines per turn)
- On event: call `ingestFile(path, storedOffset)`
- Store offsets in-memory Map (session_id → offset), backed by PG `sessions.last_ingested_offset`
- On startup: load offsets from PG into Map

**Separation from heartbeat:**
- Filewatch runs in its own `setInterval`-free loop (event-driven, not polling)
- Started by `scheduler-daemon.ts` as a standalone async task, NOT inside the heartbeat timer
- Never blocks heartbeats, snapshots, or worker events

**Error handling:**
- Per-file try/catch — one broken JSONL never stops others
- Log errors with file path and offset for debugging
- On `fs.watch` failure (too many watchers): fall back to 60s poll as degraded mode

## Layer 2: Backfill (One-Time, Lazy)

Ingests all existing JSONL data for new users or after schema changes. Runs automatically on first `genie daemon start` when no sessions exist in PG.

**Design principles:**
- Single worker, one file at a time, no concurrency
- 64KB chunk reads (never allocate a 200MB buffer for a fat session)
- 100ms sleep between files (never starve the event loop)
- Pauses when filewatch has live work (live data always wins)
- Resumes from exactly where it stopped (offset stored in PG)
- Works the same on a 2GB VPS and a 128GB server

**Queue:**
- Discovery: scan all JSONL files (main + subagent), sort by mtime descending (newest first)
- State: `backfill_state` row in a `session_sync` table (or reuse `sessions` offsets)
  ```
  { status: 'running' | 'paused' | 'complete',
    total_files: 4121,
    processed_files: 1847,
    total_bytes: 5368709120,
    processed_bytes: 2415919104,
    errors: 3,
    started_at: timestamp,
    updated_at: timestamp }
  ```
- Resume: on daemon restart, check `backfill_state.status`. If `running`, resume from where we left off (files with `last_ingested_offset < file_size` are unfinished)

**Trigger:**
- Auto-start on `genie daemon start` when `SELECT count(*) FROM sessions` returns 0
- Manual trigger: `genie sessions sync` (re-runs discovery, queues files not yet fully ingested)
- Skip if already complete: `backfill_state.status = 'complete'`

**Progress (queryable via `genie sessions sync --status`):**
```
Session backfill: 1,847 / 4,121 files (44.8%)
├─ Main sessions:    1,204 / 2,891
├─ Subagent sessions:  643 / 1,230
Bytes read:   2.3 GB / 5.1 GB
Rows inserted: 142,391
Rate: ~85 files/min
ETA: ~27 min
Errors: 3 (logged, skipped)
Status: running (paused 0 times for live events)
```

**Priority yielding (in-memory boolean coordination):**
- Shared module-level `let liveWorkPending = false` boolean in `session-capture.ts`, exported for both layers
- Filewatch sets `liveWorkPending = true` when it receives an fs.watch event, resets to `false` after processing all queued events
- Backfill checks `liveWorkPending` before each file. If true, enters a tight `await sleep(200ms)` loop until false
- No mutex needed — single-threaded Node.js event loop guarantees no torn reads on a boolean
- If backfill is mid-read when filewatch fires, the current chunk completes (64KB, <1ms), then backfill yields before the next file

## Layer 3: OTel Receiver (Existing, No Changes)

The OTel receiver at `src/lib/otel-receiver.ts` is already push-based, async, and batched. It captures cost, tokens, latency, tool decisions, and API metrics in real-time. No changes needed.

## Schema Changes

### New columns on `sessions` table

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS is_subagent BOOLEAN DEFAULT false;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS file_size BIGINT DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS file_mtime BIGINT DEFAULT 0;
```

### New table: `tool_events`

```sql
CREATE TABLE tool_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,

  -- Tool identity (auto-extracted, never hardcoded)
  tool_name TEXT NOT NULL,
  sub_tool TEXT,
  tool_use_id TEXT,

  -- Full input/output (no truncation — this IS the learning data)
  input_raw TEXT,
  output_raw TEXT,

  -- Outcome
  is_error BOOLEAN DEFAULT false,
  error_message TEXT,
  duration_ms INTEGER,

  -- Genie context (denormalized from sessions at ingest time for zero-join queries)
  agent_id TEXT,
  team TEXT,
  wish_slug TEXT,
  task_id TEXT,

  UNIQUE(session_id, tool_use_id)
);

CREATE INDEX idx_te_session ON tool_events(session_id);
CREATE INDEX idx_te_tool ON tool_events(tool_name);
CREATE INDEX idx_te_sub_tool ON tool_events(sub_tool) WHERE sub_tool IS NOT NULL;
CREATE INDEX idx_te_agent ON tool_events(agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX idx_te_team ON tool_events(team) WHERE team IS NOT NULL;
CREATE INDEX idx_te_wish ON tool_events(wish_slug) WHERE wish_slug IS NOT NULL;
CREATE INDEX idx_te_task ON tool_events(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_te_errors ON tool_events(is_error) WHERE is_error = true;
CREATE INDEX idx_te_timestamp ON tool_events(timestamp DESC);
CREATE INDEX idx_te_tool_sub ON tool_events(tool_name, sub_tool);
```

### Aggregation views (no pre-computed tables)

```sql
-- Tool usage per session
CREATE VIEW v_tool_usage AS
SELECT session_id, tool_name, sub_tool, COUNT(*) as call_count,
       COUNT(*) FILTER (WHERE is_error) as error_count
FROM tool_events GROUP BY session_id, tool_name, sub_tool;

-- File access per session
CREATE VIEW v_file_usage AS
SELECT session_id, sub_tool as file_path, tool_name as operation, COUNT(*) as access_count
FROM tool_events
WHERE tool_name IN ('Read', 'Write', 'Edit') AND sub_tool IS NOT NULL
GROUP BY session_id, sub_tool, tool_name;

-- Proprietary CLI usage (genie, omni, rlmx, khal) with error rates
CREATE VIEW v_cli_usage AS
SELECT team, wish_slug, agent_id, sub_tool,
       COUNT(*) as total_calls,
       COUNT(*) FILTER (WHERE is_error) as errors,
       ROUND(100.0 * COUNT(*) FILTER (WHERE is_error) / NULLIF(COUNT(*), 0), 1) as error_rate
FROM tool_events
WHERE tool_name = 'Bash' AND sub_tool ~ '^(genie|omni|rlmx|khal) '
GROUP BY team, wish_slug, agent_id, sub_tool;

-- Entity cost rollup (joins OTel audit_events with session context)
CREATE VIEW v_entity_cost AS
SELECT s.team, s.wish_slug, s.agent_id, s.task_id,
       COUNT(DISTINCT s.id) as session_count,
       SUM((ae.details->>'value')::numeric) FILTER (WHERE ae.event_type = 'gen_ai.client.token.usage') as total_tokens
FROM sessions s
LEFT JOIN audit_events ae ON ae.entity_id = s.id AND ae.entity_type = 'otel_metric'
GROUP BY s.team, s.wish_slug, s.agent_id, s.task_id;
```

### New table: `session_sync`

```sql
CREATE TABLE IF NOT EXISTS session_sync (
  id TEXT PRIMARY KEY DEFAULT 'backfill',
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, running, paused, complete
  total_files INTEGER DEFAULT 0,
  processed_files INTEGER DEFAULT 0,
  total_bytes BIGINT DEFAULT 0,
  processed_bytes BIGINT DEFAULT 0,
  errors INTEGER DEFAULT 0,
  error_log JSONB DEFAULT '[]',
  started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

## Files to Create/Modify

### New files
- `src/lib/session-capture.ts` — shared `ingestFile()` core, discovery (main + subagent), worker map builder
- `src/lib/session-filewatch.ts` — `fs.watch` event loop, debouncing, offset cache
- `src/lib/session-backfill.ts` — queue, single worker, progress tracking, pause/resume
- `src/db/migrations/010_session_capture_v2.sql` — schema changes

### Modified files
- `src/lib/scheduler-daemon.ts` — remove `ingestSessions()` call from heartbeat (line 1320-1324), start filewatch + backfill as independent async tasks
- `src/term-commands/sessions.ts` — add `genie sessions sync` and `genie sessions sync --status` commands
- `src/lib/session-ingester.ts` — DELETE this file (replaced entirely)

### Unchanged
- `src/lib/otel-receiver.ts` — no changes needed

## Acceptance Criteria

### Must Have (P0)

1. **Filewatch replaces polling** — `fs.watch` on `~/.claude/projects/` with recursive flag, reacts to JSONL changes only, debounced 500ms
2. **Async I/O only** — zero `statSync`, `readSync`, `openSync`, `closeSync` anywhere in the capture pipeline
3. **Off-heartbeat execution** — filewatch and backfill run as independent async tasks, never inside the heartbeat `setInterval`
4. **Incremental reads** — reads from stored offset, not from byte 0
5. **Subagent discovery** — discovers and ingests `<session-id>/subagents/<sub-id>.jsonl` files, sets `parent_session_id`
6. **Backfill on first start** — auto-triggers when `sessions` table is empty on daemon start
7. **Backfill progress** — `genie sessions sync --status` shows files/bytes/rows/ETA
8. **Backfill resume** — interrupted backfill resumes from last committed offset, no re-work
9. **Single worker backfill** — one file at a time, 64KB chunks, 100ms sleep between files
10. **Live priority** — backfill pauses when filewatch has events to process
11. **Old ingester removed** — `session-ingester.ts` deleted, heartbeat no longer calls `ingestSessions()`
12. **Tool event extraction** — every ToolUse/ToolResult in JSONL produces a `tool_events` row with full input_raw, full output_raw, auto-parsed sub_tool
13. **Tool call pairing** — ToolUse and ToolResult are paired by tool_use_id; orphaned calls (no result) get output_raw=NULL
14. **Denormalized Genie context** — each `tool_events` row carries agent_id, team, wish_slug, task_id copied from session metadata
15. **Idempotent tool events** — UNIQUE(session_id, tool_use_id) prevents duplicates on re-ingestion

### Should Have (P1)

12. **Backfill manual trigger** — `genie sessions sync` command for re-running backfill
13. **Error resilience** — per-file try/catch, errors logged with path+offset, never stops the pipeline
14. **Degraded mode** — if `fs.watch` fails (too many watchers), fall back to 60s async poll
15. **Worker map caching** — cache `buildWorkerMap()` result with 5-min TTL

### Nice to Have (P2)

16. **Inbox filewatch** — replace inbox 30s poll (`inbox-watcher.ts`) with `fs.watch` on `~/.claude/teams/`
17. **Capture metrics** — emit files_watched, events_processed, backfill_progress to stdout or audit_events

## Execution Groups

### Group 1: Shared Core + Schema + Tool Extraction (P0 items 1-5, 12-15)
**Files:** `src/lib/session-capture.ts`, migration SQL
- `ingestFile()` — async read from offset, streaming parse, batch insert to BOTH `session_content` AND `tool_events`
- `extractSubTool()` — automatic sub-tool parsing from tool input
- Tool call pairing logic (in-memory ToolUse→ToolResult matching by tool_use_id)
- `discoverAllJsonlFiles()` — main sessions + subagent sessions
- `buildWorkerMap()` — cached version with TTL
- Schema migration `010_session_capture_v2.sql`: `parent_session_id` (ON DELETE SET NULL), `is_subagent`, `file_size`, `file_mtime`, `session_sync` table, `tool_events` table + indexes, aggregation views

### Group 2: Filewatch (P0 items 1-3)
**Files:** `src/lib/session-filewatch.ts`, `src/lib/scheduler-daemon.ts`
- `startFilewatch()` — `fs.watch` recursive, debounce, event handler
- Offset cache (in-memory Map backed by PG)
- Wire into scheduler-daemon as independent async task
- Remove `ingestSessions()` from heartbeat loop

### Group 3: Backfill (P0 items 6-11)
**Files:** `src/lib/session-backfill.ts`, `src/term-commands/sessions.ts`
- Queue: discovery sorted by mtime desc (newest first)
- Single worker: one file, 64KB chunks, 100ms sleep
- Progress: `session_sync` table, queryable via CLI
- Resume: check offsets on restart
- Priority yield: pause flag checked by filewatch
- Delete `src/lib/session-ingester.ts`

### Group 4: Polish (P1-P2 items 12-17)
**Files:** various
- `genie sessions sync` manual trigger
- Error logging, degraded poll fallback
- Worker map caching
- Inbox filewatch migration
- Capture metrics

## Validation

```bash
# Group 1: Core + schema + tool extraction
bun test src/lib/session-capture.test.ts
psql -c "SELECT column_name FROM information_schema.columns WHERE table_name='sessions' AND column_name='parent_session_id'"
psql -c "SELECT count(*) FROM information_schema.tables WHERE table_name='tool_events'"
# Expected: 1 (table exists)

# Group 1: Tool event extraction verification
# After ingesting any session with tool calls:
psql -c "SELECT tool_name, sub_tool, is_error FROM tool_events LIMIT 10"
# Expected: rows with tool_name='Bash', sub_tool='genie spawn engineer', etc.
psql -c "SELECT * FROM v_cli_usage LIMIT 5"
# Expected: aggregated CLI usage with error rates
psql -c "SELECT * FROM v_file_usage LIMIT 5"
# Expected: file access counts per session

# Group 2: Filewatch
# Start daemon, write to a JSONL file, verify it appears in session_content AND tool_events within 2s
genie daemon start --foreground &
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"genie status"}}]}}' >> ~/.claude/projects/test/sessions/test-session.jsonl
sleep 2
psql -c "SELECT count(*) FROM session_content WHERE session_id='test-session'"
# Expected: >= 1
psql -c "SELECT tool_name, sub_tool FROM tool_events WHERE session_id='test-session'"
# Expected: Bash, genie status

# Group 3: Backfill
# Clear sessions, restart daemon, verify backfill starts
psql -c "DELETE FROM tool_events; DELETE FROM session_content; DELETE FROM sessions; DELETE FROM session_sync"
genie daemon restart
sleep 5
genie sessions sync --status
# Expected: "Session backfill: N / M files (X%)"

# Group 4: Regression
genie sessions list --json | jq length       # should return sessions
genie sessions search "test" --json          # full-text search still works
genie sessions replay <id>                   # interleaved content + OTel timeline

# Proprietary CLI debugging queries (manual verification)
psql -c "SELECT sub_tool, input_raw, output_raw FROM tool_events WHERE tool_name='Bash' AND sub_tool LIKE 'genie %' AND is_error=true LIMIT 5"
psql -c "SELECT sub_tool, input_raw, output_raw FROM tool_events WHERE tool_name='Bash' AND sub_tool LIKE 'omni %' AND is_error=true LIMIT 5"
psql -c "SELECT sub_tool, input_raw FROM tool_events WHERE tool_name='Bash' AND sub_tool LIKE 'rlmx %' ORDER BY timestamp DESC LIMIT 5"
```

## Context

**Why v2:** The current ingester (v1) was a quick implementation that worked at small scale but doesn't survive 4,000+ files. Rather than patching it with async I/O and caching (the old wish), we're replacing the architecture entirely: event-driven for live capture, lazy queue for backfill, shared core for both.

**Why no concurrency on backfill:** Backfill isn't trivial. Concurrent readers create race conditions on offset tracking, fd exhaustion on small machines, and unpredictable memory usage. A single lazy worker is slower but works everywhere — from a 2GB VPS to a 128GB server. Speed is not the goal; reliability is.

**Why newest-first backfill:** New users care about their recent sessions, not sessions from 6 months ago. Backfilling newest-first means the most relevant data is available within minutes, even if full backfill takes hours.

**What stays the same:** The OTel receiver is untouched. `session_content` table schema is unchanged. `sessions replay` join logic is unchanged. The three CLI commands (`list`, `replay`, `search`) continue to work identically.

**Why tool_events:** Genie is a multi-agent orchestration platform. Sessions belong to agents, agents work on tasks in boards, teams execute wishes. We need to answer "what was agent X doing on task Y in wish Z — show me every tool call, every file touched, every dollar spent." We also need to debug proprietary CLI usage — when `genie spawn` fails, when `omni send` errors, when `rlmx` times out. Full input/output storage lets us see exactly how the agent called our tools and what went wrong. The sub_tool is auto-extracted (not classified) so the data reveals patterns without hardcoded assumptions.

**Design reference:** `.genie/brainstorms/session-observability/DESIGN.md` — full brainstorm with council input on aggregation strategy (views not tables, denormalized context, no pre-computed aggregates).
