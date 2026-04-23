-- 039_runtime_events_siblings.sql — debug + audit sibling tables
-- Wish: genie-serve-structured-observability (Group 1).
--
-- Two sibling tables alongside genie_runtime_events:
--   * genie_runtime_events_debug — high-churn, 24h TTL, truncatable. Home for
--     command_success events (91.7% of current volume) after Group 3 demotion.
--   * genie_runtime_events_audit — append-only WORM with HMAC-chain tamper
--     evidence. UPDATE/DELETE revoked at role level in migration 041_rbac_roles.
--
-- Schema is intentionally a superset of the partitioned parent: same columns
-- so the emitter (Group 2) can write to the appropriate sibling by tier
-- without reshaping the payload.

-- ---------------------------------------------------------------------------
-- 1. genie_runtime_events_debug — short-TTL noise sink
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS genie_runtime_events_debug (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo_path TEXT NOT NULL,
  subject TEXT,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  agent TEXT NOT NULL,
  team TEXT,
  direction TEXT CHECK (direction IN ('in', 'out')),
  peer TEXT,
  text TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  thread_id TEXT,
  trace_id UUID,
  parent_event_id BIGINT,
  span_id UUID,
  parent_span_id UUID,
  severity TEXT CHECK (severity IS NULL OR severity IN ('debug', 'info', 'warn', 'error', 'fatal')),
  schema_version INTEGER,
  duration_ms INTEGER,
  dedup_key TEXT,
  source_subsystem TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runtime_events_debug_created ON genie_runtime_events_debug(created_at);
CREATE INDEX IF NOT EXISTS idx_runtime_events_debug_kind_id ON genie_runtime_events_debug(kind, id);
CREATE INDEX IF NOT EXISTS idx_runtime_events_debug_trace_id
  ON genie_runtime_events_debug(trace_id)
  WHERE trace_id IS NOT NULL;

-- Retention helper: truncate rows older than 24h. Invoked by scheduler-daemon.
-- TRUNCATE is not safe on a heavily-read sibling; DELETE keeps reads consistent.
CREATE OR REPLACE FUNCTION genie_runtime_events_debug_retention()
RETURNS INTEGER AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM genie_runtime_events_debug
   WHERE created_at < now() - interval '24 hours';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 2. genie_runtime_events_audit — append-only WORM with HMAC chain
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS genie_runtime_events_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo_path TEXT NOT NULL,
  subject TEXT,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  agent TEXT NOT NULL,
  team TEXT,
  direction TEXT CHECK (direction IN ('in', 'out')),
  peer TEXT,
  text TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  thread_id TEXT,
  trace_id UUID,
  parent_event_id BIGINT,
  span_id UUID,
  parent_span_id UUID,
  severity TEXT CHECK (severity IS NULL OR severity IN ('debug', 'info', 'warn', 'error', 'fatal')),
  schema_version INTEGER,
  duration_ms INTEGER,
  dedup_key TEXT,
  source_subsystem TEXT,
  -- HMAC chain columns — populated by the trigger below. chain_hash is
  -- deterministic per row: hmac(prior_hash || row_digest, key-version).
  chain_hash BYTEA,
  chain_key_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runtime_events_audit_created ON genie_runtime_events_audit(created_at);
CREATE INDEX IF NOT EXISTS idx_runtime_events_audit_kind_id ON genie_runtime_events_audit(kind, id);
CREATE INDEX IF NOT EXISTS idx_runtime_events_audit_trace_id
  ON genie_runtime_events_audit(trace_id)
  WHERE trace_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. HMAC-chain trigger
-- ---------------------------------------------------------------------------
-- We defer the actual HMAC key to a GUC (`app.audit_hmac_key`) that Group 5
-- sets from the events_admin role at session start. Rows written before the
-- GUC is configured receive an all-zero chain so chain continuity still holds
-- across upgrades; Group 5 rotates keys and bumps chain_key_version.
CREATE OR REPLACE FUNCTION audit_events_chain_hash()
RETURNS trigger AS $$
DECLARE
  prior_hash BYTEA;
  row_digest BYTEA;
  hmac_key   TEXT := current_setting('app.audit_hmac_key', TRUE);
BEGIN
  -- If the chain is being forged (NEW.chain_hash already set), reject.
  IF NEW.chain_hash IS NOT NULL THEN
    RAISE EXCEPTION 'audit chain_hash is server-computed and must not be supplied by the writer';
  END IF;

  SELECT chain_hash
    INTO prior_hash
    FROM genie_runtime_events_audit
   ORDER BY id DESC
   LIMIT 1;

  IF prior_hash IS NULL THEN
    prior_hash := decode(repeat('00', 32), 'hex');
  END IF;

  row_digest := digest(
    coalesce(NEW.kind, '') || '|' ||
    coalesce(NEW.agent, '') || '|' ||
    coalesce(NEW.text, '') || '|' ||
    coalesce(NEW.data::TEXT, '{}') || '|' ||
    coalesce(NEW.trace_id::TEXT, '') || '|' ||
    coalesce(NEW.span_id::TEXT, '') || '|' ||
    coalesce(NEW.severity, '') || '|' ||
    coalesce(NEW.created_at::TEXT, now()::TEXT),
    'sha256'
  );

  IF hmac_key IS NULL OR length(hmac_key) = 0 THEN
    -- No key configured (dev/test) — deterministic SHA256 chain, unsigned.
    NEW.chain_hash := digest(prior_hash || row_digest, 'sha256');
  ELSE
    NEW.chain_hash := hmac(prior_hash || row_digest, hmac_key::BYTEA, 'sha256');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- pgcrypto supplies digest() / hmac(). Ensure it's available; idempotent.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DROP TRIGGER IF EXISTS trg_audit_events_chain ON genie_runtime_events_audit;

CREATE TRIGGER trg_audit_events_chain
  BEFORE INSERT ON genie_runtime_events_audit
  FOR EACH ROW EXECUTE FUNCTION audit_events_chain_hash();

-- ---------------------------------------------------------------------------
-- 4. WORM enforcement — prevent UPDATE/DELETE at the trigger level.
-- Migration 041 (Group 5) additionally enforces this via role GRANTs; the
-- trigger is defense-in-depth in case a misconfigured role slips through.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_events_worm_guard()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'genie_runtime_events_audit is append-only (WORM) — % denied', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_events_worm_update ON genie_runtime_events_audit;
CREATE TRIGGER trg_audit_events_worm_update
  BEFORE UPDATE ON genie_runtime_events_audit
  FOR EACH ROW EXECUTE FUNCTION audit_events_worm_guard();

DROP TRIGGER IF EXISTS trg_audit_events_worm_delete ON genie_runtime_events_audit;
CREATE TRIGGER trg_audit_events_worm_delete
  BEFORE DELETE ON genie_runtime_events_audit
  FOR EACH ROW EXECUTE FUNCTION audit_events_worm_guard();
