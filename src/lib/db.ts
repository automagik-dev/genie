/**
 * Database connection management for Genie.
 *
 * The daemon owns pgserve. CLI commands read the port file and connect.
 * If no daemon is running, the CLI auto-starts it.
 * Self-healing: health checks on every connection, automatic recovery.
 */

import { type ChildProcess, execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
  // Already connected in this process
  if (activePort !== null) return activePort;

  const port = getPort();

  // 1. Read port file — daemon or another genie process may have written it
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

  // 3. No healthy PG found — spawn pgserve as a child process.
  //    This replaces the old approach of embedding the MultiTenantRouter proxy
  //    in-process, which caused self-referencing deadlocks under load.
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

/** Resolve the pgserve CLI binary path. */
function findPgserveBin(): string {
  const globalBin = join(homedir(), '.bun', 'bin', 'pgserve');
  if (existsSync(globalBin)) return globalBin;
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
    ['--port', String(port), '--host', DEFAULT_HOST, '--data', DATA_DIR, '--log', 'warn', '--no-stats', '--no-cluster'],
    { detached: true, stdio: 'ignore' },
  );

  child.unref();
  pgserveChild = child;

  const deadline = Date.now() + 15000;
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
  throw new Error(`pgserve failed to start on port ${port} (timeout after 15s)`);
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
