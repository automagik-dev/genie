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
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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

/**
 * The database's WAL index (`-shm`) is poisoned — every write through the opened
 * handle fails — and it could not be rebuilt because the `-wal` still holds
 * un-checkpointed frames that removing the sidecars would destroy. Reads still
 * work, so a read-only consumer may serve the database; a writer must not.
 */
export class WalIndexPoisonError extends GenieDbError {
  readonly path: string;
  constructor(path: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : cause != null ? String(cause) : 'unknown';
    super(`Database at ${path} has a poisoned WAL index that cannot be rebuilt (-wal holds frames): ${detail}`);
    this.name = 'WalIndexPoisonError';
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
   */
  beforeMigrate?: (info: { db: Database; path: string; from: number; to: number }) => void;
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

// ============================================================================
// Poisoned WAL-index recovery (OPT-IN — never the ordinary open path)
// ============================================================================
//
// On macOS/bun a write-protected database opens silently READONLY, and closing
// that degraded connection writes SQLite's read-only WAL-index header into
// `-shm` (iChange + nPage zeroed). The header outlives the write protection: the
// next writer opens without throwing and then fails EVERY write with a raw
// SQLITE_IOERR_WRITE / SQLITE_READONLY.
//
// SCOPING — this is a helper `openSqlite` deliberately does NOT call. The poison
// header is byte-for-byte identical to the VIRGIN header SQLite writes whenever
// it freshly (re)creates a healthy index, so the gate below cannot tell the two
// apart and fires on healthy, contended databases as readily as on poisoned
// ones. What follows the gate is journal-mode churn (WAL → DELETE → WAL) that a
// plain WAL open/close never performs; run from every process of a live fleet
// (`genie task` workers, git-hook sync) it drove bun's
// Linux shm handling into SIGBUS. Recovery therefore belongs to the ONE
// component that CREATES the poison: a degraded read-only session whose close
// writes the header. That component was the retired MCP/ui-bridge server pair,
// so today NO shipped path creates the poison and NO shipped path calls the
// recovery below (see {@link openWithWalIndexRecovery}). The scoping contract is
// retained verbatim because it is the reason the fleet primitive must stay
// churn-free: any future single-owner, low-concurrency writer that reintroduces
// a degraded read-only session opts in here and nowhere else.
//
// "Single-owner" is an assumption about the CALLER, and one MCP server per
// database does honour it. Two MCP servers on one `.genie/genie.db` do not: both
// enter the recovery path at startup and race on handle creation, the wal-index
// mmap and the exclusive-lock proof below. On Linux that race intermittently
// kills a process natively (SIGBUS/SIGSEGV inside bun's shm handling), which no
// JS `catch` can observe — the process simply disappears mid-request. The
// cross-process mutex below therefore makes the assumption true instead of
// merely documenting it: the whole probe/rebuild/reopen sequence runs under a
// lock file, so a second entrant waits rather than racing.

/** Bytes of the `-shm` WAL-index header this module inspects (iChange @8, nPage @20). */
const WAL_INDEX_HEADER_BYTES = 24;

/**
 * True when the `-shm` holds SQLite's deliberate read-only WAL-index header: the
 * change counter (iChange, offset 8) and the db-size-in-pages (nPage, offset 20)
 * are both zeroed — the state a degraded readonly connection leaves behind when
 * it closes while the database file is write-protected.
 *
 * IMPORTANT: the poison is byte-for-byte identical to the virgin header bun
 * writes when it freshly (re)creates the index on a HEALTHY open, so this
 * predicate alone can never condemn a database. It is only ever a cheap gate in
 * front of the write probe below, which is what actually distinguishes the two.
 * Only the header is read (never the whole 32KB index): the predicate runs on
 * every open.
 */
export function hasStaleReadonlyWalIndex(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(`${path}-shm`, 'r');
    const header = Buffer.alloc(WAL_INDEX_HEADER_BYTES);
    if (readSync(fd, header, 0, WAL_INDEX_HEADER_BYTES, 0) < WAL_INDEX_HEADER_BYTES) return false;
    return header.readUInt32BE(8) === 0 && header.readUInt32BE(20) === 0;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeWalIndexFd(fd);
  }
}

function closeWalIndexFd(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // A descriptor that cannot be closed must not turn a boolean into a throw.
  }
}

