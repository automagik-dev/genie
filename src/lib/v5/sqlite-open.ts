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

/**
 * SQLite PRIMARY result codes that mean "the write lock was contended", not
 * corruption: SQLITE_BUSY (5), SQLITE_LOCKED (6) and SQLITE_PROTOCOL (15).
 * Every extended code in those families (SQLITE_BUSY_RECOVERY, _SNAPSHOT,
 * _TIMEOUT, SQLITE_LOCKED_*) keeps its primary code in the low byte, so matching
 * the low byte covers the whole family — including the extended codes a raw
 * `db.query(...)` surfaces that a fixed name list would miss.
 *
 * SQLITE_PROTOCOL ("locking protocol") belongs here: SQLite raises it when a
 * writer loses the WAL-index lock race too many times in a row under heavy
 * multi-process contention. It is transient lock contention on a HEALTHY
 * database, so it must surface as {@link BusyDbError} (safe to retry), never as
 * a corruption claim.
 */
const BUSY_PRIMARY_CODES = new Set([5, 6, 15]);

/** `code` name prefixes covering the same contended-lock families. */
const BUSY_CODE_PREFIXES = ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_PROTOCOL'] as const;

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
 * The database is stamped below `schemaVersion` and the ladder CAN bridge it,
 * but this caller opened with `migrate: false`. It is not an error about the
 * file — it is a statement that a mutation is pending and this caller declined
 * to perform it. `genie doctor` turns it into a finding; every lifecycle verb
 * opens with the default and migrates.
 */
export class PendingMigrationError extends GenieDbError {
  readonly path: string;
  readonly foundVersion: number;
  readonly expectedVersion: number;
  constructor(path: string, foundVersion: number, expectedVersion: number) {
    super(
      `Database at ${path} is at schema v${foundVersion}; this build expects v${expectedVersion}. The next lifecycle command (\`genie task\`, \`genie board\`) migrates it after taking a backup.`,
    );
    this.name = 'PendingMigrationError';
    this.path = path;
    this.foundVersion = foundVersion;
    this.expectedVersion = expectedVersion;
  }
}

/**
 * True when `err` is a contended-lock failure (transient, retryable) rather than
 * a corrupt/foreign database. Matches bun:sqlite's numeric `errno` (primary code
 * in the low byte — the only field that covers every extended busy code), its
 * `code` name, and the raw "database is locked" text SQLite emits when
 * busy_timeout is exhausted.
 */
export function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const errno = (err as { errno?: unknown }).errno;
  if (typeof errno === 'number' && BUSY_PRIMARY_CODES.has(errno & 0xff)) return true;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && BUSY_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))) return true;
  return /database (?:table )?is locked|locking protocol/i.test(err.message);
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
  /**
   * Forward-only migration ladder for a database stamped BELOW
   * `schemaVersion`. Without it, {@link initOrValidate} refuses every version it
   * does not recognize, so bumping `schemaVersion` alone bricks every database
   * already on disk. Steps are applied in ascending `from` order, each inside
   * one transaction, and `PRAGMA user_version` is re-stamped once the chain
   * reaches `schemaVersion`.
   *
   * A gap in the chain is NOT bridged silently: if no step starts at the
   * stamped version, or the chain stops short of `schemaVersion`, the open
   * still throws {@link ForeignDbError}. After the ladder runs the database
   * falls through to the current-version branch — `schemaIsCurrent` then
   * `ensureSchema` — so additive backfills apply to a just-migrated database
   * exactly as they do to one already at `schemaVersion`.
   */
  migrations?: ReadonlyArray<{ from: number; to: number; apply: (db: Database) => void }>;
  /**
   * Opt OUT of applying the ladder. A caller that only OBSERVES the database
   * — `genie doctor` is the whole reason this exists — must never perform an
   * irreversible schema change as a side effect of looking. With `false`, a
   * database stamped below `schemaVersion` that the ladder COULD bridge throws
   * {@link PendingMigrationError} instead of being migrated; one it could not
   * bridge still throws {@link ForeignDbError}, because that is not a pending
   * migration, it is a foreign file.
   */
  migrate?: boolean;
  /**
   * Called once, before the FIRST step runs, with the chain the planner
   * settled on. The migration is destructive and forward-only, so the caller
   * uses this to take its backup and tell the operator where it went; a throw
   * here aborts the migration with the database untouched. It is not called at
   * all when the database is already current, when there is nothing to bridge,
   * or when `migrate` is false.
   *
   * TWO-PHASE, because the copy cannot happen under the write lock: neither
   * `wal_checkpoint` nor `VACUUM INTO` may run inside a transaction, so the
   * backup is PREPARED here and its fate decided afterwards. Every racing
   * opener prepares one; exactly the one that wins the lock gets `commit()`
   * and every other gets `discard()`. Returning nothing opts out of both.
   */
  beforeMigrate?: (info: {
    db: Database;
    path: string;
    from: number;
    to: number;
  }) => PreparedMigrationBackup | undefined;
}

