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
-- The fix: extract the jsonb value as plain text via `#>>'{}'` (which strips
-- the outer jsonb-string wrapping and returns the raw inner JSON text like
-- `["a","b"]`), then cast that text back into jsonb as a proper array.
--
-- NOTE: `jsonb_col::text::jsonb` does NOT work here — for a jsonb-string,
-- `::text` returns the quoted-escaped form (e.g. `"[\"a\",\"b\"]"`), and
-- `::jsonb` of that parses to the same jsonb-string. That round-trip is a
-- silent no-op. Use `#>>'{}'` to unwrap properly. Verified on the live
-- genie-stefani server (7 teams rehydrated from string → array).
--
-- Idempotent: the `WHERE jsonb_typeof(col) = 'string'` guard ensures
-- re-running this migration is a no-op on already-correct rows.
--
-- Write-path fix ships in the same PR (see `src/lib/team-manager.ts` and
-- `src/lib/pg-seed.ts`) — those call sites now use `sql.json()`, so no new
-- drift is produced after this migration runs.

BEGIN;

-- teams.members: stringified array → proper jsonb array.
UPDATE teams
SET members = (members #>> '{}')::jsonb
WHERE jsonb_typeof(members) = 'string';

-- teams.allow_child_reachback: same pattern, same fix (nullable column).
UPDATE teams
SET allow_child_reachback = (allow_child_reachback #>> '{}')::jsonb
WHERE allow_child_reachback IS NOT NULL
  AND jsonb_typeof(allow_child_reachback) = 'string';

-- agents.sub_panes: same pattern (written via JSON.stringify in pg-seed.ts).
UPDATE agents
SET sub_panes = (sub_panes #>> '{}')::jsonb
WHERE sub_panes IS NOT NULL
  AND jsonb_typeof(sub_panes) = 'string';

-- agent_templates.extra_args: same pattern.
UPDATE agent_templates
SET extra_args = (extra_args #>> '{}')::jsonb
WHERE extra_args IS NOT NULL
  AND jsonb_typeof(extra_args) = 'string';

COMMIT;
