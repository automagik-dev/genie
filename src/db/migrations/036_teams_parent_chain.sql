-- 036_teams_parent_chain.sql — Cross-team reachback via parentTeam chain.
-- Adds two nullable columns to the `teams` table:
--   * parent_team           — optional parent team name (FK-less pointer for cycle tolerance)
--   * allow_child_reachback — ALLOWLIST of child-team-name prefixes that can reach back
-- Fixes the council-member isolation drift where ephemeral council-<ts> teams could not
-- reply to members of the caller's home team. Pure additive — zero breaking changes.

ALTER TABLE teams ADD COLUMN IF NOT EXISTS parent_team TEXT;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS allow_child_reachback JSONB;

CREATE INDEX IF NOT EXISTS idx_teams_parent_team
  ON teams(parent_team) WHERE parent_team IS NOT NULL;
