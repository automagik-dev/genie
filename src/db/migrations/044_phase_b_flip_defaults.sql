-- 044_phase_b_flip_defaults.sql — Turn-Session Contract (Group 8, Phase B)
-- Wish: turn-session-contract (genie side).
--
-- Flips production defaults so every new agent opts into the turn-aware
-- reconciler contract delivered in Groups 4/5/7:
--   • Group 4 — runAgentRecoveryPass honors GENIE_RECONCILER_TURN_AWARE
--   • Group 5 — pane-exit trap writes clean_exit_unverified
--   • Group 7 — scripts/reconcile-orphans.ts one-shot cleanup
--
-- This migration is the Phase B boundary: before it lands the flag is
-- opt-in, after it the flag defaults ON (code-side flip in
-- scheduler-daemon.ts) and the schema default matches.
--
-- Forward-only and idempotent — every statement guards with either a
-- predicate that no-ops on a second apply (`IS DISTINCT FROM …`) or a
-- CTE that selects zero rows on a clean DB.
--
-- Changes
-- ───────
--
-- 1. `agents.auto_resume` DEFAULT flips from true → false.
--    Applies to new agents only; existing rows keep whatever value they
--    have. The explicit close verbs (`genie done` / `blocked` / `failed`)
--    and the pane-exit trap are the authoritative terminators; automatic
--    resume becomes opt-in.
--
-- 2. Backfill live rows to `auto_resume=true`.
--    Rows whose `last_state_change` is within the last hour and whose
--    state is non-terminal keep auto-resume so currently-active agents
--    aren't silently dropped at the flip boundary.
--
-- 3. Backfill stale/closed rows to `auto_resume=false`.
--    Rows whose executor closed (`executors.closed_at IS NOT NULL`), or
--    whose agent state is terminal, or whose `last_state_change` is
--    older than one hour are taken out of the resume pool. These are the
--    ghost-loop precursors the flip is meant to eliminate.
--
-- 4. Orphan terminalization.
--    Ports the cheap predicate from scripts/reconcile-orphans.ts: any
--    non-terminal agent whose `last_state_change` > 1h ago and whose
--    pane_id is a dead-pane sentinel (NULL, empty, 'inline') is flipped
--    to state='error' with a `reconcile.terminalize` audit event.
--    Live tmux-pane probing is intentionally deferred to the reconciler
--    itself — this SQL runs during apply and cannot reach the tmux
--    socket. Operators who want full parity should still run
--    `bun scripts/reconcile-orphans.ts --apply` after the migration.
--
-- Acceptance (C16 / C17 from WISH.md):
--   • `auto_resume` default is false
--   • Live agents (last_state_change within 1 hour) preserve
--     auto_resume=true
--   • Closed / stale rows are auto_resume=false
--   • Orphan sentinel rows are terminalized before flag flip
--
-- NOTE: The code-side flag-default flip happens in src/lib/scheduler-daemon.ts
-- (`isTurnAwareReconcilerEnabled` — explicit env=false still rolls back).

-- ─────────────────────────────────────────────────────────────────────
-- 1. Column default flip
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE agents ALTER COLUMN auto_resume SET DEFAULT false;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Preserve auto_resume=true for live agents
-- ─────────────────────────────────────────────────────────────────────
UPDATE agents
SET auto_resume = true
WHERE last_state_change IS NOT NULL
  AND last_state_change >= now() - interval '1 hour'
  AND state IS NOT NULL
  AND state NOT IN ('done', 'error', 'suspended')
  AND auto_resume IS DISTINCT FROM true;

-- ─────────────────────────────────────────────────────────────────────
-- 3. Flip stale / closed rows to auto_resume=false
-- ─────────────────────────────────────────────────────────────────────
UPDATE agents a
SET auto_resume = false
WHERE (
        a.last_state_change IS NULL
        OR a.last_state_change < now() - interval '1 hour'
        OR a.state IN ('done', 'error', 'suspended')
        OR EXISTS (
          SELECT 1 FROM executors e
          WHERE e.id = a.current_executor_id
            AND e.closed_at IS NOT NULL
        )
      )
  AND a.auto_resume IS DISTINCT FROM false;

-- ─────────────────────────────────────────────────────────────────────
-- 4. Orphan terminalization — SQL mirror of scripts/reconcile-orphans.ts
--    for rows with dead-pane sentinels. Live-pane probing stays with
--    the reconciler itself (it has tmux socket access).
-- ─────────────────────────────────────────────────────────────────────
WITH orphans AS (
  SELECT id, state, pane_id
  FROM agents
  WHERE state IS NOT NULL
    AND state NOT IN ('done', 'error', 'suspended')
    AND last_state_change IS NOT NULL
    AND last_state_change < now() - interval '1 hour'
    AND (pane_id IS NULL OR pane_id = '' OR pane_id = 'inline')
),
updated AS (
  UPDATE agents a
  SET state = 'error',
      last_state_change = now()
  FROM orphans o
  WHERE a.id = o.id
  RETURNING a.id, o.state AS state_before, o.pane_id
)
INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details)
SELECT
  'agent',
  u.id,
  'reconcile.terminalize',
  'migration-044',
  jsonb_build_object(
    'state_before', u.state_before,
    'pane_id',      u.pane_id,
    'reason',       'migration_044_phase_b'
  )
FROM updated u;
