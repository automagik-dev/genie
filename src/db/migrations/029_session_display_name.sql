-- Add display_name and claude_session_id columns to sessions
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS claude_session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_claude_session_id ON sessions(claude_session_id) WHERE claude_session_id IS NOT NULL;
