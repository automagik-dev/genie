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
const EXPECTED_TABLES = ['approvals', 'inbound_messages'] as const;

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
  return true;
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
  resolved_at   INTEGER
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

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_inbound_handled ON inbound_messages(handled_at);
`;

/** Create every table/index if absent. Idempotent — pure `IF NOT EXISTS`. */
export function ensureSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
}
