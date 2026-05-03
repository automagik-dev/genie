-- 061_agents_id_invariant_and_fk_lockdown.sql
--
-- Wish: retire-session-names-id-only, Group 1.
--
-- Closes the structural cause of recurring identity drift in three sweeps:
--
--   (a) `agents.id` accepts UUID-shaped values OR `dir:<name>`, enforced by
--       a CHECK constraint. Bare-name inserts fail at the DB level forever.
--   (b) Every reference column FKs to `agents.id`:
--         mailbox.from_worker, mailbox.to_worker,
--         team_chat.sender,
--         teams.leader,
--         agents.reports_to.
--       Drift always lands where the schema doesn't enforce shape; SQL is the
--       only enforcement that holds across refactors.
--   (c) `agent_templates` becomes UUID PK + unique (name, team), so template
--       identity stops doubling as a name lookup key.
--   (d) `teams.members` JSONB array elements are validated as UUID or
--       `dir:<name>` strings via a CHECK constraint.
--
-- ---------------------------------------------------------------------------
-- Heal-not-wipe — why this migration uses NOT VALID
-- ---------------------------------------------------------------------------
-- Council directive: "NEVER DELETE rows." Migration 050 and migration 053
-- established the precedent — when a legacy identity row had to be retired,
-- the row was UPDATEd (state='archived', auto_resume=false), never deleted.
-- Operators recover via `genie agent unpause`; the row's identity stays
-- discoverable through the audit log and the live table.
--
-- This migration extends the same pattern. Bare-name `agents` rows that
-- survived 050/053 are recorded in `audit_events` (event_type
-- 'legacy_barename_archived', with the row's full identity columns in
-- `details` JSONB) and flipped to `state='archived' / auto_resume=false`.
-- The rows STAY in the table.
--
-- Because the rows stay, a fully-VALIDATED CHECK constraint on `agents.id`
-- would reject the table at constraint-creation time (the archived rows
-- still carry bare-name ids that the new shape rejects). The directive
-- forbids DELETE, so the only Postgres mechanism that lets us add a CHECK
-- without dropping data is `ADD CONSTRAINT ... NOT VALID`. This:
--   - enforces the predicate on every future INSERT/UPDATE (the wish's
--     goal: "no new bare-name rows can land via any spawn path");
--   - skips validation of pre-existing rows (heal-not-wipe).
--
-- Same reasoning applies to the FKs on NOT NULL carrier columns
-- (`mailbox.from_worker`, `mailbox.to_worker`, `team_chat.sender`). Pass A
-- backfills bare-name refs to UUIDs where a peer can be resolved; un-
-- resolvable orphans cannot be nulled (NOT NULL) and cannot be deleted
-- (heal-not-wipe), so the FK is added `NOT VALID`. New inserts must satisfy
-- the FK; pre-existing orphan rows are grandfathered.
--
-- For the nullable FK columns (`agents.reports_to`, `teams.leader`), Pass C
-- nulls every value that did not resolve to a real UUID/dir agent row. The
-- column is then provably clean, so the FK can be added fully VALIDATED —
-- new inserts are enforced AND every existing row passes the check.
--
-- ---------------------------------------------------------------------------
-- Operational implication — future `VALIDATE CONSTRAINT`
-- ---------------------------------------------------------------------------
-- A future `ALTER TABLE agents VALIDATE CONSTRAINT agents_id_shape_check`
-- (and the equivalent for the three NOT VALID FKs) WILL FAIL on this host
-- as long as any bare-name row remains in `agents`. That is intentional.
-- Operators who want to fully validate the constraint must first prove the
-- archived bare-name rows are non-load-bearing (no live executor anchors
-- them, no observers fetch them) and migrate them out of `agents` (e.g. to
-- a quarantine table). That work is OUT OF SCOPE for this wish and is
-- tracked separately.
--
-- Idempotent: every pass is gated on a precondition (column shape, constraint
-- presence, value pattern). Re-running the migration affects zero additional
-- rows or DDL.
--
-- See .genie/wishes/retire-session-names-id-only/WISH.md (Decisions 1, 11, 12)
-- for the full rationale.