/**
 * True when the `-wal` is absent or empty — rebuilding the sidecars loses no
 * frames. ENOENT is the common case (a fully-checkpointed db has no `-wal`);
 * any other stat failure stays conservative (false).
 */
export function walSidecarsEmpty(path: string): boolean {
  try {
    return statSync(`${path}-wal`).size === 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** What the write probe learned about the opened handle's WAL index. */
type WalIndexProbe = { state: 'ok' | 'busy' } | { state: 'poisoned'; cause: unknown };

/**
 * Exercise the wal-index write path with a PASSIVE checkpoint, the minimal write
 * that distinguishes a healthy virgin header from the poison:
 *   - healthy: the checkpoint succeeds and self-heals the header;
 *   - busy: another process holds the index live-mmapped, which PROVES the index
 *     is not poisoned — a merely-contended database is served, never recovered
 *     (removing sidecars a live writer is using would split the brain);
 *   - poisoned: the checkpoint throws a non-busy error (SQLITE_IOERR_WRITE /
 *     SQLITE_READONLY), the same failure every later write would hit.
 */
function probeWalIndex(db: Database, path: string): WalIndexProbe {
  if (!hasStaleReadonlyWalIndex(path)) return { state: 'ok' };
  try {
    db.query('PRAGMA wal_checkpoint(PASSIVE)').all();
    return { state: 'ok' };
  } catch (err) {
    return isBusyError(err) ? { state: 'busy' } : { state: 'poisoned', cause: err };
  }
}

/**
 * Rebuild the WAL sidecars, and ONLY under SQLite-proven exclusive access.
 *
 * `PRAGMA journal_mode = DELETE` is the proof: SQLite takes the exclusive
 * WAL-index lock, checkpoints every `-wal` frame into the main file and drops
 * the wal-index — and with `busy_timeout = 0` it fails INSTANTLY with
 * SQLITE_BUSY when any peer connection is live. That is the whole point: a
 * blind `rmSync` of `-shm`/`-wal` cannot tell a poisoned index from a healthy
 * one another process holds mmapped, and unlinking under a live mmap SIGBUSes
 * that peer and cascades SQLITE_PROTOCOL to the rest of the fleet. The header
 * predicate can never make that call (see {@link hasStaleReadonlyWalIndex}), so
 * SQLite itself makes it.
 *
 * SQLite performs the whole rebuild itself, under its own locks: the conversion
 * checkpoints and unlinks the `-wal` and discards the wal-index. THIS MODULE
 * NEVER TOUCHES A SIDECAR FILE — no unlink, ever, and least of all after the
 * exclusivity handle closes. That ordering is the second half of the same
 * regression: `journal_mode = DELETE` proves exclusivity only while the handle
 * holds its locks, and `db.close()` releases them. A peer that opens in that
 * window immediately re-enters WAL and mmaps a FRESH `-shm`; unlinking it then
 * SIGBUSes the peer on its next page touch exactly as a blind pre-proof unlink
 * would. Verified on macOS/bun: after the conversion the `-wal` is gone and the
 * lingering `-shm` is harmless — the retried open re-enters WAL and
 * reinitializes that index in place, clearing the poisoned header.
 *
 * WAL is deliberately NOT restored here — going back would immediately recreate
 * the virgin index this heal exists to discard; the retried open's
 * `applyPragmas` restores it.
 *
 * Returns false (heal skipped, caller propagates the ORIGINAL error) whenever a
 * peer is live, the throwaway handle cannot be opened, or the `-wal` still holds
 * un-checkpointed frames.
 */
function rebuildSidecarsExclusively(path: string): boolean {
  if (!walSidecarsEmpty(path)) return false;
  let db: Database;
  try {
    db = new Database(path);
  } catch {
    return false; // cannot even get a handle — the heal is not possible here
  }
  try {
    db.exec('PRAGMA busy_timeout = 0');
    const row = db.query('PRAGMA journal_mode = DELETE').get() as { journal_mode?: string } | null;
    return String(row?.journal_mode ?? '').toLowerCase() === 'delete';
  } catch {
    return false; // SQLITE_BUSY / SQLITE_PROTOCOL — live peers own the sidecars
  } finally {
    db.close();
  }
}

/**
 * Suffix of the cross-process recovery mutex, named as a sidecar of the database
 * so the same `.gitignore` stanza that hides `-wal`/`-shm` hides it too.
 */
const RECOVERY_LOCK_SUFFIX = '-recovery-lock';

/**
 * How long a contender waits for the recovery lock before giving up. Generous
 * enough to outlast a holder that is mid-rebuild on a loaded CI runner; bounded
 * so a wedged holder degrades into a retryable {@link BusyDbError} rather than a
 * hang.
 */
export const RECOVERY_LOCK_WAIT_MS = 5_000;

/** Poll interval while waiting for the lock. */
const RECOVERY_LOCK_POLL_MS = 25;

/**
 * Age at which a lock whose holder cannot be proven dead is assumed abandoned.
 * A legitimate hold is bounded by two opens, each at most `busy_timeout` plus
 * the backoff budget (~11.6s together), so this sits comfortably above it: a
 * live-but-slow holder is never reaped. The usual crashed-holder case does not
 * wait this out — the PID liveness check below reclaims it on the next poll.
 */
const RECOVERY_LOCK_STALE_MS = 30_000;

/** True when `pid` still names a live process (EPERM means alive, just not ours). */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * True when the existing lock belongs to a holder that died mid-recovery. The
 * recorded PID is the primary evidence; the age is the fallback for a lock whose
 * PID is unreadable, malformed, or reused. An unreadable/vanished lock is NOT
 * abandoned — plain acquisition retry already covers that.
 */
function recoveryLockIsAbandoned(lockPath: string): boolean {
  let ageMs: number;
  let recorded: string;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
    recorded = readFileSync(lockPath, 'utf8').trim();
  } catch {
    return false;
  }
  const pid = Number.parseInt(recorded, 10);
  if (Number.isInteger(pid) && pid > 0 && !processIsAlive(pid)) return true;
  return ageMs >= RECOVERY_LOCK_STALE_MS;
}

/**
 * Take the recovery mutex for `path`, waiting out a live holder up to
 * {@link RECOVERY_LOCK_WAIT_MS} and reclaiming an abandoned one.
 *
 * Returns the lock path to release, or `null` when the lock file itself cannot
 * be created (a read-only or missing directory). A missing mutex is not a reason
 * to fail an otherwise-healthy open: the caller proceeds unserialized, exactly
 * as it did before this lock existed. Only a lock held past the wait budget
 * fails, and it fails as {@link BusyDbError} because that is what it is —
 * transient contention on a healthy database, safe to retry.
 */
function acquireRecoveryLock(path: string): string | null {
  const lockPath = `${path}${RECOVERY_LOCK_SUFFIX}`;
  const deadline = Date.now() + RECOVERY_LOCK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return lockPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      if (recoveryLockIsAbandoned(lockPath)) releaseRecoveryLock(lockPath);
      else if (Date.now() >= deadline) {
        throw new BusyDbError(path, new Error(`WAL-index recovery lock held past ${RECOVERY_LOCK_WAIT_MS}ms`));
      } else sleepMs(RECOVERY_LOCK_POLL_MS);
    }
  }
}

