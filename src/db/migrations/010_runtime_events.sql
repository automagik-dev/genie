-- 010_runtime_events.sql — PG-first runtime event log
-- Append-only event stream for hooks, mailbox, scheduler, QA, and follow mode.

CREATE TABLE IF NOT EXISTS genie_runtime_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo_path TEXT NOT NULL,
  subject TEXT,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  agent TEXT NOT NULL,
  team TEXT,
  direction TEXT CHECK (direction IN ('in', 'out')),
  peer TEXT,
  text TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runtime_events_created ON genie_runtime_events(created_at);
CREATE INDEX IF NOT EXISTS idx_runtime_events_repo_id ON genie_runtime_events(repo_path, id);
CREATE INDEX IF NOT EXISTS idx_runtime_events_agent_id ON genie_runtime_events(agent, id);
CREATE INDEX IF NOT EXISTS idx_runtime_events_team_id ON genie_runtime_events(team, id);
CREATE INDEX IF NOT EXISTS idx_runtime_events_subject_id ON genie_runtime_events(subject, id);
CREATE INDEX IF NOT EXISTS idx_runtime_events_kind_id ON genie_runtime_events(kind, id);

CREATE OR REPLACE FUNCTION notify_runtime_event()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('genie_runtime_event', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_runtime_event ON genie_runtime_events;

CREATE TRIGGER trg_notify_runtime_event
  AFTER INSERT ON genie_runtime_events
  FOR EACH ROW EXECUTE FUNCTION notify_runtime_event();