-- ===========================================================================
-- Pass A — Backfill bare-name FK references to UUID/dir peers
-- ===========================================================================
-- For each bare-name reference, look up the canonical UUID/dir id via the
-- `(custom_name, team)` composite and rewrite the column in place. Rows that
-- don't resolve are handled in Pass C.

-- A1: agents.reports_to → resolve via (custom_name, team)
UPDATE agents a
   SET reports_to = peer.id
  FROM agents peer
 WHERE a.reports_to IS NOT NULL
   AND a.reports_to !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND a.reports_to NOT LIKE 'dir:%'
   AND peer.custom_name = a.reports_to
   AND (peer.team IS NOT DISTINCT FROM a.team)
   AND (peer.id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR peer.id LIKE 'dir:%');

-- A2: teams.leader → resolve via (custom_name, team)
UPDATE teams t
   SET leader = peer.id
  FROM agents peer
 WHERE t.leader IS NOT NULL
   AND t.leader !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND t.leader NOT LIKE 'dir:%'
   AND peer.custom_name = t.leader
   AND (peer.team IS NOT DISTINCT FROM t.name)
   AND (peer.id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR peer.id LIKE 'dir:%');

-- A3: mailbox.from_worker → resolve via custom_name (team unknown on mailbox).
-- Pick exactly one canonical peer per name (deterministic ordering — dir: rows
-- win over UUID rows so the directory entry is preferred when both exist).
UPDATE mailbox m
   SET from_worker = peer.id
  FROM agents peer
 WHERE m.from_worker IS NOT NULL
   AND m.from_worker !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND m.from_worker NOT LIKE 'dir:%'
   AND peer.custom_name = m.from_worker
   AND (peer.id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR peer.id LIKE 'dir:%')
   AND peer.id = (
     SELECT p2.id FROM agents p2
      WHERE p2.custom_name = m.from_worker
        AND (p2.id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             OR p2.id LIKE 'dir:%')
      ORDER BY (CASE WHEN p2.id LIKE 'dir:%' THEN 0 ELSE 1 END), p2.id
      LIMIT 1
   );

-- A4: mailbox.to_worker → resolve via custom_name
UPDATE mailbox m
   SET to_worker = peer.id
  FROM agents peer
 WHERE m.to_worker IS NOT NULL
   AND m.to_worker !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND m.to_worker NOT LIKE 'dir:%'
   AND peer.custom_name = m.to_worker
   AND (peer.id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR peer.id LIKE 'dir:%')
   AND peer.id = (
     SELECT p2.id FROM agents p2
      WHERE p2.custom_name = m.to_worker
        AND (p2.id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             OR p2.id LIKE 'dir:%')
      ORDER BY (CASE WHEN p2.id LIKE 'dir:%' THEN 0 ELSE 1 END), p2.id
      LIMIT 1
   );

-- A5: team_chat.sender → resolve via (custom_name, team)
UPDATE team_chat tc
   SET sender = peer.id
  FROM agents peer
 WHERE tc.sender IS NOT NULL
   AND tc.sender !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND tc.sender NOT LIKE 'dir:%'
   AND peer.custom_name = tc.sender
   AND peer.team = tc.team
   AND (peer.id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR peer.id LIKE 'dir:%');

-- A6: teams.members JSONB — rewrite each element via (custom_name, team)
UPDATE teams t
   SET members = (
     SELECT COALESCE(jsonb_agg(
       CASE
         WHEN element ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              OR element LIKE 'dir:%'
           THEN element
         ELSE COALESCE(
           (SELECT a.id FROM agents a
             WHERE a.custom_name = element
               AND a.team = t.name
               AND (a.id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    OR a.id LIKE 'dir:%')
             ORDER BY (CASE WHEN a.id LIKE 'dir:%' THEN 0 ELSE 1 END), a.id
             LIMIT 1),
           element
         )
       END
     ), '[]'::jsonb)
       FROM jsonb_array_elements_text(t.members) AS element
   )
 WHERE jsonb_typeof(t.members) = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements_text(t.members) AS e
      WHERE e !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND e NOT LIKE 'dir:%'
   );

