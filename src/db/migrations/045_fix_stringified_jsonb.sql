-- Migration 045 — Normalize double-encoded jsonb columns
--
-- Fixes rows written by `JSON.stringify(value)` + postgres.js tagged template,
-- which produced a jsonb string containing JSON-encoded array text (Bug D in
-- `.genie/wishes/fix-pg-disk-rehydration/WISH.md`).
--
-- Observed drift in production:
--   SELECT jsonb_typeof(members) FROM teams WHERE name = 'genie-docs';
--   → 'string'  (should be 'array')
--   SELECT members FROM teams WHERE name = 'genie-docs';
--   → '["genie-configure"]'  (the literal JSON-encoded string, not an array)
--
-- The fix: cast the jsonb-string value to text (which strips the outer jsonb
-- string quoting and returns the inner JSON text) and re-parse as jsonb.
-- Idempotent: the `WHERE jsonb_typeof(col) = 'string'` guard ensures
-- re-running this migration is a no-op on already-correct rows.
--
-- Write-path fix ships in the same PR (see `src/lib/team-manager.ts` and
-- `src/lib/pg-seed.ts`) — those call sites now use `sql.json()`, so no new
-- drift is produced after this migration runs.

BEGIN;

-- teams.members: stringified array → proper jsonb array.
UPDATE teams
SET members = members::text::jsonb
WHERE jsonb_typeof(members) = 'string';

-- teams.allow_child_reachback: same pattern, same fix (nullable column).
UPDATE teams
SET allow_child_reachback = allow_child_reachback::text::jsonb
WHERE allow_child_reachback IS NOT NULL
  AND jsonb_typeof(allow_child_reachback) = 'string';

-- agents.sub_panes: same pattern (written via JSON.stringify in pg-seed.ts).
UPDATE agents
SET sub_panes = sub_panes::text::jsonb
WHERE sub_panes IS NOT NULL
  AND jsonb_typeof(sub_panes) = 'string';

-- agent_templates.extra_args: same pattern.
UPDATE agent_templates
SET extra_args = extra_args::text::jsonb
WHERE extra_args IS NOT NULL
  AND jsonb_typeof(extra_args) = 'string';

COMMIT;
