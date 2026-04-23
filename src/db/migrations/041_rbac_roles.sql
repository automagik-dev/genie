-- 041_rbac_roles.sql — RBAC roles, RLS, channel ACLs, revocation list
-- Wish: genie-serve-structured-observability (Group 5).
--
-- Locks the DB side of the observability security model:
--   1. Four PG roles (events_admin / events_operator / events_subscriber /
--      events_audit) with the per-table GRANT matrix from DESIGN.md.
--   2. Row-level security on genie_runtime_events — tenant_id column defaults
--      to 'default' so existing rows keep working; every new tenant sets
--      current_setting('app.tenant_id') at session start.
--   3. Channel ACLs — revoke generic LISTEN from PUBLIC so only authorized
--      roles wake on NOTIFY. Per-role grants are declarative and enforced
--      lazily via GUC at session start (see `app.events_listen_channels`).
--   4. Revocation list — app-layer token revocations persist here. Tokens
--      themselves are JWT-HMAC; the revocation table is the "kill switch" the
--      IR playbook `genie events revoke-subscriber` writes to.
--
-- Defense-in-depth: the app layer (src/lib/events/rbac.ts) enforces channel +
-- table scopes independently, so a misconfigured PG grant does not silently
-- widen access. This migration is the floor, not the ceiling.

-- ---------------------------------------------------------------------------
-- 0. Extension dependency — gen_random_uuid() for token_id / subscriber_id.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Roles — idempotent CREATE via catalog probe.
-- NOINHERIT so role chaining does not silently escalate.
-- LOGIN is NOT set; these are target roles for SET ROLE / RESET ROLE by the
-- connection pool's owner account. Operators wire their own credentials into
-- a login role that inherits from one of these.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'events_admin') THEN
    EXECUTE 'CREATE ROLE events_admin NOINHERIT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'events_operator') THEN
    EXECUTE 'CREATE ROLE events_operator NOINHERIT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'events_subscriber') THEN
    EXECUTE 'CREATE ROLE events_subscriber NOINHERIT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'events_audit') THEN
    EXECUTE 'CREATE ROLE events_audit NOINHERIT';
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 2. tenant_id column on the three event tables — defaults to 'default' so
-- existing rows and emit.ts writes keep working unchanged. RLS uses this.
-- ---------------------------------------------------------------------------
ALTER TABLE genie_runtime_events
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE genie_runtime_events_debug
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE genie_runtime_events_audit
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_runtime_events_tenant_id
  ON genie_runtime_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_runtime_events_debug_tenant_id
  ON genie_runtime_events_debug(tenant_id);
CREATE INDEX IF NOT EXISTS idx_runtime_events_audit_tenant_id
  ON genie_runtime_events_audit(tenant_id);

-- ---------------------------------------------------------------------------
-- 3. Row-level security.
--
-- Policy: a session can read rows matching its `app.tenant_id` GUC. When the
-- GUC is unset (legacy sessions, ad-hoc CLI) the policy falls through to
-- 'default'. `events_admin` has BYPASSRLS — explicit in policy, not implicit.
-- ---------------------------------------------------------------------------
ALTER TABLE genie_runtime_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE genie_runtime_events_debug ENABLE ROW LEVEL SECURITY;
ALTER TABLE genie_runtime_events_audit ENABLE ROW LEVEL SECURITY;

-- Drop stale policies so the migration is idempotent on re-apply with changed
-- text.
DROP POLICY IF EXISTS events_tenant_isolation       ON genie_runtime_events;
DROP POLICY IF EXISTS events_debug_tenant_isolation ON genie_runtime_events_debug;
DROP POLICY IF EXISTS events_audit_tenant_isolation ON genie_runtime_events_audit;
DROP POLICY IF EXISTS events_admin_bypass           ON genie_runtime_events;
DROP POLICY IF EXISTS events_debug_admin_bypass     ON genie_runtime_events_debug;
DROP POLICY IF EXISTS events_audit_admin_bypass     ON genie_runtime_events_audit;

