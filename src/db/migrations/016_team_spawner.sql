-- 016: Team Spawner — track who created each team.
-- Adds `spawner` column to teams table for orchestrator tracking.
-- Idempotent: safe to re-run.

ALTER TABLE teams ADD COLUMN IF NOT EXISTS spawner TEXT;
