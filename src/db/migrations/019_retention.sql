-- 019_retention.sql — Activate retention policies for unbounded tables
-- These DELETEs run once as a migration to clean existing data,
-- and are also executed on every process startup via getConnection().

-- Heartbeats: 7-day retention
DELETE FROM heartbeats WHERE created_at < now() - interval '7 days';

-- Machine snapshots: 30-day retention
DELETE FROM machine_snapshots WHERE created_at < now() - interval '30 days';

-- Audit events (otel-prefixed): 30-day retention
DELETE FROM audit_events WHERE entity_type LIKE 'otel_%' AND created_at < now() - interval '30 days';

-- Runtime events: 14-day retention
DELETE FROM genie_runtime_events WHERE created_at < now() - interval '14 days';
