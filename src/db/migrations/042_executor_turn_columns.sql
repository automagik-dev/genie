-- 042_executor_turn_columns.sql — Turn-Session Contract (Group 1)
-- Wish: turn-session-contract (genie side).
--
-- Adds four nullable columns to `executors` to record the explicit close
-- contract written by `genie done` / `blocked` / `failed` verbs and the
-- pane-exit trap safety net. All columns are additive and nullable so this
-- Phase A migration produces zero behavior change on its own — consumers
-- (Groups 2, 4, 5, 7) read/write these columns only when the reconciler
-- feature flag `GENIE_RECONCILER_TURN_AWARE` is enabled.
--
-- Column semantics (from DESIGN.md):
--   turn_id       UUID        — identifier for the current turn; set at turn
--                               open, preserved across close. NULL for
--                               pre-contract executors.
--   outcome       TEXT        — explicit outcome word written by the close
--                               verb: 'done' | 'blocked' | 'failed' |
--                               'clean_exit_unverified' (trap-written).
--                               NULL while the turn is still open.
--   closed_at     TIMESTAMPTZ — monotonic close timestamp; set by the single
--                               close transaction in Group 2.
--   close_reason  TEXT        — free-form rationale supplied with
--                               `--reason` on `genie blocked` / `genie failed`,
--                               or the sentinel 'clean_exit_unverified' for
--                               trap-written rows.
--
-- Indexes:
--   idx_executors_outcome enables fast filtering for the reconciler's
--   "skip terminalized" predicate and for analytics (`SELECT outcome,
--   COUNT(*) FROM executors GROUP BY outcome`).

ALTER TABLE executors ADD COLUMN IF NOT EXISTS turn_id UUID;
ALTER TABLE executors ADD COLUMN IF NOT EXISTS outcome TEXT;
ALTER TABLE executors ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE executors ADD COLUMN IF NOT EXISTS close_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_executors_outcome ON executors(outcome) WHERE outcome IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_executors_closed_at ON executors(closed_at) WHERE closed_at IS NOT NULL;
