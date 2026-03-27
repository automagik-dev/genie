/**
 * Database connection management for Genie.
 *
 * The daemon owns pgserve. CLI commands read the port file and connect.
 * If no daemon is running, the CLI auto-starts it.
 * Self-healing: health checks on every connection, automatic recovery.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MultiTenantRouter } from 'pgserve';
import type postgres from 'postgres';
import { runMigrations } from './db-migrations.js';
import { needsSeed, runSeed } from './pg-seed.js';

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

/** Health check: actually connect to postgres and run SELECT 1 */
async function isPostgresHealthy(port: number): Promise<boolean> {
  try {
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
    await probe`SELECT 1`;
    await probe.end({ timeout: 2 });
    return true;
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
let pgserveServer: MultiTenantRouter | null = null;
// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type requires generics we don't need
let sqlClient: any = null;
let activePort: number | null = null;
let ensurePromise: Promise<number> | null = null;
/** Whether this process spawned pgserve (and thus owns the lockfile) */
let ownsLockfile = false;
let exitHandlerRegistered = false;

/**
 * Ensure pgserve is running. Starts it if not already listening.
 * Idempotent — safe to call multiple times.
 *
 * Returns the port pgserve is listening on.
 */
export async function ensurePgserve(): Promise<number> {
  // Deduplicate concurrent calls
  if (ensurePromise) return ensurePromise;

  ensurePromise = _ensurePgserve();
  try {
    return await ensurePromise;
  } finally {
    ensurePromise = null;
  }
}

const DAEMON_PID_PATH = join(GENIE_HOME, 'scheduler.pid');
const DAEMON_BOOT_TIMEOUT_MS = 15000;

async function _ensurePgserve(): Promise<number> {
  // Already connected in this process
  if (activePort !== null) return activePort;

  const port = getPort();

  // 1. Read port file — daemon may have written it
  const portFromFile = readLockfile();
  if (portFromFile !== null && (await isPostgresHealthy(portFromFile))) {
    activePort = portFromFile;
    process.env.GENIE_PG_AVAILABLE = 'true';
    return portFromFile;
  }

  // 2. Check default port (daemon may be running without port file, or external PG)
  if (await isPostgresHealthy(port)) {
    activePort = port;
    process.env.GENIE_PG_AVAILABLE = 'true';
    writeLockfile(port);
    return port;
  }

  // 3. No healthy PG found — is daemon running?
  const daemonRunning = isDaemonRunning();

  if (daemonRunning) {
    // Daemon is running but PG is unhealthy — self-heal: clean up and wait for daemon to recover
    selfHealPostgres(DATA_DIR);
    // Wait for daemon to restart PG and write port file
    const recovered = await waitForPortFile(DAEMON_BOOT_TIMEOUT_MS);
    if (recovered !== null) return recovered;
    // Daemon is stuck — fall through to start pgserve ourselves
  }

  // 4. No daemon running — auto-start daemon in background
  if (!daemonRunning) {
    try {
      execSync('genie daemon start', { stdio: 'ignore', timeout: 5000 });
    } catch {
      // Daemon start may detach and return non-zero; that's OK
    }
    // Wait for port file to appear
    const booted = await waitForPortFile(DAEMON_BOOT_TIMEOUT_MS);
    if (booted !== null) return booted;
  }

  // 5. Last resort: start pgserve directly in this process (backwards compat)
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

/** Check if the genie daemon is running via PID file. */
function isDaemonRunning(): boolean {
  try {
    const pid = Number.parseInt(readFileSync(DAEMON_PID_PATH, 'utf-8').trim(), 10);
    if (Number.isNaN(pid) || pid <= 0) return false;
    process.kill(pid, 0); // Throws if process doesn't exist
    return true;
  } catch {
    return false;
  }
}

/** Wait for port file to appear with a healthy PG behind it. */
async function waitForPortFile(timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = readLockfile();
    if (port !== null && (await isPostgresHealthy(port))) {
      activePort = port;
      process.env.GENIE_PG_AVAILABLE = 'true';
      return port;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** Start pgserve on a specific port, update singleton state and lockfile. */
async function startPgserveOnPort(port: number): Promise<number> {
  const { startMultiTenantServer } = await import('pgserve');
  const server = await startMultiTenantServer({
    port,
    host: DEFAULT_HOST,
    baseDir: DATA_DIR,
    logLevel: 'warn',
    autoProvision: true,
  });
  pgserveServer = server;
  activePort = port;
  ownsLockfile = true;
  process.env.GENIE_PG_AVAILABLE = 'true';
  writeLockfile(port);
  return port;
}

/** Register process exit handler to clean up lockfile (once). */
function registerExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;

  const cleanup = () => {
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
 * When GENIE_TEST_SCHEMA is set, all connections use that schema in their search_path.
 * This isolates test data from production tables.
 */
export async function getConnection() {
  // If we have a cached client, health-check it before returning
  if (sqlClient) {
    try {
      await sqlClient`SELECT 1`;
      return sqlClient;
    } catch {
      // Connection is broken — reset and retry once
      try {
        await sqlClient.end({ timeout: 2 });
      } catch {
        /* ignore */
      }
      sqlClient = null;
      activePort = null;
    }
  }

  const port = await ensurePgserve();
  const postgres = (await import('postgres')).default;

  const testSchema = process.env.GENIE_TEST_SCHEMA;
  sqlClient = postgres({
    host: DEFAULT_HOST,
    port,
    database: DB_NAME,
    username: 'postgres',
    password: 'postgres',
    max: 10,
    idle_timeout: 1,
    connect_timeout: 5,
    onnotice: () => {},
    connection: {
      client_min_messages: 'warning',
      ...(testSchema ? { search_path: `${testSchema}, public` } : {}),
    },
  });

  try {
    // Always call runMigrations — it's idempotent (checks _genie_migrations table)
    await runMigrations(sqlClient);

    // Run idempotent JSON → PG seed if source files exist
    if (!testSchema && needsSeed()) {
      await runSeed(sqlClient);
    }
  } catch (err) {
    // Migration/seed failure — reset client so next call retries
    try {
      await sqlClient.end({ timeout: 2 });
    } catch {
      /* ignore */
    }
    sqlClient = null;
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
    await sqlClient.end({ timeout: 5 });
    sqlClient = null;
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
