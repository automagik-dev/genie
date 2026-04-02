-- 006_fix_agents_schema.sql — Reconcile agents/agent_templates schema
-- Fixes: tables created by seed with old schema before 005_pg_state migration.
-- The seed used text[] for sub_panes/extra_args and missed tmux_window, pane_color, updated_at.
-- This migration ensures the schema matches 005_pg_state regardless of creation order.

-- ============================================================================
-- agents table — add missing columns, fix column types
-- ============================================================================

-- Columns that may not exist if table was created by pre-005 seed
ALTER TABLE agents ADD COLUMN IF NOT EXISTS tmux_window TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS pane_color TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

-- sub_panes: seed created as text[], code expects jsonb
-- Safe migration: convert existing text[] data to jsonb, set correct default
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agents' AND column_name = 'sub_panes' AND data_type = 'ARRAY'
  ) THEN
    ALTER TABLE agents ALTER COLUMN sub_panes DROP DEFAULT;
    ALTER TABLE agents ALTER COLUMN sub_panes TYPE jsonb
      USING COALESCE(array_to_json(sub_panes)::jsonb, '[]'::jsonb);
    ALTER TABLE agents ALTER COLUMN sub_panes SET DEFAULT '[]'::jsonb;
  END IF;
END $$;

-- ============================================================================
-- agent_templates table — fix column types
-- ============================================================================

-- extra_args: seed created as text[], code expects jsonb
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agent_templates' AND column_name = 'extra_args' AND data_type = 'ARRAY'
  ) THEN
    ALTER TABLE agent_templates ALTER COLUMN extra_args DROP DEFAULT;
    ALTER TABLE agent_templates ALTER COLUMN extra_args TYPE jsonb
      USING COALESCE(array_to_json(extra_args)::jsonb, '[]'::jsonb);
    ALTER TABLE agent_templates ALTER COLUMN extra_args SET DEFAULT '[]'::jsonb;
  END IF;
END $$;

-- Add missing timestamp columns to agent_templates
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- ============================================================================
-- Ensure update triggers exist (idempotent CREATE OR REPLACE)
-- ============================================================================
CREATE OR REPLACE FUNCTION update_agents_timestamp()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop and re-create triggers (idempotent)
DROP TRIGGER IF EXISTS trg_agents_updated_at ON agents;
CREATE TRIGGER trg_agents_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION update_agents_timestamp();

DROP TRIGGER IF EXISTS trg_agent_templates_updated_at ON agent_templates;
CREATE TRIGGER trg_agent_templates_updated_at
  BEFORE UPDATE ON agent_templates
  FOR EACH ROW EXECUTE FUNCTION update_agents_timestamp();