/**
 * Open (creating if absent) a genie sqlite DB, apply concurrency pragmas, and
 * ensure the schema. Refuses malformed or foreign databases with typed errors.
 * Idempotent: safe to call on every CLI invocation.
 *
 * This is the FLEET hot path — every `genie task`, `task sync`, git-hook sync
 * and MCP read opens through it — so it does exactly one thing: open, pragma,
 * ensure schema. No probing, no journal-mode churn. WAL
 * index recovery is deliberately NOT wired in here; it is opt-in and scoped to
 * the component that creates the poison (see {@link openWithWalIndexRecovery}).
 */
export function openSqlite(opts: OpenSqliteOptions): Database {
  const { path } = opts;
  // No explicit mode: every DB this primitive now opens lives in the user's own
  // repository (`<repo>/.genie/`), where forcing owner-only would be
  // surprising. The one caller that opted into 0o700 was the machine-scope DB,
  // whose directory IS GENIE_HOME; it left with the Omni runner in v6.
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  return openInitialized(opts);
}

/** One open attempt: construct the handle, apply pragmas, ensure the schema. */
function openInitialized(opts: OpenSqliteOptions): Database {
  const { path } = opts;
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
 * A backup taken but not yet accounted for. `commit` keeps it and announces it;
 * `discard` throws it away silently, because a backup of a migration that never
 * happened is a receipt for bytes nobody archived.
 */
export interface PreparedMigrationBackup {
  commit: () => void;
  discard: () => void;
}

/** One resolved rung of the ladder. */
type MigrationStep = { from: number; to: number; apply: (db: Database) => void };

/**
 * PURE pass: the exact chain that carries `version` to `schemaVersion`, or null
 * when no such chain exists. Nothing is executed and nothing is written here.
 *
 * Planning before applying is the whole point. A ladder that applied steps as
 * it walked would run every rung it COULD before discovering the chain stops
 * short, leaving a database partially migrated at a version it was never
 * stamped for — the one state from which no later open can recover. With the
 * plan settled first, an unbridgeable gap refuses with the file untouched.
 *
 * `to` must strictly increase (forward-only) and each step must start where the
 * previous one ended, so a malformed or cyclic declaration yields no plan
 * rather than an infinite walk.
 */
function planMigrationChain(version: number, opts: OpenSqliteOptions): MigrationStep[] | null {
  const byFrom = new Map<number, MigrationStep>();
  for (const step of opts.migrations ?? []) {
    if (step.to <= step.from) continue;
    if (!byFrom.has(step.from)) byFrom.set(step.from, step);
  }
  const chain: MigrationStep[] = [];
  let at = version;
  while (at < opts.schemaVersion) {
    const step = byFrom.get(at);
    if (step === undefined || step.to > opts.schemaVersion) return null;
    chain.push(step);
    at = step.to;
  }
  return at === opts.schemaVersion ? chain : null;
}

/**
 * Apply a plan {@link planMigrationChain} already proved complete.
 *
 * Each step runs in ONE transaction that also stamps its own `to` into
 * `PRAGMA user_version` — SQLite rolls that pragma back with the transaction,
 * so there is no window in which the DDL has committed and the version has not.
 * Stamping once at the end instead would leave a process killed mid-chain with
 * migrated tables and a stale version: the next open would re-run steps against
 * a schema that had already moved. The version is re-read after each commit and
 * a disagreement aborts the chain rather than continuing on an assumption.
 */
function applyMigrationChain(db: Database, chain: readonly MigrationStep[], opts: OpenSqliteOptions): void {
  for (const step of chain) {
    // IMMEDIATE, not deferred: a step whose first statement is a read would
    // take the write lock only later, leaving a window in which another opener
    // commits the same step underneath it.
    db.transaction(() => {
      step.apply(db);
      db.exec(`PRAGMA user_version = ${step.to}`);
    }).immediate();
    const stamped = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (stamped !== step.to) {
      throw new MalformedDbError(
        opts.path,
        new Error(`migration ${step.from} -> ${step.to} committed but user_version reads ${stamped}`),
      );
    }
  }
}

/**
 * Run the chain under the write lock, with the stamped version RE-READ inside
 * it, and settle the prepared backup by the outcome.
 *
 * `readUserVersion` happens on an unsynchronized read, so by the time a caller
 * has planned a chain another process may already have run it. Six concurrent
 * first-openers each believed they were the migrator: three took backups, and
 * the losers announced "previous database backed up" over a file already at the
 * new version — a receipt for bytes nobody archived. The re-read inside the
 * FIRST step's immediate transaction is the arbiter: only the process that
 * still sees `from` under the lock migrates, and only it keeps and announces
 * its backup.
 *
 * Returns false when this process lost the race — nothing was written and the
 * backup was discarded, so the caller re-reads the version and continues.
 */
function migrateUnderLock(
  db: Database,
  chain: readonly MigrationStep[],
  from: number,
  opts: OpenSqliteOptions,
): boolean {
  const first = chain[0] as MigrationStep;
  const backup = opts.beforeMigrate?.({ db, path: opts.path, from, to: opts.schemaVersion });
  let won = false;
  try {
    won = db
      .transaction(() => {
        const current = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
        // Another opener migrated between our read and this lock. Not an error.
        if (current !== from) return false;
        first.apply(db);
        db.exec(`PRAGMA user_version = ${first.to}`);
        return true;
      })
      .immediate() as boolean;
    if (won) applyMigrationChain(db, chain.slice(1), opts);
  } finally {
    if (won) backup?.commit();
    else backup?.discard();
  }
  return won;
}

/**
 * The policy for a database stamped BELOW this build's `schemaVersion`: refuse,
 * decline, migrate, or adopt a concurrent migration. Split out of
 * {@link initOrValidate} because it is a distinct decision with four outcomes,
 * not another branch of that function's version dispatch.
 *
 * Returns normally once the database is at `schemaVersion`; throws otherwise.
 */
function bringUpToSchemaVersion(db: Database, version: number, opts: OpenSqliteOptions): void {
  const { path, schemaVersion } = opts;
  const chain = planMigrationChain(version, opts);
  if (chain === null) {
    throw new ForeignDbError(path, version, schemaVersion, 'no migration path from this schema version');
  }
  // Declined, not performed: the caller only wanted to look.
  if (opts.migrate === false) throw new PendingMigrationError(path, version, schemaVersion);
  if (migrateUnderLock(db, chain, version, opts)) return;
  // A concurrent opener migrated first. Its result is authoritative, so adopt
  // it — but only once it really did land on this build's version.
  const settled = readUserVersion(db, path);
  if (settled !== schemaVersion) {
    throw new ForeignDbError(path, settled, schemaVersion, 'concurrent migration left an unexpected version');
  }
}

/**
 * Validate the stamped `user_version` and bring the schema up to date:
 *   - at `schemaVersion`: skip DDL when `schemaIsCurrent` confirms completeness,
 *     otherwise run `ensureSchema` (additive backfills stay within this version),
 *   - at 0: adopt an empty file as fresh, but refuse one already carrying foreign
 *     tables; ensure the schema and stamp the version,
 *   - BELOW `schemaVersion` with a ladder that reaches it: migrate, re-stamp,
 *     then fall through to the current-version branch so additive backfills
 *     still apply,
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
  if (version > 0 && version < schemaVersion) {
    bringUpToSchemaVersion(db, version, opts);
    // Deliberate fall-through, not a second open: a database the ladder just
    // brought to `schemaVersion` must receive the same additive backfills as
    // one that was already there. Returning here instead left a migrated
    // database permanently short of them.
    if (!schemaIsCurrent || !schemaIsCurrent(db)) ensureSchema(db);
    return;
  }
  if (version > schemaVersion) {
    throw new ForeignDbError(
      path,
      version,
      schemaVersion,
      `written by a newer genie (schema v${version}); run \`genie update\` in this checkout`,
    );
  }
  throw new ForeignDbError(path, version, schemaVersion, 'unrecognized schema version');
}
