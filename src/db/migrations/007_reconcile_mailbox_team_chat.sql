-- 007_reconcile_mailbox_team_chat.sql — Fix production schema drift
--
-- Problem: 005_pg_state was recorded as applied but partially failed because
-- the mailbox table already existed (from 002_task_lifecycle with column
-- "is_read" instead of "read"). The team_chat table was never created.
--
-- This migration:
--   1. Renames mailbox.is_read → read (matching code expectations)
--   2. Recreates indexes to match 005_pg_state naming
--   3. Creates team_chat table IF NOT EXISTS
--   4. Adds missing LISTEN/NOTIFY triggers from 005_pg_state

-- ============================================================================
-- Fix 1: mailbox.is_read → mailbox.read
-- ============================================================================

-- Rename column if the old name exists (idempotent: no-op if already "read")
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'mailbox'
      AND column_name = 'is_read'
  ) THEN
    ALTER TABLE mailbox RENAME COLUMN is_read TO read;
  END IF;
END $$;

-- Ensure NOT NULL DEFAULT false (may differ from original)
ALTER TABLE mailbox ALTER COLUMN read SET NOT NULL;
ALTER TABLE mailbox ALTER COLUMN read SET DEFAULT false;

-- ============================================================================
-- Fix 2: Reconcile mailbox indexes to match 005_pg_state expectations
-- ============================================================================

-- Drop old-named indexes (from pre-005 migration) if they exist
DROP INDEX IF EXISTS idx_mailbox_to_unread;
DROP INDEX IF EXISTS idx_mailbox_to_repo;
DROP INDEX IF EXISTS idx_mailbox_from;

-- Create indexes with 005_pg_state naming (idempotent via IF NOT EXISTS)
CREATE INDEX IF NOT EXISTS idx_mailbox_to_worker_read ON mailbox(to_worker, read);
CREATE INDEX IF NOT EXISTS idx_mailbox_repo_path ON mailbox(repo_path);
CREATE INDEX IF NOT EXISTS idx_mailbox_from_worker ON mailbox(from_worker);
CREATE INDEX IF NOT EXISTS idx_mailbox_created ON mailbox(created_at DESC);

-- ============================================================================
-- Fix 3: Create team_chat table (was never created due to 005 partial failure)
-- ============================================================================

CREATE TABLE IF NOT EXISTS team_chat (
  id TEXT PRIMARY KEY,
  team TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_chat_team_repo ON team_chat(team, repo_path);
CREATE INDEX IF NOT EXISTS idx_team_chat_created ON team_chat(team, repo_path, created_at);

-- ============================================================================
-- Fix 4: Ensure LISTEN/NOTIFY triggers from 005_pg_state exist
-- ============================================================================

-- Notify on new mailbox messages (instant delivery)
CREATE OR REPLACE FUNCTION notify_mailbox_insert()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('genie_mailbox_delivery', NEW.to_worker || ':' || NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop old trigger name if it exists, create with 005_pg_state name
DROP TRIGGER IF EXISTS trg_mailbox_delivery ON mailbox;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_mailbox'
  ) THEN
    CREATE TRIGGER trg_notify_mailbox
      AFTER INSERT ON mailbox
      FOR EACH ROW EXECUTE FUNCTION notify_mailbox_insert();
  END IF;
END $$;

-- Notify on agent state changes (idempotent — CREATE OR REPLACE)
CREATE OR REPLACE FUNCTION notify_agent_state_change()
RETURNS trigger AS $$
BEGIN
  IF OLD.state IS DISTINCT FROM NEW.state THEN
    PERFORM pg_notify('genie_agent_state', NEW.id || ':' || COALESCE(OLD.state, '') || ':' || NEW.state);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger only if not exists (agents trigger may already be correct)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_agent_state'
  ) THEN
    CREATE TRIGGER trg_notify_agent_state
      AFTER UPDATE OF state ON agents
      FOR EACH ROW EXECUTE FUNCTION notify_agent_state_change();
  END IF;
END $$;

-- Auto-update updated_at timestamps
CREATE OR REPLACE FUNCTION update_agents_timestamp()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
