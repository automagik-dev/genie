/**
 * Genie v5 shared sqlite open/init primitives.
 *
 * Both the per-repo `.genie/genie.db` (see genie-db.ts) and the machine-scope
 * `~/.genie/genie.db` (see global-db.ts) are single-file bun:sqlite databases
 * opened once per CLI invocation, mutated in one transaction, and closed. They
 * share the same concurrency contract:
 *
 *   - busy_timeout FIRST, then WAL — every later lock can wait for the write
 *     lock instead of raising an instant SQLITE_BUSY,
 *   - a bounded busy-retry loop so a straggler that outlives busy_timeout under
 *     multi-process contention surfaces as a typed {@link BusyDbError} (safe to
 *     retry), never a {@link MalformedDbError} (corruption),
 *   - refusal of foreign / malformed databases with typed errors,
 *   - idempotent, caller-supplied schema creation stamped into
 *     `PRAGMA user_version`.
 *
 * This module owns everything path-agnostic. The per-DB modules supply only
 * their own path resolution, schema version, `ensureSchema`, and an optional
 * `schemaIsCurrent` fast-path.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Milliseconds a writer waits for the write lock before giving up. Chosen so
 * concurrent writers serialize into clean conflicts instead of raising
 * SQLITE_BUSY under contention.
 */
export const BUSY_TIMEOUT_MS = 5_000;

/**
 * Backoff schedule (ms) for re-attempting the open sequence when a transient
 * SQLITE_BUSY escapes busy_timeout under heavy multi-process contention. Total
 * sleep budget (775ms) stays well under BUSY_TIMEOUT_MS; each attempt already
 * waits up to busy_timeout for the lock, so this only paces the rare straggler.
 */
const BUSY_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;

/** SQLite result codes that mean "the write lock was contended", not corruption. */
const BUSY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED']);

// ============================================================================
// Typed errors
// ============================================================================

/** Base class for every failure raised while opening or validating a genie DB. */
export class GenieDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenieDbError';
  }
}

/** The file exists but is not a readable SQLite database. */
export class MalformedDbError extends GenieDbError {
  readonly path: string;
  constructor(path: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : cause != null ? String(cause) : 'unknown';
    super(`Refusing malformed database at ${path}: ${detail}`);
    this.name = 'MalformedDbError';
    this.path = path;
  }
}

/**
 * The file is a healthy genie DB, but the open lost the write lock to another
 * process even after busy_timeout + bounded retries. Transient contention —
 * safe to retry the whole open. Never conflate with {@link MalformedDbError}:
 * a locked database is not a corrupt one.
 */
export class BusyDbError extends GenieDbError {
  readonly path: string;
  constructor(path: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : cause != null ? String(cause) : 'unknown';
    super(`Database at ${path} is under transient contention (safe to retry): ${detail}`);
    this.name = 'BusyDbError';
    this.path = path;
  }
}

/** The file is a valid SQLite DB but was not created by genie v5. */
export class ForeignDbError extends GenieDbError {
  readonly path: string;
  readonly foundVersion: number;
  constructor(path: string, foundVersion: number, expectedVersion: number, why: string) {
    super(
      `Refusing foreign database at ${path} (user_version=${foundVersion}, expected 0 or ${expectedVersion}): ${why}`,
    );
    this.name = 'ForeignDbError';
    this.path = path;
    this.foundVersion = foundVersion;
  }
}

/**
 * True when `err` is a contended-lock failure (transient, retryable) rather than
 * a corrupt/foreign database. Matches bun:sqlite's `code` field and the raw
 * "database is locked" text SQLite emits when busy_timeout is exhausted.
 */
export function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && BUSY_CODES.has(code)) return true;
  return /database (?:table )?is locked/i.test(err.message);
}

// ============================================================================
// Open / init
// ============================================================================

export interface OpenSqliteOptions {
  /** Explicit DB file path. `:memory:` allowed. */
  path: string;
  /** Schema revision stamped into `PRAGMA user_version` for a fresh/current DB. */
  schemaVersion: number;
  /** Idempotent schema creation. Runs under the write lock; must use IF NOT EXISTS. */
  ensureSchema: (db: Database) => void;
  /**
   * Optional pure-read fast-path. When the DB is already at `schemaVersion` and
   * this returns true, `ensureSchema` is skipped so a known-current DB opens
   * without contending on the schema write lock. Omit to always run ensureSchema.
   */
  schemaIsCurrent?: (db: Database) => boolean;
}

