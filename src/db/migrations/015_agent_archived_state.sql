-- 015_agent_archived_state.sql — Add 'archived' to agent state enum
--
-- Archived agents keep their statistics and history intact but don't show up
-- in active listings. The pattern is reusable for other entities (tasks,
-- projects, teams, boards) in future migrations.
--
-- Also adds 'archived' to the app_store approval_status enum so directory
-- entries can be archived without deletion.

-- ============================================================================
-- Agents table: add 'archived' to state CHECK constraint
-- ============================================================================

-- Drop the existing CHECK constraint on state (named or inline)
DO $$
BEGIN
  -- Try dropping by known constraint name patterns
  EXECUTE (
    SELECT string_agg('ALTER TABLE agents DROP CONSTRAINT ' || quote_ident(conname), '; ')
    FROM pg_constraint
    WHERE conrelid = 'agents'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%state%'
  );
EXCEPTION WHEN OTHERS THEN
  NULL; -- constraint may not exist or already dropped
END $$;

-- Re-add CHECK with 'archived' included
ALTER TABLE agents ADD CONSTRAINT agents_state_check
  CHECK (state IS NULL OR state IN (
    'spawning', 'working', 'idle', 'permission', 'question',
    'done', 'error', 'suspended', 'archived'
  ));

-- ============================================================================
-- App store: add 'archived' to approval_status CHECK constraint
-- ============================================================================

DO $$
BEGIN
  EXECUTE (
    SELECT string_agg('ALTER TABLE app_store DROP CONSTRAINT ' || quote_ident(conname), '; ')
    FROM pg_constraint
    WHERE conrelid = 'app_store'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%approval_status%'
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

ALTER TABLE app_store ADD CONSTRAINT app_store_approval_status_check
  CHECK (approval_status IN ('local', 'pending', 'approved', 'rejected', 'archived'));

-- ============================================================================
-- Index: fast lookup for non-archived agents in directory listings
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_agents_not_archived
  ON agents(state) WHERE state != 'archived';
