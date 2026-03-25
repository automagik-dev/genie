/**
 * Database connection management for Genie.
 *
 * Embeds pgserve (PostgreSQL) as a persistent brain. One instance per machine
 * on port 19642, auto-started on demand. Connection is a lazy singleton —
 * pgserve only starts when something actually needs the database.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MultiTenantRouter } from 'pgserve';
import { runMigrations } from './db-migrations.js';

const DEFAULT_PORT = 19642;
const DEFAULT_HOST = '127.0.0.1';
const MAX_PORT_RETRIES = 3;
const GENIE_HOME = process.env.GENIE_HOME ?? join(homedir(), '.genie');
const DATA_DIR = join(GENIE_HOME, 'data', 'pgserve');
const LOCKFILE_PATH = join(GENIE_HOME, 'pgserve.port');
const MIGRATION_MARKER = join(GENIE_HOME, 'pgserve.migrated');
const DB_NAME = 'genie';

/** Sanitize connection URLs for logging — never expose credentials */
function maskCredentials(url: string): string {
  return url.replace(/\/\/.*@/, '//***@');
}

/**
 * Kill orphaned postgres processes from a previous crash.
 * Reads postmaster.pid from data dir, verifies PID is actually postgres,
 * sends SIGTERM → waits 5s → SIGKILL if still alive.
 */
function killOrphanedPostgres(dataDir: string): void {
  const pidFile = join(dataDir, 'postmaster.pid');
  if (!existsSync(pidFile)) return;

  try {
    const content = readFileSync(pidFile, 'utf-8');
    const pid = Number.parseInt(content.split('\n')[0], 10);
    if (Number.isNaN(pid) || pid <= 0) return;

    // Verify PID is actually a postgres process
    let cmdline: string;
    try {
      cmdline = execSync(`ps -o command= -p ${pid} 2>/dev/null`, { encoding: 'utf-8' }).trim();
    } catch {
      // Process doesn't exist — stale pid file, safe to ignore
      return;
    }

    if (!cmdline.includes('postgres')) return;

    // SIGTERM first (graceful)
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return; // Already dead
    }

    // Wait up to 5s for graceful shutdown
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0); // Check if alive
        execSync('sleep 0.2', { stdio: 'ignore' });
      } catch {
        return; // Process exited
      }
    }

    // SIGKILL if still alive
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already dead
    }
  } catch {
    // Best effort — don't block startup on cleanup failures
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

/** Check if a TCP port is already listening */
function isPortListening(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
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

async function _ensurePgserve(): Promise<number> {
  // Already started by us in this process
  if (activePort !== null && pgserveServer) {
    return activePort;
  }
  // Already connected (reuse from previous call in same process)
  if (activePort !== null) {
    return activePort;
  }

  const port = getPort();

  // 1. Check lockfile — another genie process may have started pgserve (fast path, no imports)
  const reusedPort = await tryReuseLockfile();
  if (reusedPort !== null) return reusedPort;

  // 2. Check default port (may be started externally without lockfile)
  if (await isPortListening(port, DEFAULT_HOST)) {
    return markPortActive(port, true);
  }

  // 3. Start pgserve ourselves (slow path — only when no existing instance)
  mkdirSync(DATA_DIR, { recursive: true });
  killOrphanedPostgres(DATA_DIR);

  try {
    const startedPort = await startPgserveOnPort(port);
    registerExitHandler();
    return startedPort;
  } catch (err) {
    return tryFallbackPorts(port, err);
  }
}

/** Try to reuse a port from an existing lockfile. Returns port or null. */
async function tryReuseLockfile(): Promise<number | null> {
  const lockfilePort = readLockfile();
  if (lockfilePort === null) return null;

  if (await isPortListening(lockfilePort, DEFAULT_HOST)) {
    return markPortActive(lockfilePort, false);
  }
  // Stale lockfile — port not listening
  removeLockfile();
  return null;
}

/** Mark a port as active and optionally write lockfile. */
function markPortActive(port: number, writeLock: boolean): number {
  activePort = port;
  process.env.GENIE_PG_AVAILABLE = 'true';
  if (writeLock) writeLockfile(port);
  return port;
}

/** Try fallback ports when primary fails. */
async function tryFallbackPorts(basePort: number, originalErr: unknown): Promise<number> {
  for (let offset = 1; offset <= MAX_PORT_RETRIES; offset++) {
    const fallbackPort = basePort + offset;
    if (await isPortListening(fallbackPort, DEFAULT_HOST)) {
      return markPortActive(fallbackPort, true);
    }
    try {
      const startedPort = await startPgserveOnPort(fallbackPort);
      registerExitHandler();
      return startedPort;
    } catch {
      // Try next port
    }
  }

  process.env.GENIE_PG_AVAILABLE = 'false';
  const message = originalErr instanceof Error ? originalErr.message : String(originalErr);
  console.warn(`Warning: pgserve failed to start: ${maskCredentials(message)}`);
  throw new Error(
    `pgserve failed to start on port ${basePort} (and fallbacks ${basePort + 1}-${basePort + MAX_PORT_RETRIES}): ${maskCredentials(message)}`,
  );
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

/**
 * Check if migrations have already been applied (marker file).
 * The marker stores the version so we re-run on upgrades.
 */
function migrationsDone(): boolean {
  try {
    const marker = readFileSync(MIGRATION_MARKER, 'utf-8').trim();
    // Re-run migrations if the genie version changed
    const currentVersion = process.env.npm_package_version ?? '';
    return marker === currentVersion || (currentVersion === '' && marker.length > 0);
  } catch {
    return false;
  }
}

function markMigrationsDone(): void {
  try {
    const version = process.env.npm_package_version ?? Date.now().toString();
    writeFileSync(MIGRATION_MARKER, version, 'utf-8');
  } catch {
    // Best effort
  }
}

/**
 * Get a postgres.js connection. Lazy singleton — calls ensurePgserve() on first use.
 * Returns a postgres.js sql tagged template client.
 *
 * When GENIE_TEST_SCHEMA is set, all connections use that schema in their search_path.
 * This isolates test data from production tables.
 */
export async function getConnection() {
  if (sqlClient) return sqlClient;

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
    ...(testSchema ? { connection: { search_path: `${testSchema}, public` } } : {}),
  });

  // Only run migrations if not yet applied for this version
  if (!migrationsDone()) {
    await runMigrations(sqlClient);
    markMigrationsDone();
  }

  return sqlClient;
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