/**
 * Open (creating if absent) a genie sqlite DB, apply concurrency pragmas, and
 * ensure the schema. Refuses malformed or foreign databases with typed errors.
 * Idempotent: safe to call on every CLI invocation.
 */
export function openSqlite(opts: OpenSqliteOptions): Database {
  const { path } = opts;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  let db: Database;
  try {
    db = new Database(path, { create: true });
  } catch (err) {
    throw new MalformedDbError(path, err);
  }

  try {
    initWithBusyRetry(db, opts);
    return db;
  } catch (err) {
    db.close();
    if (err instanceof GenieDbError) throw err;
    throw new MalformedDbError(path, err);
  }
}

/** Block the current thread for `ms` without spinning — used only for open retries. */
const SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms: number): void {
  // Never resolves (value stays 0), so this always waits out the full timeout.
  Atomics.wait(SLEEP_SIGNAL, 0, 0, ms);
}

/**
 * Run the open→validate sequence, retrying only on transient SQLITE_BUSY. A
 * foreign/malformed DB (GenieDbError) fails fast — retrying can't fix it. A busy
 * error that outlives busy_timeout AND the backoff budget surfaces as a typed
 * {@link BusyDbError}, never as {@link MalformedDbError}.
 */
function initWithBusyRetry(db: Database, opts: OpenSqliteOptions): void {
  for (let attempt = 0; ; attempt++) {
    try {
      applyPragmas(db);
      const version = readUserVersion(db, opts.path);
      initOrValidate(db, version, opts);
      return;
    } catch (err) {
      if (err instanceof GenieDbError) throw err; // foreign/malformed — not retryable
      if (!isBusyError(err)) throw err; // genuine error — caller maps to Malformed
      if (attempt >= BUSY_RETRY_DELAYS_MS.length) throw new BusyDbError(opts.path, err);
      sleepMs(BUSY_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function applyPragmas(db: Database): void {
  // busy_timeout FIRST: every later lock (WAL switch, DDL) must be able to wait
  // for the write lock instead of raising an instant SQLITE_BUSY.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  // WAL: concurrent readers never block the single writer.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // NORMAL is durable under WAL and much faster than FULL for per-CLI writes.
  db.exec('PRAGMA synchronous = NORMAL');
}

/**
 * Read `user_version`. A busy throw is re-raised raw so the retry loop can wait
 * it out; any other throw means the file is not a SQLite database.
 */
function readUserVersion(db: Database, path: string): number {
  try {
    const row = db.query('PRAGMA user_version').get() as { user_version: number } | null;
    return row?.user_version ?? 0;
  } catch (err) {
    if (isBusyError(err)) throw err;
    throw new MalformedDbError(path, err);
  }
}

/** True when the DB holds any non-internal table. */
export function hasUserTables(db: Database): boolean {
  const row = db
    .query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .get() as { n: number };
  return row.n > 0;
}

/**
 * Validate the stamped `user_version` and bring the schema up to date:
 *   - at `schemaVersion`: skip DDL when `schemaIsCurrent` confirms completeness,
 *     otherwise run `ensureSchema` (additive backfills stay within this version),
 *   - at 0: adopt an empty file as fresh, but refuse one already carrying foreign
 *     tables; ensure the schema and stamp the version,
 *   - anything else: a foreign database — refuse.
 */
function initOrValidate(db: Database, version: number, opts: OpenSqliteOptions): void {
  const { path, schemaVersion, ensureSchema, schemaIsCurrent } = opts;
  if (version === schemaVersion) {
    // Skip the DDL write lock when the schema is already complete — under heavy
    // contention this is the amplifier (N opens = N concurrent DDL writers).
    if (!schemaIsCurrent || !schemaIsCurrent(db)) ensureSchema(db);
    return;
  }
  if (version === 0) {
    if (hasUserTables(db)) {
      throw new ForeignDbError(path, version, schemaVersion, 'unversioned database already contains foreign tables');
    }
    ensureSchema(db);
    db.exec(`PRAGMA user_version = ${schemaVersion}`);
    return;
  }
  throw new ForeignDbError(path, version, schemaVersion, 'unrecognized schema version');
}
