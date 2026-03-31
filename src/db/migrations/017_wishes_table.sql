-- 017: Wishes table — filesystem wish index for cross-repo querying.
-- Synced from .genie/wishes/*/WISH.md files in each repo.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS wishes (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL,
  repo TEXT NOT NULL,
  namespace TEXT,
  status TEXT DEFAULT 'DRAFT',
  file_path TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(slug, repo)
);

CREATE INDEX IF NOT EXISTS idx_wishes_status ON wishes(status);
CREATE INDEX IF NOT EXISTS idx_wishes_namespace ON wishes(namespace) WHERE namespace IS NOT NULL;
