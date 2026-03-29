-- 014_comms_protocol.sql — Communication protocol: agent requests, activity threading, event subscriptions
-- Creates: agent_requests (typed agent→human requests)
-- Extends: genie_runtime_events (thread_id for per-agent/task/team feeds)
-- Extends: teams (event_subscriptions JSONB for configurable routing)

-- ============================================================================
-- 1. Activity Threading — thread_id on runtime events
-- ============================================================================

ALTER TABLE genie_runtime_events ADD COLUMN IF NOT EXISTS thread_id TEXT;

-- Backfill existing rows: default thread_id = 'agent:<agent>'
UPDATE genie_runtime_events SET thread_id = 'agent:' || agent WHERE thread_id IS NULL;

-- Index for fast thread-scoped queries
CREATE INDEX IF NOT EXISTS idx_runtime_events_thread ON genie_runtime_events(thread_id, id);

-- ============================================================================
-- 2. Request columns on messages table (replaces agent_requests table)
-- ============================================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS request_type TEXT CHECK (request_type IN ('env', 'confirm', 'choice', 'approve', 'input'));
ALTER TABLE messages ADD COLUMN IF NOT EXISTS request_status TEXT CHECK (request_status IN ('pending', 'resolved', 'rejected', 'expired'));
CREATE INDEX IF NOT EXISTS idx_messages_request_status ON messages(request_status) WHERE request_status IS NOT NULL;

-- ============================================================================
-- 3. Trace ID on mailbox for event correlation
-- ============================================================================

ALTER TABLE mailbox ADD COLUMN IF NOT EXISTS trace_id TEXT;
CREATE INDEX IF NOT EXISTS idx_mailbox_trace_id ON mailbox(trace_id) WHERE trace_id IS NOT NULL;
