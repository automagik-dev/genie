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
const EXPECTED_TABLES = ['approvals', 'inbound_messages', 'agent_sessions'] as const;

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
  const cols = new Set((db.query('PRAGMA table_info(approvals)').all() as Array<{ name: string }>).map((c) => c.name));
  return cols.has('last_status_glyph');
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
  last_status_glyph TEXT
);

CREATE TABLE IF NOT EXISTS inbound_messages (
  id          TEXT PRIMARY KEY,
  instance    TEXT NOT NULL,
  chat        TEXT NOT NULL,
  sender      TEXT NOT NULL,
  body        TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  handled_at  INTEGER
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  provider   TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
  instance   TEXT NOT NULL,
  chat       TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, instance, chat)
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

/** Create every table/index if absent. Idempotent — pure `IF NOT EXISTS`. */
export function ensureSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  ensureApprovalColumns(db);
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
}
