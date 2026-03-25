-- 009_app_store.sql — Item registry: app_store, installed_apps, app_versions
-- Unified item registry for agents, skills, apps, boards, workflows, stacks, templates, hooks.

-- ============================================================================
-- Table: app_store — Central item registry (source of truth)
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_store (
  id TEXT PRIMARY KEY DEFAULT 'item-' || substr(gen_random_uuid()::text, 1, 8),
  name TEXT UNIQUE NOT NULL,
  item_type TEXT NOT NULL
    CHECK (item_type IN ('agent', 'skill', 'app', 'board', 'workflow', 'stack', 'template', 'hook')),
  version TEXT NOT NULL DEFAULT '0.0.0',
  description TEXT,
  author_name TEXT,
  author_url TEXT,
  git_url TEXT,
  install_path TEXT,
  manifest JSONB NOT NULL DEFAULT '{}',
  approval_status TEXT NOT NULL DEFAULT 'local'
    CHECK (approval_status IN ('local', 'pending', 'approved', 'rejected')),
  tags TEXT[] DEFAULT '{}',
  category TEXT,
  license TEXT,
  dependencies TEXT[] DEFAULT '{}',
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_store_type ON app_store(item_type);
CREATE INDEX IF NOT EXISTS idx_app_store_status ON app_store(approval_status);
CREATE INDEX IF NOT EXISTS idx_app_store_name ON app_store(name);

-- ============================================================================
-- Table: installed_apps — Runtime install state (tracks what's active)
-- ============================================================================
CREATE TABLE IF NOT EXISTS installed_apps (
  id TEXT PRIMARY KEY DEFAULT 'inst-' || substr(gen_random_uuid()::text, 1, 8),
  app_store_id TEXT NOT NULL REFERENCES app_store(id) ON DELETE CASCADE,
  install_path TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  config JSONB DEFAULT '{}',
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(app_store_id)
);

CREATE INDEX IF NOT EXISTS idx_installed_apps_store ON installed_apps(app_store_id);
CREATE INDEX IF NOT EXISTS idx_installed_apps_active ON installed_apps(is_active) WHERE is_active = true;

-- ============================================================================
-- Table: app_versions — Version history for published items
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_versions (
  id TEXT PRIMARY KEY DEFAULT 'ver-' || substr(gen_random_uuid()::text, 1, 8),
  app_store_id TEXT NOT NULL REFERENCES app_store(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  git_tag TEXT,
  git_sha TEXT,
  manifest JSONB NOT NULL DEFAULT '{}',
  changelog TEXT,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(app_store_id, version)
);

CREATE INDEX IF NOT EXISTS idx_app_versions_store ON app_versions(app_store_id);
