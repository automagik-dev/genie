-- Partial index for omni-sourced executor lookups.
-- Covers: findLatestByMetadata in executor-registry (lazy resume),
--         bridge's find-or-create on inbound NATS message,
--         genie ls --source omni / genie sessions list --source omni.
CREATE INDEX IF NOT EXISTS executors_omni_lookup
  ON executors (
    agent_id,
    (metadata->>'source'),
    (metadata->>'chat_id')
  )
  WHERE ended_at IS NULL;
