-- 029_omni_requests.sql — PG-backed request queue for SDK executor (zero message loss)

CREATE TABLE IF NOT EXISTS omni_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent         TEXT NOT NULL,
  chat_id       TEXT NOT NULL,
  instance_id   TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL,
  sender        TEXT NOT NULL DEFAULT '',
  env           JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  next_retry_at TIMESTAMPTZ
);

-- Worker poll: claim oldest pending, skip locked rows
CREATE INDEX IF NOT EXISTS idx_omni_requests_pending
  ON omni_requests (created_at ASC)
  WHERE status = 'pending';

-- Recovery: find processing rows that may be stale after restart
CREATE INDEX IF NOT EXISTS idx_omni_requests_processing
  ON omni_requests (started_at ASC)
  WHERE status = 'processing';

-- Rate limiting: count recent completions per agent
CREATE INDEX IF NOT EXISTS idx_omni_requests_agent_completed
  ON omni_requests (agent, completed_at DESC)
  WHERE status = 'done';
