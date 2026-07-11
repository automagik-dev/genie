/**
 * Genie v5 machine-scope state store — `~/.genie/genie.db`.
 *
 * The per-repo `.genie/genie.db` (genie-db.ts) holds task/wish state scoped to
 * one checkout. This GLOBAL database holds machine-wide operational state that
 * outlives any single repo: the human-in-the-loop approval queue and the
 * inbound-message inbox that feed the Omni runner.
 *
 * It is a wholly separate database from the per-repo one — different path,
 * different schema, its own `PRAGMA user_version`. This module deliberately
 * imports NONE of genie-db.ts's path constants; the only shared code is the
 * concurrency/open primitive in sqlite-open.ts.
 *
 * Path: `<GENIE_HOME>/genie.db`, falling back to `~/.genie/genie.db`. Resolved
 * lazily on every open so a test that sets `GENIE_HOME` to a tmpdir never
 * touches the real `~/.genie`.
 */

import type { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from './sqlite-open.js';

// The typed error taxonomy is shared with the per-repo DB. Re-exported so
// callers of the global DB can catch failures without importing genie-db.
export { BusyDbError, ForeignDbError, GenieDbError, isBusyError, MalformedDbError } from './sqlite-open.js';

/** Schema revision for the GLOBAL database. Independent of the per-repo version. */
export const GLOBAL_SCHEMA_VERSION = 1;

/** Machine-wide lease that authorizes Omni queue claims and external effects. */
export const OMNI_SERVICE_LEASE_NAME = 'omni-serve';

/**
 * Sentinel written into `last_status_glyph` for pre-existing closed approvals at
 * the moment the column is first added (the one-time upgrade backfill). It is
 * NOT a real reaction emoji, so it can never collide with a live status glyph;
 * `listApprovalsNeedingStatusAck` treats it as terminal so the runner's
 * reconciliation pass NEVER touches historical rows on the first post-upgrade
 * tick (which would otherwise fire a reaction HTTP POST for the entire history).
 */
export const MIGRATED_STATUS_SENTINEL = 'migrated';

/**
 * Base directory for all machine-scope genie state. Read from `GENIE_HOME` on
 * every call (not cached) so env overrides in tests take effect.
 */
function genieHome(): string {
  return process.env.GENIE_HOME ?? join(homedir(), '.genie');
}

/** Absolute path to the global genie.db. */
export function resolveGlobalDbPath(): string {
  return join(genieHome(), 'genie.db');
}

export interface OpenGlobalOptions {
  /** Explicit DB file path. Overrides `GENIE_HOME`-based resolution. `:memory:` allowed. */
  path?: string;
}

/**
 * Open (creating if absent) the global genie.db, apply concurrency pragmas, and
 * ensure the schema. Refuses malformed or foreign databases with typed errors.
 * Idempotent: safe to call on every CLI invocation.
 */
export function openGlobalDb(opts: OpenGlobalOptions = {}): Database {
  return openSqlite({
    path: opts.path ?? resolveGlobalDbPath(),
    schemaVersion: GLOBAL_SCHEMA_VERSION,
    ensureSchema,
    schemaIsCurrent,
  });
}

/** Tables a fully-initialized `user_version = 1` global DB must carry. */
const EXPECTED_TABLES = ['approvals', 'inbound_messages', 'agent_sessions', 'service_leases'] as const;

/**
 * True when the DB already holds every expected table. Pure reads (no write
 * lock), so a known-current DB opens without contending on the schema lock.
 */
function schemaIsCurrent(db: Database): boolean {
  const tables = new Set(
    (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name),
  );
  for (const t of EXPECTED_TABLES) if (!tables.has(t)) return false;
  // A pre-column v1 DB (missing the additive last_status_glyph) returns false so
  // ensureSchema runs and backfills — mirrors genie-db.ts's ensureTaskColumns.
  const approvalCols = new Set(
    (db.query('PRAGMA table_info(approvals)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  const inboundCols = new Set(
    (db.query('PRAGMA table_info(inbound_messages)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  const inboundIndexes = db.query('PRAGMA index_list(inbound_messages)').all() as Array<{
    name: string;
    unique: number;
    partial: number;
  }>;
  const approvalIndexes = db.query('PRAGMA index_list(approvals)').all() as Array<{ name: string }>;
  const serviceCols = new Set(
    (db.query('PRAGMA table_info(service_leases)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  const eventKeyIndex = inboundIndexes.find((index) => index.name === 'idx_inbound_event_key');
  const approvalClaimBackfilled = approvalIndexes.some((index) => index.name === 'idx_approval_claim_phase_backfill');
  const inboundClaimBackfilled = inboundIndexes.some((index) => index.name === 'idx_inbound_claim_phase_backfill');
  return (
    approvalCols.has('last_status_glyph') &&
    approvalCols.has('announce_claim') &&
    inboundCols.has('event_key') &&
    inboundCols.has('processing_claim') &&
    inboundCols.has('processing_claim_owner') &&
    inboundCols.has('processing_claim_epoch') &&
    inboundCols.has('processing_claimed_at') &&
    inboundCols.has('processing_phase') &&
    inboundCols.has('outbound_event_id') &&
    inboundCols.has('outbound_subject') &&
    inboundCols.has('outbound_payload') &&
    inboundCols.has('outbound_meta') &&
    approvalCols.has('announce_claim_owner') &&
    approvalCols.has('announce_claim_epoch') &&
    approvalCols.has('announce_claimed_at') &&
    approvalCols.has('announce_phase') &&
    approvalCols.has('announce_prior_claim') &&
    approvalCols.has('announce_prior_owner') &&
    approvalCols.has('announce_prior_epoch') &&
    serviceCols.has('epoch') &&
    eventKeyIndex?.unique === 1 &&
    eventKeyIndex.partial === 1 &&
    approvalClaimBackfilled &&
    inboundClaimBackfilled
  );
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS approvals (
  id            TEXT PRIMARY KEY,
  repo          TEXT NOT NULL,
  session_hint  TEXT,
  tool          TEXT NOT NULL,
  input_summary TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  omni_message_id TEXT,
  requested_by  TEXT,
  resolved_by   TEXT,
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER,
  last_status_glyph TEXT,
  announce_claim TEXT,
  announce_claim_owner TEXT,
  announce_claim_epoch INTEGER,
  announce_claimed_at INTEGER,
  announce_phase TEXT,
  announce_prior_claim TEXT,
  announce_prior_owner TEXT,
  announce_prior_epoch INTEGER
);

CREATE TABLE IF NOT EXISTS inbound_messages (
  id          TEXT PRIMARY KEY,
  instance    TEXT NOT NULL,
  chat        TEXT NOT NULL,
  sender      TEXT NOT NULL,
  body        TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  handled_at  INTEGER,
  event_key TEXT,
  processing_claim TEXT,
  processing_claim_owner TEXT,
  processing_claim_epoch INTEGER,
  processing_claimed_at INTEGER,
  processing_phase TEXT,
  outbound_event_id TEXT,
  outbound_subject TEXT,
  outbound_payload TEXT,
  outbound_meta TEXT
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  provider   TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
  instance   TEXT NOT NULL,
  chat       TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, instance, chat)
);

CREATE TABLE IF NOT EXISTS service_leases (
  name       TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  epoch      INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_inbound_handled ON inbound_messages(handled_at);
`;

export type AgentProvider = 'claude' | 'codex';

export function getAgentSession(
  db: Database,
  provider: AgentProvider,
  instance: string,
  chat: string,
): string | undefined {
  const row = db
    .query('SELECT thread_id AS threadId FROM agent_sessions WHERE provider = ? AND instance = ? AND chat = ?')
    .get(provider, instance, chat) as { threadId: string } | null;
  return row?.threadId;
}

export function upsertAgentSession(
  db: Database,
  provider: AgentProvider,
  instance: string,
  chat: string,
  threadId: string,
  now = Date.now(),
): void {
  db.query(
    `INSERT INTO agent_sessions(provider, instance, chat, thread_id, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider, instance, chat)
     DO UPDATE SET thread_id = excluded.thread_id, updated_at = excluded.updated_at`,
  ).run(provider, instance, chat, threadId, now);
}

/** Insert only when no route session exists. False means a concurrent owner won. */
export function insertAgentSessionIfAbsent(
  db: Database,
  provider: AgentProvider,
  instance: string,
  chat: string,
  threadId: string,
  now = Date.now(),
): boolean {
  const result = db
    .query(
      `INSERT INTO agent_sessions(provider, instance, chat, thread_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider, instance, chat) DO NOTHING`,
    )
    .run(provider, instance, chat, threadId, now);
  return result.changes === 1;
}

/** Compare-and-swap a route session. False means the expected id is stale. */
export function replaceAgentSessionIfCurrent(
  db: Database,
  provider: AgentProvider,
  instance: string,
  chat: string,
  expectedThreadId: string,
  replacementThreadId: string,
  now = Date.now(),
): boolean {
  const result = db
    .query(
      `UPDATE agent_sessions
       SET thread_id = ?, updated_at = ?
       WHERE provider = ? AND instance = ? AND chat = ? AND thread_id = ?`,
    )
    .run(replacementThreadId, now, provider, instance, chat, expectedThreadId);
  return result.changes === 1;
}

/** Delete only the exact stale route session observed by a recovery attempt. */
export function clearAgentSessionIfCurrent(
  db: Database,
  provider: AgentProvider,
  instance: string,
  chat: string,
  expectedThreadId: string,
): boolean {
  const result = db
    .query('DELETE FROM agent_sessions WHERE provider = ? AND instance = ? AND chat = ? AND thread_id = ?')
    .run(provider, instance, chat, expectedThreadId);
  return result.changes === 1;
}

/** Create every table/index if absent. Idempotent — pure `IF NOT EXISTS`. */
export function ensureSchema(db: Database): void {
  const ensure = db.transaction(() => {
    db.exec(SCHEMA_SQL);
    ensureApprovalColumns(db);
    ensureInboundColumns(db);
    ensureServiceLeaseColumns(db);
  });
  ensure.immediate();
}

/**
 * Additive, in-place column backfill for `approvals`. `CREATE TABLE IF NOT
 * EXISTS` never alters an existing table, so a DB stamped by an earlier build
 * (which lacked `last_status_glyph`) needs the column added. It is nullable, so
 * this stays within `user_version = 1` — no destructive migration, no version
 * bump (mirrors genie-db.ts's ensureTaskColumns). Idempotent: a table that
 * already has the column is left untouched.
 */
function ensureApprovalColumns(db: Database): void {
  const cols = new Set((db.query('PRAGMA table_info(approvals)').all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has('last_status_glyph')) {
    db.exec('ALTER TABLE approvals ADD COLUMN last_status_glyph TEXT');
    // One-time upgrade backfill: stamp every already-closed approval as MIGRATED
    // so the runner's reconciliation pass never re-acks pre-upgrade history
    // (whose omni_message_id may be a bogus self-ref, or a real days-old stanza
    // id we must not spam). Runs ONLY when the column is first added.
    db.query(`UPDATE approvals SET last_status_glyph = ? WHERE status != 'pending'`).run(MIGRATED_STATUS_SENTINEL);
  }
  if (!cols.has('announce_claim')) db.exec('ALTER TABLE approvals ADD COLUMN announce_claim TEXT');
  if (!cols.has('announce_claim_owner')) db.exec('ALTER TABLE approvals ADD COLUMN announce_claim_owner TEXT');
  if (!cols.has('announce_claim_epoch')) db.exec('ALTER TABLE approvals ADD COLUMN announce_claim_epoch INTEGER');
  if (!cols.has('announce_claimed_at')) db.exec('ALTER TABLE approvals ADD COLUMN announce_claimed_at INTEGER');
  if (!cols.has('announce_phase')) db.exec('ALTER TABLE approvals ADD COLUMN announce_phase TEXT');
  if (!cols.has('announce_prior_claim')) db.exec('ALTER TABLE approvals ADD COLUMN announce_prior_claim TEXT');
  if (!cols.has('announce_prior_owner')) db.exec('ALTER TABLE approvals ADD COLUMN announce_prior_owner TEXT');
  if (!cols.has('announce_prior_epoch')) db.exec('ALTER TABLE approvals ADD COLUMN announce_prior_epoch INTEGER');
  // A pre-phase resident may have crossed the HTTP boundary before crashing.
  // There is no durable evidence that replay is safe, so upgrades classify the
  // claim as ambiguous instead of treating NULL as a retryable pre-send state.
  db.exec(
    "UPDATE approvals SET announce_phase = 'ambiguous' WHERE announce_claim IS NOT NULL AND announce_phase IS NULL",
  );
  // Empty partial index is a transactional migration marker. It lets the open
  // fast-path prove the backfill ran without scanning queue history every time.
  db.exec('CREATE INDEX IF NOT EXISTS idx_approval_claim_phase_backfill ON approvals(id) WHERE 0');
}

function ensureInboundColumns(db: Database): void {
  const cols = new Set(
    (db.query('PRAGMA table_info(inbound_messages)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('event_key')) db.exec('ALTER TABLE inbound_messages ADD COLUMN event_key TEXT');
  if (!cols.has('processing_claim')) db.exec('ALTER TABLE inbound_messages ADD COLUMN processing_claim TEXT');
  if (!cols.has('processing_claim_owner'))
    db.exec('ALTER TABLE inbound_messages ADD COLUMN processing_claim_owner TEXT');
  if (!cols.has('processing_claim_epoch'))
    db.exec('ALTER TABLE inbound_messages ADD COLUMN processing_claim_epoch INTEGER');
  if (!cols.has('processing_claimed_at'))
    db.exec('ALTER TABLE inbound_messages ADD COLUMN processing_claimed_at INTEGER');
  if (!cols.has('processing_phase')) db.exec('ALTER TABLE inbound_messages ADD COLUMN processing_phase TEXT');
  if (!cols.has('outbound_event_id')) db.exec('ALTER TABLE inbound_messages ADD COLUMN outbound_event_id TEXT');
  if (!cols.has('outbound_subject')) db.exec('ALTER TABLE inbound_messages ADD COLUMN outbound_subject TEXT');
  if (!cols.has('outbound_payload')) db.exec('ALTER TABLE inbound_messages ADD COLUMN outbound_payload TEXT');
  if (!cols.has('outbound_meta')) db.exec('ALTER TABLE inbound_messages ADD COLUMN outbound_meta TEXT');
  // The old schema had only processing_claim. A crash could have occurred after
  // workspace execution, so an unknown phase must never be replayed as fresh.
  db.exec(
    "UPDATE inbound_messages SET processing_phase = 'ambiguous' WHERE processing_claim IS NOT NULL AND processing_phase IS NULL",
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_inbound_claim_phase_backfill ON inbound_messages(id) WHERE 0');
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_event_key ON inbound_messages(event_key) WHERE event_key IS NOT NULL',
  );
}

function ensureServiceLeaseColumns(db: Database): void {
  const cols = new Set(
    (db.query('PRAGMA table_info(service_leases)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('epoch')) db.exec('ALTER TABLE service_leases ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1');
}

/** Acquire a lease and return its monotonic fencing epoch. A takeover advances
 * the epoch, allowing durable row claims from an expired resident to be
 * distinguished from live work owned by the current resident. */
export function acquireServiceLeaseEpoch(
  db: Database,
  name: string,
  ownerId: string,
  now: number,
  ttlMs: number,
): number | undefined {
  const acquire = db.transaction(() => {
    const current = db
      .query('SELECT owner_id AS ownerId, expires_at AS expiresAt, epoch FROM service_leases WHERE name = ?')
      .get(name) as { ownerId: string; expiresAt: number; epoch: number } | null;
    if (!current) {
      db.query('INSERT INTO service_leases(name, owner_id, expires_at, epoch) VALUES (?, ?, ?, 1)').run(
        name,
        ownerId,
        now + ttlMs,
      );
      return 1;
    }
    if (current.ownerId === ownerId) {
      db.query('UPDATE service_leases SET expires_at = ? WHERE name = ? AND owner_id = ? AND epoch = ?').run(
        now + ttlMs,
        name,
        ownerId,
        current.epoch,
      );
      return current.epoch;
    }
    if (current.expiresAt > now) return undefined;
    const nextEpoch = current.epoch + 1;
    db.query('UPDATE service_leases SET owner_id = ?, expires_at = ?, epoch = ? WHERE name = ?').run(
      ownerId,
      now + ttlMs,
      nextEpoch,
      name,
    );
    return nextEpoch;
  });
  return acquire.immediate();
}

/** Acquire a named machine-scoped lease with one atomic conditional upsert. */
export function acquireServiceLease(db: Database, name: string, ownerId: string, now: number, ttlMs: number): boolean {
  return acquireServiceLeaseEpoch(db, name, ownerId, now, ttlMs) !== undefined;
}

/** Renew only the exact owner; false fences a resident whose lease was lost. */
export function renewServiceLease(
  db: Database,
  name: string,
  ownerId: string,
  now: number,
  ttlMs: number,
  epoch?: number,
): boolean {
  const result =
    epoch === undefined
      ? db
          .query('UPDATE service_leases SET expires_at = ? WHERE name = ? AND owner_id = ?')
          .run(now + ttlMs, name, ownerId)
      : db
          .query('UPDATE service_leases SET expires_at = ? WHERE name = ? AND owner_id = ? AND epoch = ?')
          .run(now + ttlMs, name, ownerId, epoch);
  return result.changes === 1;
}

/** Pure authority probe for side effects that do not have a queue-row phase
 * transition of their own (for example status reactions). */
export function isServiceLeaseCurrent(
  db: Database,
  name: string,
  ownerId: string,
  epoch: number,
  now = Date.now(),
): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM service_leases
         WHERE name = ? AND owner_id = ? AND epoch = ? AND expires_at > ?`,
      )
      .get(name, ownerId, epoch, now) !== null
  );
}

/** Release only the exact owner token. */
export function releaseServiceLease(db: Database, name: string, ownerId: string, epoch?: number): boolean {
  const result =
    epoch === undefined
      ? db.query('UPDATE service_leases SET expires_at = 0 WHERE name = ? AND owner_id = ?').run(name, ownerId)
      : db
          .query('UPDATE service_leases SET expires_at = 0 WHERE name = ? AND owner_id = ? AND epoch = ?')
          .run(name, ownerId, epoch);
  return result.changes === 1;
}
