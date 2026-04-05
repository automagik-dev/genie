-- 026_events_trace_id.sql — Add trace_id and parent_event_id for distributed tracing (#859)

ALTER TABLE genie_runtime_events ADD COLUMN IF NOT EXISTS trace_id UUID;
ALTER TABLE genie_runtime_events ADD COLUMN IF NOT EXISTS parent_event_id BIGINT REFERENCES genie_runtime_events(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_runtime_events_trace_id ON genie_runtime_events(trace_id) WHERE trace_id IS NOT NULL;
