/**
 * Database connection management for Genie.
 *
 * Embeds pgserve (PostgreSQL) as a persistent brain. One instance per machine
 * on port 19642, auto-started on demand. Connection is a lazy singleton —
 * pgserve only starts when something actually needs the database.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MultiTenantRouter } from 'pgserve';
import { runMigrations } from './db-migrations.js';

const DEFAULT_PORT = 19642;
const DEFAULT_HOST = '127.0.0.1';
const MAX_PORT_RETRIES = 10;
const DATA_DIR = join(process.env.GENIE_HOME ?? join(homedir(), '.genie'), 'data', 'pgserve');
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

// Module-level singleton state
let pgserveServer: MultiTenantRouter | null = null;
// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type requires generics we don't need
let sqlClient: any = null;
let activePort: number | null = null;
let ensurePromise: Promise<number> | null = null;

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
  const port = getPort();

  // Already started by us in this process
  if (activePort === port && pgserveServer) {
    return port;
  }

  // Check if pgserve (or another genie process) is already listening
  if (await isPortListening(port, DEFAULT_HOST)) {
    activePort = port;
    process.env.GENIE_PG_AVAILABLE = 'true';
    return port;
  }

  // Ensure data directory exists
  mkdirSync(DATA_DIR, { recursive: true });

  // Clean up orphaned postgres from a previous crash
  killOrphanedPostgres(DATA_DIR);

  // Start pgserve
  try {
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
    process.env.GENIE_PG_AVAILABLE = 'true';
    return port;
  } catch (err) {
    // Port may have been taken between check and start — try auto-increment
    for (let offset = 1; offset <= MAX_PORT_RETRIES; offset++) {
      const fallbackPort = port + offset;
      if (await isPortListening(fallbackPort, DEFAULT_HOST)) {
        activePort = fallbackPort;
        process.env.GENIE_PG_AVAILABLE = 'true';
        return fallbackPort;
      }
      try {
        const { startMultiTenantServer } = await import('pgserve');
        const server = await startMultiTenantServer({
          port: fallbackPort,
          host: DEFAULT_HOST,
          baseDir: DATA_DIR,
          logLevel: 'warn',
          autoProvision: true,
        });
        pgserveServer = server;
        activePort = fallbackPort;
        process.env.GENIE_PG_AVAILABLE = 'true';
        return fallbackPort;
      } catch {
        // Try next port
      }
    }

    // All attempts failed
    process.env.GENIE_PG_AVAILABLE = 'false';
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: pgserve failed to start: ${maskCredentials(message)}`);
    throw new Error(
      `pgserve failed to start on port ${port} (and fallbacks ${port + 1}-${port + MAX_PORT_RETRIES}): ${maskCredentials(message)}`,
    );
  }
}

/**
 * Get a postgres.js connection. Lazy singleton — calls ensurePgserve() on first use.
 * Returns a postgres.js sql tagged template client.
 */
export async function getConnection() {
  if (sqlClient) return sqlClient;

  const port = await ensurePgserve();
  const postgres = (await import('postgres')).default;

  sqlClient = postgres({
    host: DEFAULT_HOST,
    port,
    database: DB_NAME,
    username: 'postgres',
    password: 'postgres',
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
  });

  // Run pending migrations on first connect
  await runMigrations(sqlClient);

  return sqlClient;
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
 */
export async function shutdown(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = null;
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
