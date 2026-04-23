/**
 * Database connection management for Genie.
 *
 * `genie serve` owns pgserve. CLI commands read the port file and connect.
 * If no serve process is running, the CLI auto-starts `genie serve --headless`.
 * Self-healing: health checks on every connection, automatic recovery.
 */

import { type ChildProcess, execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { runMigrations } from './db-migrations.js';
import { needsSeed, runSeed } from './pg-seed.js';
import { getProcessStartTime } from './process-identity.js';

/**
 * Re-export Sql type for callers that need to annotate sql connection parameters.
 * getConnection() returns `any` internally due to postgres.js generic complexity,
 * but callers can use this type for function signatures.
 */
export type Sql = postgres.Sql;

const DEFAULT_PORT = 19642;
const DEFAULT_HOST = '127.0.0.1';
const GENIE_HOME = process.env.GENIE_HOME ?? join(homedir(), '.genie');
const DATA_DIR = join(GENIE_HOME, 'data', 'pgserve');
const LOCKFILE_PATH = join(GENIE_HOME, 'pgserve.port');
const DB_NAME = 'genie';

/** Sanitize connection URLs for logging — never expose credentials */
function maskCredentials(url: string): string {
  return url.replace(/\/\/.*@/, '//***@');
}

/**
 * Detect whether pgserve would refuse to start because the current process
 * is running as uid 0 (root). PostgreSQL aborts with
 *   "root" execution of the PostgreSQL server is not permitted
 * at the binary level, which surfaces in the CLI as a misleading 16s timeout
 * with tmux/scheduler cascade errors (issue #1226). Failing fast up front
 * gives the user the real reason.
 *
 * Returns a user-facing error message if the guard should fire, or null if
 * startup should proceed. `GENIE_ALLOW_ROOT=1` bypasses the guard (pgserve
 * will still fail at the postgres binary level, but the real error is then
 * surfaced immediately from the child process).
 */
export function checkRootGuard(): string | null {
  const uid = process.getuid?.();
  if (uid !== 0) return null;
  if (process.env.GENIE_ALLOW_ROOT === '1') return null;
  return (
    'pgserve cannot start under uid 0 (root) — PostgreSQL refuses to run as root for security reasons. ' +
    'Run genie as a non-root user, or set GENIE_ALLOW_ROOT=1 to attempt anyway. ' +
    'See: https://github.com/automagik-dev/genie/issues/1226'
  );
}

/**
 * Self-heal: kill stale postgres processes, clean shared memory, remove stale PID files.
 * Handles zombies (which can't be killed) by cleaning their artifacts instead.
 */
function selfHealPostgres(dataDir: string): void {
  try {
    // Kill any stale postgres processes associated with pgserve data dir
    execSync(`pkill -9 -f "postgres.*${dataDir.replace(/\//g, '\\/')}" 2>/dev/null || true`, {
      stdio: 'ignore',
      timeout: 5000,
    });
    // Also kill stale pgserve router/wrapper processes on the same data dir
    execSync(`pkill -9 -f "pgserve.*${dataDir.replace(/\//g, '\\/')}" 2>/dev/null || true`, {
      stdio: 'ignore',
      timeout: 5000,
    });
  } catch {
    // Best effort
  }

  // Remove stale postmaster.pid
  const pidFile = join(dataDir, 'postmaster.pid');
  if (existsSync(pidFile)) {
    try {
      unlinkSync(pidFile);
    } catch {
      // May still be locked
    }
  }

  // Clean stale shared memory segments owned by this user
  try {
    execSync("ipcs -m 2>/dev/null | awk '$6 == 0 {print $2}' | xargs -I{} ipcrm -m {} 2>/dev/null || true", {
      stdio: 'ignore',
      timeout: 5000,
    });
  } catch {
    // Best effort
  }
}

/** Resolved port from env or default */
function getPort(): number {
  const envPort = process.env.GENIE_PG_PORT;
  if (envPort) {
    const parsed = Number.parseInt(envPort, 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  return DEFAULT_PORT;
}

/** Health check: actually connect to postgres and run SELECT 1.
 *  Uses Promise.race with a hard 4s timeout so a proxy that accepts TCP
 *  but never forwards the postgres protocol cannot hang forever.
 *  The timeout timer is unref'd so it does not hold the event loop open
 *  when the health check resolves first.
 */
async function isPostgresHealthy(port: number): Promise<boolean> {
  try {
    return await Promise.race([
      (async () => {
        const pg = (await import('postgres')).default;
        const probe = pg({
          host: DEFAULT_HOST,
          port,
          database: DB_NAME,
          username: 'postgres',
          password: 'postgres',
          max: 1,
          connect_timeout: 3,
          idle_timeout: 1,
        });
        try {
          await probe`SELECT 1`;
          await probe.end({ timeout: 2 });
          return true;
        } catch {
          try {
            await probe.end({ timeout: 1 });
          } catch {
            /* ignore */
          }
          return false;
        }
      })(),
      new Promise<false>((resolve) => {
        const t = setTimeout(() => resolve(false), 4000);
        t.unref();
      }),
    ]);
  } catch {
    return false;
  }
}

/** Read port from lockfile. Returns null if lockfile missing or invalid. */
function readLockfile(): number | null {
  try {
    const content = readFileSync(LOCKFILE_PATH, 'utf-8').trim();
    const port = Number.parseInt(content, 10);
    if (!Number.isNaN(port) && port > 0 && port < 65536) return port;
  } catch {
    // File doesn't exist or can't be read
  }
  return null;
}

/** Atomically write port to lockfile (write .tmp then rename). */
function writeLockfile(port: number): void {
  try {
    mkdirSync(GENIE_HOME, { recursive: true });
    const tmpPath = `${LOCKFILE_PATH}.tmp.${process.pid}`;
    writeFileSync(tmpPath, String(port), 'utf-8');
    renameSync(tmpPath, LOCKFILE_PATH);
  } catch {
    // Best effort — lockfile is an optimization, not required
  }
}

/** Remove lockfile if it exists. */
function removeLockfile(): void {
  try {
    unlinkSync(LOCKFILE_PATH);
  } catch {
    // Already gone or never existed
  }
}

// Module-level singleton state
let pgserveChild: ChildProcess | null = null;
// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type requires generics we don't need
let sqlClient: any = null;
let activePort: number | null = null;
let ensurePromise: Promise<number> | null = null;
/**
 * Dedup concurrent rebuilds of sqlClient. N parallel getConnection() callers
 * observing a null/stale client would each race pgModule(...) and leak pools.
 * biome-ignore lint/suspicious/noExplicitAny: shared with sqlClient
 */
// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type requires generics we don't need
let buildPromise: Promise<any> | null = null;
/** Whether this process spawned pgserve (and thus owns the lockfile) */
let ownsLockfile = false;
let exitHandlerRegistered = false;
/** Whether retention cleanup has already run in this process */
let retentionRan = false;

/** Prune old rows from unbounded tables. Runs once per process, non-fatal. */
async function runRetention(sql: postgres.Sql): Promise<void> {
  try {
    await sql.unsafe(`
      DELETE FROM heartbeats WHERE created_at < now() - interval '7 days';
      DELETE FROM machine_snapshots WHERE created_at < now() - interval '30 days';
      DELETE FROM audit_events WHERE entity_type LIKE 'otel_%' AND created_at < now() - interval '30 days';
      DELETE FROM genie_runtime_events WHERE created_at < now() - interval '14 days';
    `);
    retentionRan = true;
  } catch (retErr) {
    // Non-fatal — log warning and continue, never block startup
    retentionRan = true; // Don't retry on next call
    const msg = retErr instanceof Error ? retErr.message : String(retErr);
    process.stderr.write(`[genie] retention cleanup warning: ${msg}\n`);
  }
}

/**
 * Ensure pgserve is running. Starts it if not already listening.
 * Idempotent — safe to call multiple times.
 *
 * Returns the port pgserve is listening on.
 */
export async function ensurePgserve(): Promise<number> {
  // Test mode short-circuit — src/lib/test-setup.ts (bun preload) starts a
  // dedicated pgserve --ram on a non-production port and exports
  // GENIE_TEST_PG_PORT. Honoring it here means tests never touch the
  // production daemon or ~/.genie/data/pgserve. When the env var is unset,
  // this returns null and production paths run unchanged.
  if (activePort === null) {
    const testPort = await resolveTestPort();
    if (testPort !== null) {
      activePort = testPort;
      process.env.GENIE_PG_AVAILABLE = 'true';
      return testPort;
    }
  }

  // Deduplicate concurrent calls
  if (ensurePromise) return ensurePromise;

  ensurePromise = _ensurePgserve();
  try {
    return await ensurePromise;
  } finally {
    ensurePromise = null;
  }
}

/**
 * Outcome of the most recent autoStartDaemon() call. Consumed by the branched
 * timeout error in _ensurePgserve so the user gets a message naming the
 * actual failure mode instead of a generic timeout.
 *
 *   - `missing`   — serve.pid absent; spawned a fresh serve
 *   - `stale`     — serve.pid existed but its PID was recycled or dead;
 *                   unlinked the file and spawned a fresh serve
 *   - `alive`     — serve.pid points at a live serve process whose kernel
 *                   start time still matches; did NOT respawn
 *
 * A module-level variable is acceptable here because autoStartDaemon is only
 * called from the single-flight _ensurePgserve path (guarded by ensurePromise).
 */
type AutoStartOutcome = 'missing' | 'stale' | 'alive';
let lastAutoStartOutcome: AutoStartOutcome | null = null;
/** PID that was in serve.pid at the time of the most recent autoStartDaemon() call. */
let lastAutoStartPid: number | null = null;

/**
 * Spawn `genie serve start --headless` in the background.
 * Overridable for tests via {@link __setSpawnDaemonForTest}.
 */
let spawnDaemon: () => void = () => {
  const bunPath = process.execPath ?? 'bun';
  const genieBin = process.argv[1] ?? 'genie';
  const child = spawn(bunPath, [genieBin, 'serve', 'start', '--headless'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
};

/** Test-only hook: swap the spawn implementation so tests don't launch real serves. */
export function __setSpawnDaemonForTest(fn: (() => void) | null): void {
  spawnDaemon =
    fn ??
    (() => {
      const bunPath = process.execPath ?? 'bun';
      const genieBin = process.argv[1] ?? 'genie';
      const child = spawn(bunPath, [genieBin, 'serve', 'start', '--headless'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
      child.unref();
    });
}

/**
 * Auto-start genie serve (headless) if it is not already running, validating
 * PID identity so a recycled PID can't masquerade as a live serve.
 *
 * Format of `~/.genie/serve.pid`:
 *   `{pid}:{startTime}` — new format written by writeServePid
 *   `{pid}`             — legacy format (always treated as stale on read)
 *
 * A file is considered "live" only if BOTH:
 *   - `process.kill(pid, 0)` succeeds (PID exists), AND
 *   - `getProcessStartTime(pid)` returns the exact string recorded in the file
 *
 * Any other state → treat as stale, unlink, spawn fresh.
 */
function readPidFile(pidPath: string): string | null {
  try {
    return readFileSync(pidPath, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

function parsePidFile(raw: string): { pid: number; recordedStartTime: string | null } | null {
  const sepIdx = raw.indexOf(':');
  let pid: number;
  let recordedStartTime: string | null;
  if (sepIdx < 0) {
    pid = Number.parseInt(raw, 10);
    recordedStartTime = null;
  } else {
    pid = Number.parseInt(raw.slice(0, sepIdx), 10);
    const tail = raw.slice(sepIdx + 1).trim();
    recordedStartTime = tail === '' || tail === 'unknown' ? null : tail;
  }
  if (Number.isNaN(pid) || pid <= 0) return null;
  return { pid, recordedStartTime };
}

function isServeAlive(pid: number, recordedStartTime: string | null): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (recordedStartTime === null) return false;
  const currentStartTime = getProcessStartTime(pid);
  return currentStartTime !== null && currentStartTime === recordedStartTime;
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

export async function autoStartDaemon(): Promise<void> {
  const home = process.env.GENIE_HOME ?? GENIE_HOME;
  const pidPath = join(home, 'serve.pid');
  const raw = readPidFile(pidPath);

  if (!raw) {
    lastAutoStartOutcome = 'missing';
    lastAutoStartPid = null;
    spawnDaemon();
    return;
  }

  const parsed = parsePidFile(raw);
  if (!parsed) {
    unlinkQuiet(pidPath);
    lastAutoStartOutcome = 'stale';
    lastAutoStartPid = null;
    spawnDaemon();
    return;
  }

  if (isServeAlive(parsed.pid, parsed.recordedStartTime)) {
    lastAutoStartOutcome = 'alive';
    lastAutoStartPid = parsed.pid;
    return;
  }

  unlinkQuiet(pidPath);
  lastAutoStartOutcome = 'stale';
  lastAutoStartPid = parsed.pid;
  spawnDaemon();
}

/**
 * Test mode short-circuit — `src/lib/test-setup.ts` (bun preload) starts a
 * dedicated `pgserve --ram` on a non-production port and exports
 * `GENIE_TEST_PG_PORT`. Returns the port if set and reachable; returns null
 * when the env var is unset so production paths run unchanged.
 */
async function resolveTestPort(): Promise<number | null> {
  const raw = process.env.GENIE_TEST_PG_PORT;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed >= 65536 || !(await isPostgresHealthy(parsed))) {
    throw new Error(`GENIE_TEST_PG_PORT=${raw} set but not reachable`);
  }
  return parsed;
}

async function tryExistingPort(port: number): Promise<number | null> {
  const portFromFile = readLockfile();
  if (portFromFile !== null && (await isPostgresHealthy(portFromFile))) {
    activePort = portFromFile;
    process.env.GENIE_PG_AVAILABLE = 'true';
    return portFromFile;
  }
  if (await isPostgresHealthy(port)) {
    activePort = port;
    process.env.GENIE_PG_AVAILABLE = 'true';
    writeLockfile(port);
    return port;
  }
  return null;
}

async function spawnPgserveDirect(port: number): Promise<number> {
  mkdirSync(DATA_DIR, { recursive: true });
  selfHealPostgres(DATA_DIR);
  try {
    const startedPort = await startPgserveOnPort(port);
    registerExitHandler();
    return startedPort;
  } catch (err) {
    process.env.GENIE_PG_AVAILABLE = 'false';
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`pgserve failed to start: ${maskCredentials(message)}`);
  }
}

async function waitForDaemonPort(): Promise<number | null> {
  const deadline = Date.now() + 16000;
  while (Date.now() < deadline) {
    const p = readLockfile();
    if (p !== null && (await isPostgresHealthy(p))) {
      activePort = p;
      process.env.GENIE_PG_AVAILABLE = 'true';
      return p;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function throwDaemonTimeout(outcomeAtStart: typeof lastAutoStartOutcome, pidAtStart: typeof lastAutoStartPid): never {
  process.env.GENIE_PG_AVAILABLE = 'false';
  const home = process.env.GENIE_HOME ?? GENIE_HOME;
  const pidPath = join(home, 'serve.pid');
  const hasPidFile = existsSync(pidPath);
  const currentPort = readLockfile() ?? getPort();
  if (outcomeAtStart === 'stale') {
    throw new Error(
      `Stale ~/.genie/serve.pid (PID ${pidAtStart ?? 'unknown'} was not our serve). Removed and retried — if this persists, run: genie serve start`,
    );
  }
  if (!hasPidFile) {
    throw new Error('genie serve not running. Run: genie serve start');
  }
  const pidLabel = pidAtStart ?? outcomeAtStart ?? 'unknown';
  throw new Error(
    `genie serve is running (PID ${pidLabel}) but pgserve did not respond on port ${currentPort} within 16s. Try: genie serve restart, or check ~/.genie/logs/scheduler.log`,
  );
}

async function _ensurePgserve(): Promise<number> {
  if (activePort !== null) return activePort;

  const port = getPort();
  const existing = await tryExistingPort(port);
  if (existing !== null) return existing;

  if (process.env.CI === 'true') {
    process.env.GENIE_PG_AVAILABLE = 'false';
    throw new Error('pgserve not available in CI');
  }

  const rootErr = checkRootGuard();
  if (rootErr !== null) {
    process.env.GENIE_PG_AVAILABLE = 'false';
    throw new Error(rootErr);
  }

  if (process.env.GENIE_IS_DAEMON === '1') {
    return spawnPgserveDirect(port);
  }

  await autoStartDaemon();
  const outcomeAtStart = lastAutoStartOutcome;
  const pidAtStart = lastAutoStartPid;
  const waited = await waitForDaemonPort();
  if (waited !== null) return waited;
  throwDaemonTimeout(outcomeAtStart, pidAtStart);
}

/** Resolve the pgserve CLI binary path — checks local dep, global, then PATH. */
function findPgserveBin(): string {
  // 1. Local node_modules (pgserve is a dependency)
  try {
    const resolved = require.resolve('pgserve/bin/pgserve-wrapper.cjs');
    if (existsSync(resolved)) return resolved;
  } catch {
    /* not found locally */
  }
  // 2. Global bun install
  const globalBin = join(homedir(), '.bun', 'bin', 'pgserve');
  if (existsSync(globalBin)) return globalBin;
  // 3. PATH
  try {
    return execSync('which pgserve', { encoding: 'utf-8', timeout: 3000 }).trim();
  } catch {
    return 'pgserve';
  }
}

/**
 * Start pgserve as a separate child process (like omni does).
 * Avoids the self-referencing proxy deadlock that occurs when the
 * MultiTenantRouter Bun TCP proxy runs in the same event loop as
 * the daemon that also connects to it.
 */
async function startPgserveOnPort(port: number): Promise<number> {
  mkdirSync(DATA_DIR, { recursive: true });

  const child = spawn(
    findPgserveBin(),
    [
      '--port',
      String(port),
      '--host',
      DEFAULT_HOST,
      '--data',
      DATA_DIR,
      '--log',
      'warn',
      '--no-stats',
      '--no-cluster',
      '--pgvector',
    ],
    { detached: true, stdio: 'ignore' },
  );

  child.unref();
  pgserveChild = child;

  const timeout = Number(process.env.GENIE_PGSERVE_TIMEOUT) || 30000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await isPostgresHealthy(port)) {
      activePort = port;
      ownsLockfile = true;
      process.env.GENIE_PG_AVAILABLE = 'true';
      writeLockfile(port);
      return port;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  try {
    child.kill('SIGTERM');
  } catch {
    /* dead */
  }
  throw new Error(`pgserve failed to start on port ${port} (timeout after ${timeout / 1000}s)`);
}

/** Register process exit handler to clean up lockfile (once). */
function registerExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;

  const cleanup = () => {
    if (pgserveChild) {
      try {
        pgserveChild.kill('SIGTERM');
      } catch {
        /* dead */
      }
      pgserveChild = null;
    }
    if (ownsLockfile) {
      removeLockfile();
      ownsLockfile = false;
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
}

// Migration marker file is legacy — kept for backward compat but no longer used for skip logic.
// The migration runner (db-migrations.ts) checks _genie_migrations table directly.

/**
 * Get a postgres.js connection. Lazy singleton — calls ensurePgserve() on first use.
 * Returns a postgres.js sql tagged template client.
 *
 * When GENIE_TEST_DB_NAME is set, connections use that database instead of `genie`.
 * DB-level isolation (one DB per test, cloned from `genie_template`) replaces the
 * previous schema-level isolation.
 */
/** Health-check the cached client. Returns it if alive, or resets and returns null.
 *
 * Mirrors the `resetConnection()` null-before-end pattern (commit 74aaa022): the
 * global reference is cleared first so concurrent callers rebuild a fresh client
 * instead of racing on the dying one. The teardown itself is fire-and-forget so
 * concurrent in-flight queries on the shared pool are not killed synchronously
 * with CONNECTION_ENDED. See issue #1207.
 */
async function healthCheckCachedClient() {
  if (!sqlClient) return null;
  try {
    await sqlClient`SELECT 1`;
    return sqlClient;
  } catch {
    // Concurrency race: two callers can reach this catch simultaneously.
    // Thread A runs `dying = sqlClient; sqlClient = null;` then enters `end()`.
    // Thread B's catch block then reads `sqlClient` as null; calling
    // `dying.end()` crashes with `null is not an object (evaluating 'dying.end')`.
    // Capture the reference AND null-check it before teardown.
    const dying = sqlClient;
    if (!dying) return null;
    sqlClient = null;
    activePort = null;
    // Fire-and-forget teardown — do not await. Concurrent callers holding the
    // `dying` reference (via closures, iterators, in-flight Promises) will
    // finish their current operation; the pool's internal connection reaper
    // handles final cleanup. Awaiting here would cause CONNECTION_ENDED on
    // queries that are still in flight from other callers.
    dying.end({ timeout: 5 }).catch(() => {
      /* ignore — teardown is best-effort */
    });
    return null;
  }
}

/** Run post-connect setup (migrations, seed, retention). Skipped in test mode. */
async function runPostConnectSetup(client: postgres.Sql, isTestMode: boolean, timings: { t0: number; t1: number }) {
  const _t2 = Date.now();
  if (!isTestMode) await runMigrations(client);
  const _t3 = Date.now();

  if (!isTestMode && needsSeed()) await runSeed(client);
  const _t4 = Date.now();

  if (!isTestMode && !retentionRan) await runRetention(client);
  const _t5 = Date.now();

  if (process.env.GENIE_PROFILE_DB) {
    console.error(
      `[db-profile] pgserve=${timings.t1 - timings.t0}ms migrate=${_t3 - _t2}ms seed=${_t4 - _t3}ms retention=${_t5 - _t4}ms total=${_t5 - timings.t0}ms`,
    );
  }
}

export async function getConnection() {
  const cached = await healthCheckCachedClient();
  if (cached) return cached;

  // Dedup concurrent rebuilds. Without this, N parallel callers (e.g.
  // workDispatchCommand fan-out in `genie work <slug>` when a wave has
  // ≥2 parallel groups) each race pgModule(...) and overwrite sqlClient,
  // leaking pools and triggering CONNECTION_ENDED on the orphaned ones.
  // See issue #1207.
  if (buildPromise) return buildPromise;

  buildPromise = _buildConnection();
  try {
    return await buildPromise;
  } finally {
    buildPromise = null;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type requires generics we don't need
async function _buildConnection(): Promise<any> {
  const _t0 = Date.now();
  const port = await ensurePgserve();
  const _t1 = Date.now();
  const pgModule = (await import('postgres')).default;

  // Per-test isolation now happens at the DATABASE level — setupTestDatabase()
  // clones `genie_template` and sets GENIE_TEST_DB_NAME. In production, this
  // env var is never set, so we fall back to DB_NAME ('genie').
  const testDbName = process.env.GENIE_TEST_DB_NAME;
  const database = testDbName && testDbName.length > 0 ? testDbName : DB_NAME;
  const isTestMode = Boolean(testDbName);
  sqlClient = pgModule({
    host: DEFAULT_HOST,
    port,
    database,
    username: 'postgres',
    password: 'postgres',
    max: 50,
    idle_timeout: 1,
    connect_timeout: 5,
    onnotice: () => {},
    connection: {
      client_min_messages: 'warning',
    },
  });

  try {
    await runPostConnectSetup(sqlClient, isTestMode, { t0: _t0, t1: _t1 });
  } catch (err) {
    const dying = sqlClient;
    sqlClient = null;
    activePort = null;
    // Fire-and-forget teardown — match healthCheckCachedClient so we never
    // block on a dying pool while other work is in flight.
    dying?.end({ timeout: 2 }).catch(() => {
      /* ignore */
    });
    throw err;
  }

  return sqlClient;
}

/**
 * Check if DB is already connected (for guard checks without triggering startup).
 */
export function isConnected(): boolean {
  return sqlClient !== null;
}

/**
 * Reset the connection singleton. Next call to getConnection() creates a fresh client.
 * Used by test helpers to switch schemas between test runs.
 */
export async function resetConnection(): Promise<void> {
  if (sqlClient) {
    const dying = sqlClient;
    sqlClient = null;
    await dying.end({ timeout: 5 });
  }
}

/**
 * Non-throwing health check. Returns true if pgserve is reachable and responds to queries.
 */
export async function isAvailable(): Promise<boolean> {
  try {
    const sql = await getConnection();
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * Graceful close of the connection pool. Does NOT stop pgserve —
 * it persists for other genie processes.
 * Cleans up lockfile if this process owns it.
 */
export async function shutdown(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = null;
  }
  if (ownsLockfile) {
    removeLockfile();
    ownsLockfile = false;
  }
}

/**
 * Get the data directory path (for display / diagnostics).
 */
export function getDataDir(): string {
  return DATA_DIR;
}

/**
 * Get the currently active port (or the configured default if not yet started).
 */
export function getActivePort(): number {
  return activePort ?? getPort();
}

/**
 * Get the lockfile path (for diagnostics / testing).
 */
export function getLockfilePath(): string {
  return LOCKFILE_PATH;
}