-- ===========================================================================
-- Pass B — Audit + archive bare-name agent rows (heal-not-wipe — NO DELETE)
-- ===========================================================================
-- Bare-name violators are recorded in audit_events with their full identity
-- columns and flipped to state='archived' / auto_resume=false. The rows STAY
-- in the agents table; the CHECK constraint added in Pass F is `NOT VALID`,
-- so existing rows are grandfathered while new bare-name inserts are blocked.

WITH violators AS (
  SELECT id, role, custom_name, team, repo_path, state, auto_resume,
         started_at, reports_to, native_agent_id
    FROM agents
   WHERE id IS NOT NULL
     AND id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND id NOT LIKE 'dir:%'
)
INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details)
SELECT 'agent', v.id, 'legacy_barename_archived',
       'migration:061_agents_id_invariant_and_fk_lockdown',
       jsonb_build_object(
         'reason', 'pre_check_constraint_archive',
         'role', v.role,
         'custom_name', v.custom_name,
         'team', v.team,
         'repo_path', v.repo_path,
         'state_before', v.state,
         'auto_resume_before', v.auto_resume,
         'started_at', v.started_at,
         'reports_to', v.reports_to,
         'native_agent_id', v.native_agent_id,
         'wish', 'retire-session-names-id-only',
         'group', 1)
  FROM violators v
 WHERE NOT EXISTS (
   SELECT 1 FROM audit_events ae
    WHERE ae.entity_type = 'agent'
      AND ae.entity_id = v.id
      AND ae.event_type = 'legacy_barename_archived'
      AND ae.actor = 'migration:061_agents_id_invariant_and_fk_lockdown'
 );

-- Flip state for any not-yet-archived violators (idempotent).
UPDATE agents
   SET state = 'archived',
       auto_resume = false,
       last_state_change = now()
 WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND id NOT LIKE 'dir:%'
   AND (state IS DISTINCT FROM 'archived' OR auto_resume IS DISTINCT FROM false);

-- ===========================================================================
-- Pass C — NULL nullable refs that didn't resolve in Pass A
-- ===========================================================================
-- For nullable FK columns (reports_to, leader), set NULL when the value is
-- still bare-name OR points at a row that doesn't exist. NOT NULL columns
-- (mailbox.{from,to}_worker, team_chat.sender) are left untouched — heal-
-- not-wipe — and grandfathered by FK NOT VALID in Pass G.

-- C1a: agents.reports_to → NULL where still bare
UPDATE agents
   SET reports_to = NULL
 WHERE reports_to IS NOT NULL
   AND reports_to !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND reports_to NOT LIKE 'dir:%';

-- C1b: agents.reports_to → NULL where the referenced agent doesn't exist.
-- Without this guard, the (VALIDATED) FK on reports_to would fail.
UPDATE agents a
   SET reports_to = NULL
 WHERE a.reports_to IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM agents p WHERE p.id = a.reports_to);

-- C2a: teams.leader → NULL where still bare
UPDATE teams
   SET leader = NULL
 WHERE leader IS NOT NULL
   AND leader !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND leader NOT LIKE 'dir:%';

-- C2b: teams.leader → NULL where target row doesn't exist
UPDATE teams t
   SET leader = NULL
 WHERE t.leader IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM agents p WHERE p.id = t.leader);

-- ===========================================================================
-- Pass E — agent_templates: TEXT-PK (=name) → UUID PK + name + (name, team) UQ
-- ===========================================================================
-- Idempotent guard: only re-shape if the id column is still TEXT.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'agent_templates'
       AND column_name = 'id'
       AND data_type = 'text'
  ) THEN
    -- Add `name` and backfill from old TEXT id (which holds the name today).
    ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS name TEXT;
    UPDATE agent_templates SET name = id WHERE name IS NULL;
    -- Drop the existing TEXT primary key and the column itself.
    ALTER TABLE agent_templates DROP CONSTRAINT IF EXISTS agent_templates_pkey;
    ALTER TABLE agent_templates DROP COLUMN id;
    -- Add the new UUID id as the primary key.
    ALTER TABLE agent_templates ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid();
    ALTER TABLE agent_templates ADD PRIMARY KEY (id);
    -- name becomes the canonical human key (NOT NULL after backfill).
    ALTER TABLE agent_templates ALTER COLUMN name SET NOT NULL;
  END IF;
