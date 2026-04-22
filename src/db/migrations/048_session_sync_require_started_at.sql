-- Session-sync durability guard.
--
-- Context: 2026-04-22 investigation found a `session_sync` row with
-- status='complete', processed_files=535, started_at=NULL — a stale marker
-- that blocked the Claude-session backfill indefinitely. Root cause:
-- updateSyncState() never populated `started_at` on the initial INSERT, and
-- the schema accepted a 'complete' row with no start time. This migration
-- closes the schema side of the hole; the code side is fixed in
-- session-backfill.ts in the same PR.
--
-- Steps:
--   1. Backfill NULL started_at from updated_at so the NOT NULL add cannot
--      fail on existing rows (trace confirmed only one such row exists).
--   2. Enforce started_at NOT NULL.
--   3. Add a CHECK constraint: a terminal status (complete/failed) requires
--      updated_at >= started_at. This rejects zero-time 'complete' markers
--      that claim work which never ran. Equal timestamps pass — a legitimate
--      sub-millisecond run is allowed.

UPDATE session_sync
   SET started_at = updated_at
 WHERE started_at IS NULL;

ALTER TABLE session_sync
  ALTER COLUMN started_at SET NOT NULL;

ALTER TABLE session_sync
  DROP CONSTRAINT IF EXISTS session_sync_terminal_has_runtime;

ALTER TABLE session_sync
  ADD CONSTRAINT session_sync_terminal_has_runtime
  CHECK (status NOT IN ('complete', 'failed') OR updated_at >= started_at);
