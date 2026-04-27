-- 053_master_backfill_and_shadow_cleanup.sql
--
-- master-aware-spawn wish, Wave 2, Group 14 (sub-deliverables 14a + 14b).
--
-- The 2026-04-25 power-outage post-mortem surfaced that masters today fall
-- into two shadow patterns in PG (twin's analysis at
-- /tmp/genie-recover/group-1-shadow-analysis.json):
--
--   Type A — `dir:<name>` + bare-name pair (only `email` today). Both rows
--           exist; `findLiveWorkerFuzzy(name)` returns the bare row first,
--           so Group 1's `worker?.id ?? \`dir:\${recipientId}\`` chokepoint
--           fallback never fires. Result: master `email` re-spawns fresh
--           every time the live worker dies.
--
--   Type B — UUID + bare-name pair, NO `dir:<name>` row (`felipe`, `genie`,
--           `genie-pgserve`). The bare row's `custom_name=''` blocks the
--           jsonl-scan fallback (Group 7), and there is no `dir:` row for
--           Group 1's chokepoint to anchor on. Result: post-`unregister`
--           recovery is impossible without manual surgery.
--
-- This migration closes both gaps in two passes:
--
--   1. **14b — master backfill:** for every agent row with
--      `kind='permanent' AND repo_path != ''` whose canonical name (custom_name
--      or role fallback) lacks a `dir:<name>` peer, create the missing
--      directory row using the bare row's identity columns. Brings
--      `dir:felipe`, `dir:genie`, `dir:genie-pgserve` into existence.
--
--   2. **14a — bare-name shadow cleanup:** for every `dir:<name>` row that
--      pairs with a non-UUID, non-dir bare-name row whose
--      `current_executor_id IS NULL`, archive (state='archived',
--      auto_resume=false) the bare row. **Heal-not-wipe** — never DELETE.
--      The Group 3 guardrail in `src/lib/agent-directory.ts:rm()` blocks
--      DELETE on `kind='permanent' AND repo_path != ''` regardless, but
--      a SQL-side UPDATE bypasses that lock by design.
--
-- 14b runs before 14a so the dir-rows we just created can pair with their
-- bare shadows in the same migration. After this migration runs:
--
--   - `dir:email`, `dir:felipe`, `dir:genie`, `dir:genie-pgserve` all exist
--     and carry `repo_path`. Group 1's chokepoint extension covers all four.
--   - bare `email`, `felipe`, `genie`, `genie-pgserve` rows with
--     `current_executor_id IS NULL` are archived. registry.get(name) now
--     returns either nothing (so worker is null → Group 1 fallback fires) or
--     the dir:<name> row directly.
--
-- Idempotent: each pass gates on a NOT-EXISTS / DISTINCT-FROM-archived
-- predicate. Re-running the migration affects zero additional rows.
--
-- Audit: every backfilled row emits `directory.master_backfilled`; every
-- archived bare shadow emits `state_changed` with reason
-- `bare_name_shadow_archived`.

-- ---------------------------------------------------------------------------
-- Pass 1 (14b): backfill dir:<name> rows for masters that lack one.
-- ---------------------------------------------------------------------------
WITH
  -- Pick one canonical source row per "name" equivalence class. The bare
  -- row of a Type-B pair (custom_name='' but role + repo_path set) is the
  -- only source carrying repo_path, so we filter on repo_path-non-empty
  -- candidates here. Prefer rows with non-empty custom_name when both
  -- candidates exist (NULLIF + ORDER BY in DISTINCT ON).
  backfill_targets AS (
    SELECT DISTINCT ON (COALESCE(NULLIF(a.custom_name, ''), a.role))
      COALESCE(NULLIF(a.custom_name, ''), a.role) AS name,
      a.role,
      a.team,
      a.repo_path
    FROM agents a
    WHERE a.kind = 'permanent'
      AND a.id NOT LIKE 'dir:%'
      AND a.repo_path IS NOT NULL AND a.repo_path <> ''
      AND COALESCE(NULLIF(a.custom_name, ''), a.role) IS NOT NULL
      AND a.auto_resume = true
      AND a.state IS DISTINCT FROM 'archived'
      AND NOT EXISTS (
        SELECT 1 FROM agents d
        WHERE d.id = 'dir:' || COALESCE(NULLIF(a.custom_name, ''), a.role)
      )
    ORDER BY
      COALESCE(NULLIF(a.custom_name, ''), a.role),
      -- Prefer rows that already populate custom_name (UUID peer in Type B),
      -- so role/team fields come from the canonical identity row.
      (CASE WHEN a.custom_name IS NOT NULL AND a.custom_name <> '' THEN 0 ELSE 1 END),
      a.id
  ),
  inserted AS (
    INSERT INTO agents (id, role, custom_name, team, repo_path, started_at, state, metadata)
    SELECT
      'dir:' || c.name,
      c.role,
      -- The unique partial index `idx_agents_custom_name_team` requires
      -- (custom_name, team) to be unique when both are non-null. If a peer
      -- already owns that slot (Type B production: UUID peer with
      -- custom_name=name, team=team), set custom_name=NULL on the dir row
      -- so the new row sits outside the unique index. Session-sync's
      -- `getAgentByName(name, team)` lookup will route to the UUID peer
      -- while it lives; once the peer is unregistered, an UPDATE
      -- backfill (separate migration if the slot ever frees) can repopulate.
      CASE
        WHEN c.team IS NOT NULL AND EXISTS (
          SELECT 1 FROM agents x
          WHERE x.custom_name = c.name AND x.team = c.team
            AND x.id <> 'dir:' || c.name
        ) THEN NULL
        ELSE c.name
      END,
      c.team,
      c.repo_path,
      now(),
      NULL,
      '{}'::jsonb
    FROM backfill_targets c
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  )
INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details)
SELECT 'agent', i.id, 'directory.master_backfilled',
       'migration:053_master_backfill_and_shadow_cleanup',
       jsonb_build_object('reason', 'master_backfill',
                          'wish', 'master-aware-spawn',
                          'group', '14b')
FROM inserted i;

-- ---------------------------------------------------------------------------
-- Pass 2 (14a): archive bare-name shadows whose dir:<name> peer now exists.
-- Heal-not-wipe — never DELETE. Idempotent via state IS DISTINCT FROM.
-- ---------------------------------------------------------------------------
WITH archived AS (
  UPDATE agents bare
  SET state = 'archived',
      auto_resume = false,
      last_state_change = now()
  FROM agents dir
  WHERE dir.id = 'dir:' || bare.id
    AND bare.id NOT LIKE 'dir:%'
    -- Exclude UUID-shaped ids (4 hyphens). Same heuristic as migration 050.
    AND bare.id NOT LIKE '%-%-%-%-%'
    AND bare.current_executor_id IS NULL
    AND bare.state IS DISTINCT FROM 'archived'
    AND bare.repo_path IS NOT NULL
    AND bare.repo_path <> ''
    -- Belt-and-suspenders identity match: the bare row's role or id must
    -- agree with the dir's custom_name. Prevents archiving an unrelated
    -- bare row whose id happens to suffix a dir: id.
    AND (
      bare.role = dir.custom_name
      OR bare.id = dir.custom_name
      OR bare.custom_name = dir.custom_name
    )
  RETURNING bare.id
)
INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details)
SELECT 'worker', a.id, 'state_changed',
       'migration:053_master_backfill_and_shadow_cleanup',
       jsonb_build_object('reason', 'bare_name_shadow_archived',
                          'state', 'archived',
                          'auto_resume', false,
                          'wish', 'master-aware-spawn',
                          'group', '14a')
FROM archived a;