END $$;

-- Always ensure unique index exists (idempotent via IF NOT EXISTS).
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_templates_name_team
  ON agent_templates(name, team)
 WHERE name IS NOT NULL AND team IS NOT NULL;

-- ===========================================================================
-- Pass F — agents.id CHECK constraint (NOT VALID — grandfather legacy rows)
-- ===========================================================================
-- NOT VALID means: enforced on every INSERT/UPDATE going forward, but
-- existing rows that violate the predicate are tolerated (heal-not-wipe).
-- The wish's goal — block all new bare-name inserts — is fully met.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'agents'
       AND c.conname = 'agents_id_shape_check'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_id_shape_check
      CHECK (
        id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR id LIKE 'dir:%'
      ) NOT VALID;
  END IF;
END $$;

-- ===========================================================================
-- Pass G — Foreign key constraints
-- ===========================================================================
-- Nullable FKs (reports_to, leader) → VALIDATED, since Pass C nulled every
-- orphan / bare-name reference, the column is provably clean.
-- NOT NULL FKs (mailbox.{from,to}_worker, team_chat.sender) → NOT VALID,
-- since heal-not-wipe forbids deleting orphan carrier rows; new inserts must
-- satisfy the FK, existing rows grandfather.

-- G1: agents.reports_to → agents.id (nullable, SET NULL on delete, VALIDATED)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agents_reports_to'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT fk_agents_reports_to
      FOREIGN KEY (reports_to) REFERENCES agents(id) ON DELETE SET NULL;
  END IF;
END $$;

-- G2: teams.leader → agents.id (nullable, SET NULL on delete, VALIDATED)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_teams_leader'
  ) THEN
    ALTER TABLE teams
      ADD CONSTRAINT fk_teams_leader
      FOREIGN KEY (leader) REFERENCES agents(id) ON DELETE SET NULL;
  END IF;
END $$;

-- G3: mailbox.from_worker → agents.id (NOT NULL, CASCADE on delete, NOT VALID)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_mailbox_from_worker'
  ) THEN
    ALTER TABLE mailbox
      ADD CONSTRAINT fk_mailbox_from_worker
      FOREIGN KEY (from_worker) REFERENCES agents(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

-- G4: mailbox.to_worker → agents.id (NOT NULL, CASCADE on delete, NOT VALID)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_mailbox_to_worker'
  ) THEN
    ALTER TABLE mailbox
      ADD CONSTRAINT fk_mailbox_to_worker
      FOREIGN KEY (to_worker) REFERENCES agents(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

-- G5: team_chat.sender → agents.id (NOT NULL, CASCADE on delete, NOT VALID)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_team_chat_sender'
  ) THEN
    ALTER TABLE team_chat
      ADD CONSTRAINT fk_team_chat_sender
      FOREIGN KEY (sender) REFERENCES agents(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

-- ===========================================================================
-- Pass H — teams.members UUID-array CHECK (NOT VALID)
-- ===========================================================================
-- Subqueries are not allowed inside CHECK predicates, so wrap the validation
-- in an IMMUTABLE SQL function. The function rejects any element that isn't
-- UUID-shaped or `dir:<name>`-shaped. NULL is permitted. NOT VALID grand-
-- fathers any pre-existing teams that still carry bare-name members; new
-- inserts/updates must comply.

CREATE OR REPLACE FUNCTION migration_061_teams_members_valid(m jsonb)
RETURNS boolean AS $$
  -- CASE forces strict short-circuit so jsonb_array_elements_text never runs
  -- on a non-array input. Plain `AND` cannot be relied upon — Postgres'
  -- planner sometimes evaluates both operands.
  SELECT CASE
    WHEN m IS NULL THEN true
    WHEN jsonb_typeof(m) <> 'array' THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(m) AS e
       WHERE e !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         AND e NOT LIKE 'dir:%'
    )
  END;
$$ LANGUAGE sql IMMUTABLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'teams_members_uuid_check'
  ) THEN
    ALTER TABLE teams
      ADD CONSTRAINT teams_members_uuid_check
      CHECK (migration_061_teams_members_valid(members)) NOT VALID;
  END IF;
END $$;
