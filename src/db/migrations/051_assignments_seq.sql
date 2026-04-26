-- 051_assignments_seq.sql
--
-- Hotfix follow-up to a049e0c7 ("chokepoint tiebreaker + dispatch PG marker").
-- That commit added `ORDER BY asg.started_at DESC, asg.id DESC` to the
-- single-reader chokepoint and claimed BIGSERIAL guaranteed insertion-order
-- ties. The claim was wrong: `assignments.id` is `TEXT DEFAULT
-- gen_random_uuid()::text`, so `id DESC` is a coin flip on the equality
-- case. The shared-pgserve test "most-recent assignment is the one
-- consulted (older completed, newer open)" continued to flake because
-- `started_at` is supplied by the JS caller from `new Date().toISOString()`
-- (millisecond precision) and CI fits both INSERTs inside the same ms.
--
-- Real fix: give the table the monotonic insertion-order column the prior
-- comment assumed already existed. BIGSERIAL fills existing rows in physical
-- (ctid) order on column add, then increments deterministically for every
-- subsequent INSERT. The chokepoint reader switches to `ORDER BY asg.seq
-- DESC LIMIT 1` and the equality case disappears entirely — no timestamps,
-- no UUIDs, just the sequence.
--
-- Backwards compatibility: existing readers that order by `started_at` are
-- unaffected; nothing drops `started_at`. Only the chokepoint subquery in
-- src/lib/should-resume.ts switches to the seq column.

ALTER TABLE assignments
  ADD COLUMN IF NOT EXISTS seq BIGSERIAL;

-- Cover the chokepoint subquery's executor-scoped most-recent lookup.
-- (executor_id ASC just narrows the scan; seq DESC is what matters.)
CREATE INDEX IF NOT EXISTS idx_assignments_executor_seq
  ON assignments (executor_id, seq DESC);
