-- 055_default_auto_resume_true.sql — Flip the agents.auto_resume default to
-- TRUE and backfill every existing FALSE row to TRUE.
--
-- Why
-- ---
-- DB evidence (2026-05-07): 52 of 53 agents had auto_resume=false. The
-- chokepoint `shouldResume()` treats false as "operator paused or scheduler
-- exhausted retry budget" — but the column was effectively defaulting off,
-- so no agent could be resumed without first running `genie agent recover`
-- to flip the flag. Felipe directive (2026-05-07): default-on is the bug
-- shape; flip every existing row to true and change the column DEFAULT so
-- newly-spawned agents get the safe value out of the gate.
--
-- This migration also lands the trace-confirmed bug fix where
-- `MissingResumeSessionError` reported reason='null_session' on rows whose
-- session UUID was perfectly intact — auto_resume=false was the actual
-- precondition. The protocol-router error enum now distinguishes the two
-- (`auto_resume_disabled` vs `null_session`); this migration removes the
-- silent default-off that triggered the misleading message in the first
-- place.
--
-- Idempotent: re-running this migration is a no-op on rows that are already
-- true and on a column whose default is already true.

BEGIN;

-- 1. Flip every existing false row. No WHERE narrowing — Felipe directive
--    is to flip ALL of them so resume works out-of-the-box.
UPDATE agents
SET auto_resume = true
WHERE auto_resume = false;

-- 2. Change the column DEFAULT so future spawns inherit the safe value.
--    NULLs (legacy rows that pre-date the column) become true — same as
--    the safe-default the runtime treats them as.
ALTER TABLE agents ALTER COLUMN auto_resume SET DEFAULT true;
UPDATE agents SET auto_resume = true WHERE auto_resume IS NULL;

COMMIT;