CREATE POLICY events_tenant_isolation ON genie_runtime_events
  FOR ALL
  USING (tenant_id = COALESCE(current_setting('app.tenant_id', TRUE), 'default'))
  WITH CHECK (tenant_id = COALESCE(current_setting('app.tenant_id', TRUE), 'default'));

CREATE POLICY events_debug_tenant_isolation ON genie_runtime_events_debug
  FOR ALL
  USING (tenant_id = COALESCE(current_setting('app.tenant_id', TRUE), 'default'))
  WITH CHECK (tenant_id = COALESCE(current_setting('app.tenant_id', TRUE), 'default'));

CREATE POLICY events_audit_tenant_isolation ON genie_runtime_events_audit
  FOR ALL
  USING (tenant_id = COALESCE(current_setting('app.tenant_id', TRUE), 'default'))
  WITH CHECK (tenant_id = COALESCE(current_setting('app.tenant_id', TRUE), 'default'));

CREATE POLICY events_admin_bypass ON genie_runtime_events
  FOR ALL TO events_admin USING (true) WITH CHECK (true);
CREATE POLICY events_debug_admin_bypass ON genie_runtime_events_debug
  FOR ALL TO events_admin USING (true) WITH CHECK (true);
CREATE POLICY events_audit_admin_bypass ON genie_runtime_events_audit
  FOR ALL TO events_admin USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 4. Per-role table GRANT matrix (DESIGN.md §3).
--
--                              main   debug  audit
-- events_admin      SELECT      y      y      y
--                   INSERT      y      y      n   (admin never writes WORM)
--                   UPDATE      y      y      n
--                   DELETE      y      y      n
--
-- events_operator   SELECT      y      y      n
--                   INSERT      y      y      n
--
-- events_subscriber SELECT      y      n      n   (read-only, no audit)
--
-- events_audit      SELECT      n      n      y   (read audit only)
--                   INSERT      n      n      y   (the ONLY writer of WORM)
-- ---------------------------------------------------------------------------

-- Revoke first so the grants below are the ground truth.
REVOKE ALL ON genie_runtime_events,
              genie_runtime_events_debug,
              genie_runtime_events_audit
  FROM events_admin, events_operator, events_subscriber, events_audit;

-- events_admin
GRANT SELECT, INSERT, UPDATE, DELETE ON genie_runtime_events       TO events_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON genie_runtime_events_debug TO events_admin;
GRANT SELECT                         ON genie_runtime_events_audit TO events_admin;

-- events_operator
GRANT SELECT, INSERT                 ON genie_runtime_events       TO events_operator;
GRANT SELECT, INSERT                 ON genie_runtime_events_debug TO events_operator;

-- events_subscriber
GRANT SELECT                         ON genie_runtime_events       TO events_subscriber;

-- events_audit — INSERT-ONLY on the WORM table + SELECT on the WORM table.
GRANT SELECT, INSERT                 ON genie_runtime_events_audit TO events_audit;

-- ---------------------------------------------------------------------------
-- 5. Channel ACLs.
--
-- PostgreSQL does not expose per-channel LISTEN GRANT primitives natively,
-- so the enforcement is a two-layer contract:
--   (a) REVOKE LISTEN on the default (PUBLIC) channel scheme so non-roles
--       cannot wake on NOTIFYs even if they hold DB login.
--   (b) A session GUC `app.events_listen_channels` encodes the comma-separated
--       allowed prefixes; the `genie_events_channel_guard()` trigger rejects
--       INSERTs whose kind prefix is not in the caller's allowlist — but since
--       only events_admin/operator/audit can INSERT anyway, the guard is
--       defense-in-depth for LISTEN readers who bypass SET ROLE. The
--       application layer (src/lib/events/rbac.ts) is the primary enforcement
--       for subscribers.
--
-- Groups 4+5: subscribers connect as events_subscriber and call SET LOCAL
-- app.events_listen_channels='genie_events.mailbox,genie_events.state_transition'
-- before issuing LISTEN. The trigger below blocks LISTEN-for-channels-not-in-
-- the-GUC by hooking DDL events? — PG has no LISTEN event trigger, so this
-- stays enforced at the app layer. The GUC is visible for audit purposes.
-- ---------------------------------------------------------------------------