/** Drop the recovery mutex. A lock already gone (reaped as stale) is not an error. */
function releaseRecoveryLock(lockPath: string | null): void {
  if (lockPath === null) return;
  try {
    unlinkSync(lockPath);
  } catch {
    // Already reclaimed by a stale-lock reaper — nothing left to release.
  }
}

/**
 * Run `open`, healing a poisoned WAL index around it. The poison is detected two
 * ways because platforms differ in where it surfaces: the open may throw, or it
 * may hand back a handle whose every write fails — caught by the post-open
 * probe. Either way the sidecars are rebuilt and the open is retried EXACTLY
 * ONCE.
 *
 * The entire sequence is serialized across processes by a lock file taken BEFORE
 * the first handle exists, so concurrent entrants never race on the wal-index
 * mmap (see the section header). A waiter that wins the lock re-runs the probe
 * from scratch rather than assuming anything: by then the previous holder has
 * usually healed the database, and the ordinary healthy path just proceeds.
 *
 * CALLERS: none shipped. The sole caller was the MCP write path (`tryWriteOpen`
 * in `mcp-tools.ts`), retired together with `genie mcp` and `genie ui-bridge`;
 * with it went the only component that creates the poison. The helper and its
 * tests are retained as the opt-in seam for a future single-owner writer. See
 * the section header above for why this must never wrap the fleet-wide
 * {@link openSqlite}.
 *
 * Never runs for a contended database. Two independent guards enforce that: a
 * busy failure (from the open or the probe) short-circuits, and the rebuild
 * itself only proceeds under SQLite-proven exclusive access (see
 * {@link rebuildSidecarsExclusively}). The header predicate is never more than a
 * cheap gate — the failure evidence (a non-busy open throw, or a poisoned write
 * probe) plus SQLite's own exclusivity proof are what condemn the index. When
 * the rebuild is skipped the ORIGINAL error propagates and both sidecars survive.
 */
