-- 020_agent_metadata.sql — Add metadata JSONB column to agents table
-- Stores frontmatter fields from AGENTS.md: model, promptMode, color, description, provider, dir, repo.
-- Enables directory.edit() persistence and frontmatter sync from AGENTS.md.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- GIN index for JSONB containment queries (e.g. WHERE metadata @> '{"provider":"codex"}')
CREATE INDEX IF NOT EXISTS idx_agents_metadata ON agents USING gin (metadata);