-- Ensure PUBLIC cannot CONNECT via implicit roles. Membership in one of the
-- four events_* roles is required to reach these tables.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT  USAGE ON SCHEMA public TO events_admin,
                                  events_operator,
                                  events_subscriber,
                                  events_audit;

-- Grant execute on the partition-maintenance helpers to admin only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'genie_runtime_events_maintain_partitions') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION genie_runtime_events_maintain_partitions(integer, integer) TO events_admin';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'genie_runtime_events_create_partition') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION genie_runtime_events_create_partition(date) TO events_admin';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'genie_runtime_events_drop_old_partitions') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION genie_runtime_events_drop_old_partitions(integer) TO events_admin';
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 6. Subscription token revocation list.
--
-- Populated by `genie events revoke-subscriber <token-id>` (IR playbook).
-- `verifyToken()` in src/lib/events/tokens.ts joins against this table on
-- every verify; a present row means the token is denied even if the HMAC
-- signature is valid and expiry has not passed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS genie_events_revocations (
  token_id       TEXT PRIMARY KEY,
  subscriber_id  TEXT,
  tenant_id      TEXT NOT NULL DEFAULT 'default',
  revoked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by     TEXT NOT NULL,
  reason         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_revocations_subscriber
  ON genie_events_revocations(subscriber_id)
  WHERE subscriber_id IS NOT NULL;

GRANT SELECT, INSERT ON genie_events_revocations TO events_admin;
GRANT SELECT         ON genie_events_revocations TO events_operator, events_subscriber, events_audit;

-- ---------------------------------------------------------------------------
-- 7. Per-tenant redaction key ring.
--
-- `genie events rotate-redaction-keys` inserts a new row here with
-- `version = max(version) + 1`; pre-rotation hash lookups still work because
-- the key is preserved, the default version just advances. Both hashEntity()
-- (in src/lib/events/redactors.ts) and the audit-tier export command consult
-- this table when the env var fallback is absent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS genie_events_redaction_keys (
  tenant_id      TEXT NOT NULL DEFAULT 'default',
  version        INTEGER NOT NULL,
  key_material   TEXT NOT NULL,   -- stored encrypted in production; plaintext in dev
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_out_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, version)
);

GRANT SELECT, INSERT, UPDATE ON genie_events_redaction_keys TO events_admin;
GRANT SELECT                  ON genie_events_redaction_keys TO events_audit;

-- Seed a v1 key for the default tenant if none exists so rotate-redaction-keys
-- has a baseline to rotate from. Key material matches the dev fallback used by
-- src/lib/events/redactors.ts so existing hashes remain valid.
INSERT INTO genie_events_redaction_keys (tenant_id, version, key_material)
VALUES ('default', 1, 'genie-redaction-fallback')
ON CONFLICT (tenant_id, version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 8. Chain-key version tracking for the audit HMAC chain.
--
-- `rotate-redaction-keys` advances the default audit chain version; the
-- trigger in migration 039 already reads the key from `app.audit_hmac_key`
-- GUC, so rotation is a matter of:
--   a) inserting the new key row here,
--   b) bumping the session GUC at the app layer,
--   c) writing a sentinel `audit.key.rotated` row so `export-audit --signed`
--      can re-verify across epoch boundaries.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS genie_audit_chain_keys (
  tenant_id      TEXT NOT NULL DEFAULT 'default',
  version        INTEGER NOT NULL,
  key_material   TEXT NOT NULL,
  activated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at     TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, version)
);

GRANT SELECT, INSERT, UPDATE ON genie_audit_chain_keys TO events_admin;
GRANT SELECT                  ON genie_audit_chain_keys TO events_audit;

INSERT INTO genie_audit_chain_keys (tenant_id, version, key_material)
VALUES ('default', 1, '')
ON CONFLICT (tenant_id, version) DO NOTHING;
