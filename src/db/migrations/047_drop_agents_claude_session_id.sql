-- 047_drop_agents_claude_session_id.sql
--
-- Group 7 of the claude-resume-by-session-id wish.
--
-- Identity (agents) no longer owns a session — sessions belong to runs
-- (executors). The canonical session UUID lives on `executors.claude_session_id`
-- and is read via `getResumeSessionId(agentId)`, which joins
-- `agents.current_executor_id → executors.claude_session_id`.
--
-- See .genie/wishes/claude-resume-by-session-id/WISH.md for the full decision log.

ALTER TABLE agents DROP COLUMN IF EXISTS claude_session_id;