export function openWithWalIndexRecovery(path: string, open: () => Database): Database {
  const lockPath = acquireRecoveryLock(path);
  try {
    return openUnderRecoveryLock(path, open);
  } finally {
    releaseRecoveryLock(lockPath);
  }
}

/** The probe/rebuild/reopen sequence itself. Runs only under the recovery mutex. */
function openUnderRecoveryLock(path: string, open: () => Database): Database {
  let db: Database;
  try {
    db = open();
  } catch (err) {
    if (isBusyError(err) || err instanceof BusyDbError) throw err;
    if (!hasStaleReadonlyWalIndex(path) || !rebuildSidecarsExclusively(path)) throw err;
    return open();
  }
  const probe = probeWalIndex(db, path);
  if (probe.state !== 'poisoned') return db;
  // Release the handle's mmap of `-shm` before the sidecars are rebuilt: our own
  // live connection would otherwise be the peer that blocks the exclusive proof.
  db.close();
  if (!rebuildSidecarsExclusively(path)) throw new WalIndexPoisonError(path, probe.cause);
  return open();
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
    db.transaction(() => {
      step.apply(db);
      db.exec(`PRAGMA user_version = ${step.to}`);
    })();
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
    const chain = planMigrationChain(version, opts);
    if (chain !== null) {
      // Declined, not performed: the caller only wanted to look.
      if (opts.migrate === false) throw new PendingMigrationError(path, version, schemaVersion);
      // The caller's last chance to take a backup. A throw here aborts with the
      // database untouched, because no step has run yet.
      opts.beforeMigrate?.({ db, path, from: version, to: schemaVersion });
      applyMigrationChain(db, chain, opts);
      // Deliberate fall-through, not a second open: a database the ladder just
      // brought to `schemaVersion` must receive the same additive backfills as
      // one that was already there. Returning here instead left a migrated
      // database permanently short of them.
      if (!schemaIsCurrent || !schemaIsCurrent(db)) ensureSchema(db);
      return;
    }
    throw new ForeignDbError(path, version, schemaVersion, 'no migration path from this schema version');
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
