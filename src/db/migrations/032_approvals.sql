-- 032_approvals.sql — Remote approval queue for human-in-the-loop tool gating
--
-- Stores pending/resolved approval requests. Agents block on tool use until
-- a human approves or denies via Omni (WhatsApp), the desktop app, or CLI.
-- PG LISTEN/NOTIFY enables sub-second resolution delivery.

-- ============================================================================
-- Approvals table
-- ============================================================================
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  executor_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input_preview TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL DEFAULT 'pending'
    CHECK (decision IN ('pending', 'allow', 'deny')),
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  timeout_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approvals_pending
  ON approvals(decision, created_at)
  WHERE decision = 'pending';

CREATE INDEX IF NOT EXISTS idx_approvals_executor
  ON approvals(executor_id);

CREATE INDEX IF NOT EXISTS idx_approvals_agent
  ON approvals(agent_name);

-- ============================================================================
-- LISTEN/NOTIFY trigger — fires when decision changes from 'pending'
-- ============================================================================
CREATE OR REPLACE FUNCTION notify_approval_resolved()
RETURNS trigger AS $$
BEGIN
  IF OLD.decision = 'pending' AND NEW.decision != 'pending' THEN
    PERFORM pg_notify('genie_approval_resolved', NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_approval_resolved ON approvals;

CREATE TRIGGER trg_notify_approval_resolved
  AFTER UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION notify_approval_resolved();
