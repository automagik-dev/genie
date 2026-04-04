-- 025_sdk_metadata_index.sql — GIN index on metadata->'sdk' for efficient SDK-specific queries.
-- Enables fast lookups of agents by SDK configuration fields
-- (e.g. WHERE metadata->'sdk' @> '{"permissionMode":"acceptEdits"}').

CREATE INDEX IF NOT EXISTS idx_agents_metadata_sdk
ON agents USING GIN ((metadata->'sdk'))
WHERE metadata->'sdk' IS NOT NULL;
