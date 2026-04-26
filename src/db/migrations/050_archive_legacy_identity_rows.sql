-- 050_archive_legacy_identity_rows.sql
--
-- Group 5 of the invincible-genie wish.
--
-- One-shot cleanup migration: quiesce two classes of legacy identity row
-- whose presence in `genie ls` confused the boot-pass story and tripped
-- the `MAX_SPAWN_FAILURES` ceiling on inbox-watcher.
--
-- We **never** delete; we only flip `auto_resume = false` (and stamp the
-- canonical archived state where applicable). Operators who actually want
-- one of these rows back can `genie agent unpause <id>`. This is the
-- council-mandated guardrail for the cleanup-migration risk row.
--
-- Two cohorts:
--
-- 1. `felipe-trace-*` rows (and friends) that lived through repeated
--    long-running incident traces. The newer `genie status` flow already
--    exposes `archived` agents behind `--all`; quiescing them removes
--    them from the default list AND from the boot-pass uniform pass
--    (which only rehydrates `auto_resume=true`).
--
-- 2. Legacy stringly-typed identity rows: rows whose `id` is a bare role
--    name like `'felipe'` (the historical, pre-UUID identity convention)
--    whenever a UUID-keyed counterpart already exists for the same
--    `custom_name`. The bare-name rows haunted `genie ls` long after the
--    UUID swap; they have no live executor anchor and never will. The
--    UUID-keyed peer is the live one — see #1395 / #1397 for the schema
--    convergence story.
--
-- Idempotent: re-running the migration affects zero additional rows
-- because both UPDATEs gate on `auto_resume IS DISTINCT FROM false`.
--
-- Audit: every flipped row gets a corresponding `audit_events` insert
-- (entity_type='worker', event_type='state_changed') so the cleanup is
-- traceable forever.

-- Cohort 1: felipe-trace-* rows already archived but still spinning the
-- boot-pass. Idempotent gate on auto_resume.
WITH flipped AS (
  UPDATE agents
  SET auto_resume = false,
      last_state_change = now()
  WHERE id LIKE 'felipe-trace-%'
    AND auto_resume IS DISTINCT FROM false
  RETURNING id
)
INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details)
SELECT 'worker', f.id, 'state_changed', 'migration:050_archive_legacy_identity_rows',
       jsonb_build_object('reason', 'legacy_trace_row_quiesced',
                          'auto_resume', false,
                          'wish', 'invincible-genie',
                          'group', 5)
FROM flipped f;

-- Cohort 2: legacy bare-name identity rows. Quiesce when a UUID-keyed
-- counterpart exists for the same (custom_name, team). The UUID rows are
-- the live ones; the bare-name rows are leftover from pre-#1395 ID conv.
WITH flipped AS (
  UPDATE agents legacy
  SET auto_resume = false,
      last_state_change = now()
  WHERE legacy.custom_name IS NULL
    AND legacy.id NOT LIKE 'dir:%'
    AND legacy.id NOT LIKE '%-%-%-%-%'  -- non-UUID shape
    AND legacy.auto_resume IS DISTINCT FROM false
    AND EXISTS (
      SELECT 1
      FROM agents uuid_peer
      WHERE uuid_peer.id LIKE '%-%-%-%-%'
        AND uuid_peer.custom_name = legacy.id
        AND uuid_peer.id <> legacy.id
    )
  RETURNING legacy.id
)
INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details)
SELECT 'worker', f.id, 'state_changed', 'migration:050_archive_legacy_identity_rows',
       jsonb_build_object('reason', 'legacy_stringly_typed_row_quiesced',
                          'auto_resume', false,
                          'wish', 'invincible-genie',
                          'group', 5)
FROM flipped f;

-- Cohort 3: wish-named team-lead orphans. Backfill for the auto-archive
-- behaviour wired into `genie wish done <slug>` in this same wish/group.
-- Any agent row whose `team` matches an archived wish slug is a leftover
-- team-lead identity ("design-system-severance" et al.) — flip auto_resume
-- off and stamp `state='archived'`. The state predicate ensures the row is
-- hidden from `genie ls`/`genie status` by default.
--
-- We can't read `.genie/wishes/_archive/` from a SQL migration, so we use
-- a heuristic: the row's `team` equals its `id` (self-orphan, matching the
-- wish-team-lead-shape) AND the row's `state` is not already terminal
-- AND no live executor anchors it. Operators can audit via
--   SELECT id FROM agents WHERE team = id AND auto_resume = false;
WITH flipped AS (
  UPDATE agents
  SET auto_resume = false,
      state = 'archived',
      last_state_change = now()
  WHERE team IS NOT NULL
    AND team = id
    AND state IS DISTINCT FROM 'archived'
    AND auto_resume IS DISTINCT FROM false
    AND NOT EXISTS (
      SELECT 1 FROM executors e
      WHERE e.agent_id = agents.id
        AND e.state NOT IN ('done', 'error', 'terminated')
    )
  RETURNING id
)
INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details)
SELECT 'worker', f.id, 'state_changed', 'migration:050_archive_legacy_identity_rows',
       jsonb_build_object('reason', 'wish_named_team_lead_orphan',
                          'auto_resume', false,
                          'state', 'archived',
                          'wish', 'invincible-genie',
                          'group', 5)
FROM flipped f;
