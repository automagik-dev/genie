/**
 * Test-only preload hook — boots ONE pgserve daemon per `bun test` run.
 *
 * Wired via `bunfig.toml [test] preload = ["./src/lib/test-setup.ts"]`, so it
 * runs exactly once before any test file is loaded. Subsequent `ensurePgserve()`
 * calls in `db.ts` see `GENIE_TEST_PG_PORT` and short-circuit to the test port.
 *
 * Architecture (single-daemon model):
 *   - ONE pgserve child per `bun test` process, ephemeral storage.
 *     * Linux: `--ram` (pgserve uses /dev/shm internally).
 *     * macOS + `GENIE_TEST_MAC_RAM=1`: `--data /Volumes/genie-test-ram/pgserve`
 *       backed by an hdiutil RAM volume created on first boot (Group 6).
 *     * macOS default: no `--data` flag — pgserve uses its own ephemeral
 *       temp dir managed by pgserve itself (auto-cleaned on child exit).
 *   - After boot, migrations run ONCE into a `genie_template` database.
 *   - Each test calls `createTestDatabase(name)` which issues
 *     `CREATE DATABASE <name> TEMPLATE genie_template` — near-instant clone,
 *     no per-test migration replay.
 *   - Cleanup: `dropTestDatabase(name)` removes the DB. The daemon dies with
 *     the `bun test` process; pgserve cleans its own temp dir.
 *
 * The pgrep-based orphan reap at startup is retained because `bun test` skips
 * `process.on('exit' | 'beforeExit')` hooks — any child we spawn that outlives
 * the runner must be cleaned up on the next run.
 */

import { type ChildProcess, execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

// Test pgserves live on ports 20900-20999 — well clear of:
//   - 19642 (production pgserve public port)
//   - 20642 (production pgserve internal postgres port)
//   - 8432  (pgserve default)
// The range is wide enough to survive parallel test runs on the same host.
const PORT_SCAN_START = 20900;
const PORT_SCAN_END = 20999;
const HOST = '127.0.0.1';
const HEALTH_TIMEOUT_MS = 15_000;
const TEMPLATE_DB_NAME = 'genie_template';
// Shared-daemon lockfile: a pgserve whose lockfile is older than this is
// treated as stale and reaped on the next preload. One hour covers a full
// dev session while keeping leaked daemons from lingering overnight.
const LOCK_MAX_AGE_MS = 60 * 60 * 1000;

// Stable int64 advisory-lock id shared by every worker that touches
// `genie_template`. pgserve serializes `CREATE DATABASE ... TEMPLATE` at the
// PG level via this lock so parallel shards (Group 7) don't trigger the
// "source database is being accessed by other users" race. Derived from
// SHA-256("pg-test-perf:create-db") big-endian first 8 bytes, interpreted as
// a signed int64 (PG's `bigint` is signed). Computed at module load so every
// child that imports test-setup.ts agrees on the same id.
const CREATE_DB_ADVISORY_LOCK_ID: bigint = (() => {
  const digest = createHash('sha256').update('pg-test-perf:create-db').digest();
  return digest.readBigInt64BE(0);
})();

// macOS RAM-disk (Group 6, opt-in via GENIE_TEST_MAC_RAM=1). darwin lacks
// /dev/shm, so APFS fsync latency dominates pgserve IO; a hdiutil-backed RAM
// volume matches Linux --ram throughput. One volume is shared across all test
// daemons on the host — created on first spawn, detached on reap.
const MAC_RAM_VOLUME = 'genie-test-ram';
const MAC_RAM_MOUNT = `/Volumes/${MAC_RAM_VOLUME}`;
const MAC_RAM_DATA_DIR = join(MAC_RAM_MOUNT, 'pgserve');
// 1 GiB at 512-byte sectors = 2,097,152 sectors. Covers the template DB plus
// a handful of cloned per-test DBs with headroom.
const MAC_RAM_SECTORS = 2_097_152;

type PgserveLock = {
  port: number;
  pid: number;
  startedAt: number;
  migrationHash?: string;
};

let child: ChildProcess | null = null;
let activeTestPort: number | null = null;
// Module-scoped admin client bound to the `postgres` maintenance DB. Opened
// once after pgserve is healthy and reused by createTestDatabase /
// dropTestDatabase / buildTemplateDatabase. Previously each call opened and
// closed its own connection (51 test files × 2 calls = ~100 admin TCP
// connections per bun test run). Sharing collapses that to 1.
let sharedAdmin: Awaited<ReturnType<typeof adminConnection>> | null = null;

/** Resolve the pgserve CLI binary — mirrors db.ts findPgserveBin() but standalone. */
function findPgserveBin(): string {
  try {
    const req = createRequire(import.meta.url);
    const resolved = req.resolve('pgserve/bin/pgserve-wrapper.cjs');
    if (existsSync(resolved)) return resolved;
  } catch {
    /* not in local node_modules */
  }
  const globalBin = join(homedir(), '.bun', 'bin', 'pgserve');
  if (existsSync(globalBin)) return globalBin;
  try {
    return execSync('which pgserve', { encoding: 'utf-8', timeout: 3000 }).trim();
  } catch {
    return 'pgserve';
  }
}

/** Minimal postgres health probe — does not import the postgres.js package at module top-level. */
async function isPostgresHealthy(port: number): Promise<boolean> {
  try {
    const pg = (await import('postgres')).default;
    const probe = pg({
      host: HOST,
      port,
      database: 'genie',
      username: 'postgres',
      password: 'postgres', // pragma: allowlist secret — pgserve unauthenticated test default // pragma: allowlist secret — pgserve unauthenticated test default
      max: 1,
      connect_timeout: 3,
      idle_timeout: 1,
      onnotice: () => {},
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
  } catch {
    return false;
  }
}

/**
 * Build the pgserve argv for a given port.
 *
 * Linux with /dev/shm: pass `--ram` (pgserve stores data in /dev/shm).
 * macOS with GENIE_TEST_MAC_RAM=1: pass `--data <ram-disk>/pgserve` so
 * pgserve writes to the hdiutil-backed RAM volume (Group 6).
 * macOS default / no shm: omit `--data` entirely — pgserve defaults to its
 * own ephemeral temp dir (see pgserve/bin/pglite-server.js lines 44-64),
 * and auto-cleans the dir on child exit.
 */
function buildPgserveArgs(port: number, useRam: boolean, dataDir: string | null): string[] {
  const args = ['--port', String(port), '--host', HOST, '--log', 'warn', '--no-stats', '--no-cluster'];
  if (useRam) {
    args.push('--ram');
  } else if (dataDir) {
    args.push('--data', dataDir);
  }
  return args;
}

/** Wait for a pgserve child to become healthy on a port, or give up after HEALTH_TIMEOUT_MS. */
async function waitForHealthy(port: number): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) return false;
    if (await isPostgresHealthy(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Attempt to start pgserve on a single port. Returns true on success, false to try the next port. */
async function tryStartOnPort(port: number, useRam: boolean, dataDir: string | null): Promise<boolean> {
  if (await isPostgresHealthy(port)) return false; // another runner has it — skip
  try {
    child = spawn(findPgserveBin(), buildPgserveArgs(port, useRam, dataDir), {
      stdio: 'ignore',
      detached: false, // child inherits parent process group
    });
    // Without unref() the child handle keeps bun's event loop alive and
    // `bun test` never exits. With unref(), bun can terminate after tests
    // complete — orphan cleanup is handled by reapOrphanedTestPgservers()
    // on the next startup.
    child.unref();
  } catch {
    return false;
  }
  if (await waitForHealthy(port)) return true;

  // Didn't come up — kill and signal failure to the caller.
  try {
    child?.kill('SIGTERM');
  } catch {
    /* best-effort */
  }
  child = null;
  return false;
}

/**
 * Recursively collect all descendant PIDs of a given root. Returns [root, ...children].
 * Used to walk the wrapper → pglite-server → postgres tree when reaping orphans.
 */
function collectDescendants(rootPid: number): number[] {
  const all = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined) break;
    try {
      const out = execSync(`pgrep -P ${pid} 2>/dev/null || true`, { encoding: 'utf-8', timeout: 1000 });
      for (const line of out.split('\n').filter(Boolean)) {
        const childPid = Number.parseInt(line, 10);
        if (!Number.isNaN(childPid) && !all.has(childPid)) {
          all.add(childPid);
          queue.push(childPid);
        }
      }
    } catch {
      /* best-effort */
    }
  }
  return [...all];
}

/** Read a process's parent pid, or null if the process is already gone. */
function readPpid(pid: number): number | null {
  try {
    const out = execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf-8', timeout: 1000 }).trim();
    const parsed = Number.parseInt(out, 10);
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

/** Kill a list of pids with SIGKILL, leaves-first. Best-effort. */
function killPidsLeavesFirst(pids: number[]): void {
  for (const pid of [...pids].reverse()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** Resolve the lockfile path under GENIE_HOME (or ~/.genie). */
function lockFilePath(): string {
  const home = process.env.GENIE_HOME ?? join(homedir(), '.genie');
  return join(home, 'data', 'test-pgserve.lock');
}

/** Read and validate the shared-daemon lockfile; returns null when missing or malformed. */
function readPgserveLock(): PgserveLock | null {
  try {
    const raw = readFileSync(lockFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.port === 'number' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.startedAt === 'number'
    ) {
      const lock: PgserveLock = {
        port: parsed.port,
        pid: parsed.pid,
        startedAt: parsed.startedAt,
      };
      if (typeof parsed.migrationHash === 'string') {
        lock.migrationHash = parsed.migrationHash;
      }
      return lock;
    }
  } catch {
    /* missing or malformed — treat as absent */
  }
  return null;
}

/** Resolve the migrations directory the same way db-migrations.ts does. */
function resolveMigrationsDir(): string | null {
  // Dev layout: src/lib/../db/migrations
  const dev = join(import.meta.dir, '..', 'db', 'migrations');
  if (existsSync(dev)) return dev;
  // Bundled layout: dist/../src/db/migrations
  const bundled = join(dirname(import.meta.dir), 'src', 'db', 'migrations');
  if (existsSync(bundled)) return bundled;
  return null;
}

/**
 * Compute a deterministic fingerprint of every migration source that gets
 * replayed into `genie_template`. Any change to migration SQL, to the set of
 * migration files, or to `db-migrations.ts` itself produces a different hash —
 * which is exactly when the template must be rebuilt from scratch.
 *
 * Returns `null` when the migrations directory cannot be located; callers
 * treat a null hash as "cannot compare, rebuild unconditionally".
 */
function computeMigrationHash(): string | null {
  const dir = resolveMigrationsDir();
  if (!dir) return null;
  const hasher = createHash('sha256');
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const name of files) {
      hasher.update(name);
      hasher.update('\0');
      hasher.update(readFileSync(join(dir, name)));
      hasher.update('\0');
    }
    // Include the runner source so edits to migration semantics invalidate the
    // cache even when no SQL file changes.
    const runner = join(import.meta.dir, 'db-migrations.ts');
    if (existsSync(runner)) {
      hasher.update('db-migrations.ts\0');
      hasher.update(readFileSync(runner));
    }
  } catch {
    return null;
  }
  return hasher.digest('hex');
}

/** Atomically write the shared-daemon lockfile. Best-effort — failures are silently swallowed. */
function writePgserveLock(lock: PgserveLock): void {
  try {
    const path = lockFilePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(lock), 'utf-8');
  } catch {
    /* best-effort */
  }
}

/** Remove the lockfile (ignores missing). */
function removePgserveLock(): void {
  try {
    unlinkSync(lockFilePath());
  } catch {
    /* best-effort */
  }
}

/** True when the lockfile's startedAt is recent enough to trust without re-probing staleness. */
function lockWithinMaxAge(lock: PgserveLock, now = Date.now()): boolean {
  return now - lock.startedAt < LOCK_MAX_AGE_MS;
}

/**
 * True when a pid is still alive. `kill -0` is a portable existence probe — no
 * signal is delivered, but the kernel reports ESRCH if the pid is gone.
 */
function processAlive(pid: number): boolean {
  if (!pid || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True when the macOS RAM-disk path should back pgserve storage. */
function isMacRamEnabled(): boolean {
  return platform() === 'darwin' && process.env.GENIE_TEST_MAC_RAM === '1';
}

/**
 * True when the RAM-disk volume is currently mounted. Uses `mount` (the kernel
 * source of truth) rather than existsSync(/Volumes/...) because diskutil can
 * leave an empty mountpoint directory behind if a previous run crashed.
 */
function macRamMounted(): boolean {
  try {
    const out = execSync('mount', { encoding: 'utf-8', timeout: 2000 });
    return out.split('\n').some((line) => line.includes(`on ${MAC_RAM_MOUNT} `));
  } catch {
    return false;
  }
}

/**
 * Ensure the macOS RAM disk exists, is mounted at /Volumes/genie-test-ram,
 * and has a writable `pgserve` subdir. Returns the full data path on success
 * or null on any failure — callers fall back to pgserve's built-in ephemeral
 * dir so a hdiutil hiccup never breaks the test run.
 *
 * Idempotent: reuses an already-mounted volume. First boot creates a 1 GiB
 * RAM-backed HFS+ volume via `hdiutil attach -nomount ram://…` followed by
 * `diskutil erasevolume HFS+ genie-test-ram <device>`, which formats and
 * auto-mounts at the conventional /Volumes path.
 */
function ensureMacRamDisk(): string | null {
  try {
    if (!macRamMounted()) {
      const device = execSync(`hdiutil attach -nomount ram://${MAC_RAM_SECTORS}`, {
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim();
      if (!device.startsWith('/dev/')) return null;
      execSync(`diskutil erasevolume HFS+ ${MAC_RAM_VOLUME} ${device}`, {
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    }
    mkdirSync(MAC_RAM_DATA_DIR, { recursive: true });
    return MAC_RAM_DATA_DIR;
  } catch {
    return null;
  }
}

/**
 * Detach the macOS RAM disk if present. Best-effort, `-force` handles the
 * case where pgserve hasn't fully closed all file handles on the volume yet.
 * Safe to call when the volume isn't mounted (short-circuits).
 */
function detachMacRamDisk(): void {
  if (!macRamMounted()) return;
  try {
    execSync(`hdiutil detach ${MAC_RAM_MOUNT} -force`, {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    /* best-effort — a stale mount will be reused on the next ensure */
  }
}

/**
 * Reap leaked test pgservers from previous runs.
 *
 * Why this is needed: `bun test` exits without firing `process.on('exit')` or
 * `process.on('beforeExit')`, so any cleanup hooks registered at preload time
 * never run. Furthermore, when bun spawns a child via `child_process.spawn`
 * without a controlling TTY (e.g., under CI or the Claude Code harness), the
 * child does NOT receive SIGHUP on parent death and survives as an orphan.
 *
 * Strategy: find any pgserve-wrapper in the 20900..20999 range whose ppid === 1
 * (orphaned by a dead test runner), walk its descendants, and SIGKILL the tree.
 * Scoped strictly to orphaned (ppid=1) wrappers so concurrent test runs on the
 * same host don't kill each other.
 *
 * With the shared-daemon model, a healthy orphan whose pid matches our
 * lockfile is NOT reaped — that's the long-lived daemon we want to reuse.
 * Callers pass `keepPid` to spare it; stale / unmatched orphans still get
 * killed so leaked daemons don't pile up.
 *
 * Note: pgserve self-manages its own ephemeral data dir — no filesystem sweep
 * is needed (unlike the old `/tmp/genie-test-pg-*` cleanup). The pgserve child
 * removes its temp dir on exit; if the wrapper is orphaned, killing the tree
 * here lets postgres's own exit handlers run the removal.
 */
function reapOrphanedTestPgservers(keepPid: number | null = null): void {
  try {
    const raw = execSync(`pgrep -a -f 'pgserve-wrapper.*--port 20[89][0-9][0-9]' 2>/dev/null || true`, {
      encoding: 'utf-8',
      timeout: 2000,
    });
    for (const line of raw.split('\n').filter(Boolean)) {
      const wrapperPid = Number.parseInt(line.split(' ', 1)[0] ?? '', 10);
      if (Number.isNaN(wrapperPid)) continue;
      if (keepPid !== null && wrapperPid === keepPid) continue; // spare the reusable daemon
      if (readPpid(wrapperPid) !== 1) continue; // not orphaned — another runner owns it
      killPidsLeavesFirst(collectDescendants(wrapperPid));
    }
  } catch {
    /* best-effort — never block startup on reap failures */
  }

  // Detach the macOS RAM disk whenever we've reaped all orphans and no daemon
  // is being spared. The about-to-spawn path immediately recreates the volume
  // via ensureMacRamDisk(), so the data dir is guaranteed fresh for the new
  // daemon. Skipped when keepPid is set (reuse path) — that daemon's files
  // still live on the mount.
  if (keepPid === null && isMacRamEnabled()) {
    detachMacRamDisk();
  }
}

/** Start the test pgserve. Scans ports 20900..20999 for the first free slot. */
async function startTestPgserve(): Promise<number> {
  reapOrphanedTestPgservers();

  const useRam = platform() === 'linux' && existsSync('/dev/shm');
  // Opt-in darwin path: hdiutil RAM volume. Graceful fallback to ephemeral
  // temp dir when the flag is unset or disk creation fails.
  const dataDir = !useRam && isMacRamEnabled() ? ensureMacRamDisk() : null;

  for (let port = PORT_SCAN_START; port <= PORT_SCAN_END; port++) {
    if (await tryStartOnPort(port, useRam, dataDir)) {
      const storage = useRam ? '--ram' : dataDir ? `--data ${dataDir}` : 'ephemeral';
      console.log(`[test-setup] pgserve ${storage} on port ${port}`);
      return port;
    }
  }

  throw new Error(`test-setup: could not start pgserve on any port in ${PORT_SCAN_START}..${PORT_SCAN_END}`);
}

/** Exported for unit tests — manually tears down the test pgserve. */
export async function stopTestPgserve(): Promise<void> {
  if (sharedAdmin) {
    try {
      await sharedAdmin.end({ timeout: 5 });
    } catch {
      /* best-effort */
    }
    sharedAdmin = null;
  }
  if (child) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* best-effort */
    }
    child = null;
  }
  activeTestPort = null;
  // Release the RAM volume so the next spawn starts from a clean mount.
  if (isMacRamEnabled()) {
    detachMacRamDisk();
  }
}

// ============================================================================
// Template DB + per-test clone helpers (exported for use by test-db.ts)
// ============================================================================

/** Build a dedicated admin postgres.js client bound to the `postgres` maintenance DB. */
async function adminConnection(port: number, database = 'postgres') {
  const postgres = (await import('postgres')).default;
  return postgres({
    host: HOST,
    port,
    database,
    username: 'postgres',
    password: 'postgres', // pragma: allowlist secret — pgserve unauthenticated test default
    max: 1,
    idle_timeout: 1,
    connect_timeout: 5,
    onnotice: () => {},
    connection: { client_min_messages: 'warning' },
  });
}

/**
 * Get or create the module-scoped shared admin client. Unlike `adminConnection`,
 * this keeps `idle_timeout: 0` so the single TCP connection stays open for the
 * lifetime of the `bun test` process. postgres.js reconnects automatically if
 * the socket drops between queries.
 */
async function getSharedAdmin(port: number): Promise<Awaited<ReturnType<typeof adminConnection>>> {
  if (sharedAdmin) return sharedAdmin;
  const postgres = (await import('postgres')).default;
  sharedAdmin = postgres({
    host: HOST,
    port,
    database: 'postgres',
    username: 'postgres',
    password: 'postgres', // pragma: allowlist secret — pgserve unauthenticated test default
    max: 1,
    idle_timeout: 0,
    connect_timeout: 5,
    onnotice: () => {},
    // application_name lets tests (and pg_stat_activity observers) identify the
    // shared admin uniquely per bun-test process — important when multiple test
    // runs share a single daemon via the lockfile-reuse path.
    connection: { client_min_messages: 'warning', application_name: `genie-test-admin-${process.pid}` },
  });
  return sharedAdmin;
}

/** True when `genie_template` exists on the given pgserve. */
async function templateDatabaseExists(port: number): Promise<boolean> {
  try {
    const admin = await getSharedAdmin(port);
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${TEMPLATE_DB_NAME}`;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Drop `genie_template` if it exists. Used when the migration hash changes —
 * re-applying migrations on top of a stale template would silently skip edited
 * migrations (runMigrations is additive-only), so we force a clean rebuild.
 */
async function dropTemplateDatabase(port: number): Promise<void> {
  const admin = await getSharedAdmin(port);
  try {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = '${TEMPLATE_DB_NAME}' AND pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS "${TEMPLATE_DB_NAME}"`);
  } catch {
    /* best-effort — buildTemplateDatabase will surface real failures */
  }
}

/**
 * Build the `genie_template` database (idempotent): creates it empty from
 * `template0`, runs all migrations into it exactly once, then closes the
 * connection.
 *
 * Critical: the connection used for migrations MUST be closed before returning.
 * Any open connection to `genie_template` blocks future `CREATE DATABASE ...
 * TEMPLATE genie_template` calls with "source database is being accessed by
 * other users".
 */
async function buildTemplateDatabase(port: number): Promise<void> {
  // 1. Create the template DB if it doesn't exist (connected to `postgres`).
  //    Use the shared admin — it stays open for subsequent createTestDatabase
  //    / dropTestDatabase calls, collapsing total admin-TCP to one.
  const admin = await getSharedAdmin(port);
  const existing = await admin`
    SELECT 1 FROM pg_database WHERE datname = ${TEMPLATE_DB_NAME}
  `;
  if (existing.length === 0) {
    await admin.unsafe(`CREATE DATABASE "${TEMPLATE_DB_NAME}" TEMPLATE = template0`);
  }

  // 2. Run migrations inside the template. The template-DB client stays
  //    short-lived and is explicitly closed here — any open connection to
  //    `genie_template` would block future `CREATE DATABASE ... TEMPLATE
  //    genie_template` calls with "source database is being accessed by other
  //    users".
  const tpl = await adminConnection(port, TEMPLATE_DB_NAME);
  try {
    const { runMigrations } = await import('./db-migrations.js');
    await runMigrations(tpl);
  } finally {
    await tpl.end({ timeout: 5 }).catch(() => {
      /* best-effort */
    });
  }
}

/** Sanitize a database name — postgres identifiers can't have quotes/nulls. */
function safeDbIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`invalid test db name: ${name}`);
  }
  return name;
}

/**
 * Create a per-test database as a fast clone of `genie_template`.
 * Returns when the DB is ready to accept connections.
 *
 * Concurrency (Group 7): parallel shards routinely issue `CREATE DATABASE …
 * TEMPLATE genie_template` at the same instant. PG rejects the clone with
 * "source database is being accessed by other users" if any session is even
 * briefly connected to the source. We serialize every such clone across the
 * daemon with a single advisory lock — `pg_advisory_lock` is session-scoped,
 * blocking, and re-entrant per-session, which matches our one-admin-per-worker
 * model. The id is a compile-time constant (see CREATE_DB_ADVISORY_LOCK_ID)
 * so every shard agrees without a handshake. try/finally guarantees the lock
 * is released even when CREATE DATABASE itself raises.
 */
export async function createTestDatabase(name: string): Promise<void> {
  if (activeTestPort === null) {
    throw new Error('createTestDatabase called before test pgserve boot');
  }
  const ident = safeDbIdent(name);
  const admin = await getSharedAdmin(activeTestPort);
  // postgres.js serializes parameters via its own encoder; bigint binding
  // requires opt-in config we don't enable here. Pass the id as a decimal
  // string with an explicit ::bigint cast — the id is a compile-time
  // constant so no user input is ever interpolated.
  const lockIdStr = CREATE_DB_ADVISORY_LOCK_ID.toString();
  await admin.unsafe(`SELECT pg_advisory_lock(${lockIdStr}::bigint)`);
  try {
    await admin.unsafe(`CREATE DATABASE "${ident}" TEMPLATE "${TEMPLATE_DB_NAME}"`);
  } finally {
    await admin.unsafe(`SELECT pg_advisory_unlock(${lockIdStr}::bigint)`).catch(() => {
      /* best-effort — the lock is released on session close anyway */
    });
  }
}

/**
 * Drop a per-test database. Force-terminates any lingering connections first
 * so DROP doesn't fail with "database is being accessed by other users".
 */
export async function dropTestDatabase(name: string): Promise<void> {
  if (activeTestPort === null) return;
  const ident = safeDbIdent(name);
  const admin = await getSharedAdmin(activeTestPort);
  try {
    // Kill any stray backends still connected to this DB (shouldn't happen if
    // the test reset the db.ts singleton, but we're defensive).
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = '${ident}' AND pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS "${ident}"`);
  } catch {
    // best-effort — the daemon dies with the test run anyway
  }
}

// ============================================================================
// Lazy-boot detection (Group 5)
//
// When `bun test` is invoked with a concrete set of test files and none of
// those files touch the PG harness, we skip pgserve entirely — no spawn, no
// lockfile I/O, no template build. Saves the full ~3s boot cost on targeted
// single-file runs (watch-mode loops, focused debugging, CI unit-tests shard).
//
// Why `ps`, not `process.argv`: under `bun test` the preload sees only the
// FIRST test file in argv — bun rewrites `process.argv[1]` per-file during
// the test loop. A multi-file invocation like `bun test a.ts b.ts` would
// expose only `a.ts` via argv, so a test-harness file (b.ts) could be
// silently skipped and fail mysteriously. `ps -o args= -p <self>` returns
// the original shell command-line, which is the only reliable source of
// the full positional-arg set on bun 1.3.x.
//
// Correctness bias: any ambiguity (unreadable ps output, unrecognized flag,
// glob-char in arg, directory arg, missing file) forces eager boot. A
// false-positive (eager boot when we could have skipped) is a missed
// optimization; a false-negative (skip when pgserve is actually needed)
// is a broken test run. The detector is tuned hard toward the former.
// ============================================================================

/**
 * Markers that tell us a test file needs the PG harness. `test-db` is the
 * canonical import; the other three guard against files that exercise the
 * harness without touching the module (test-setup.test.ts itself, direct
 * getConnection() use, env-var probes). False positives are safe.
 */
const PG_HARNESS_MARKERS = ['test-db', 'test-setup', 'getConnection', 'GENIE_TEST_PG'];

/**
 * Bun test flags that consume the next whitespace-separated token as a
 * value. `--flag=value` bundles the value into the same token and doesn't
 * need special handling. Keep conservative — an unknown flag treated as
 * valueless can mis-classify the following token as positional and force
 * eager boot, which is the safe failure mode.
 */
const BUN_TEST_FLAGS_WITH_ARG = new Set<string>([
  '--preload',
  '-p',
  '--require',
  '--import',
  '-t',
  '--test-name-pattern',
  '--bail',
  '--rerun-each',
  '--coverage-reporter',
  '--coverage-dir',
  '--coverage-threshold',
  '--timeout',
  '--concurrency',
  '--shard',
  '--config',
]);

/**
 * Read the original bun-test command line via `ps -o args=`. Returns null
 * on any failure (sandbox, permissions, timeout) — caller falls back to
 * eager boot.
 */
function readBunTestCmdline(): string[] | null {
  try {
    const raw = execSync(`ps -o args= -p ${process.pid}`, { encoding: 'utf-8', timeout: 1500 }).trim();
    if (!raw) return null;
    return raw.split(/\s+/).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Extract the positional args that follow `bun test …`. Returns null when
 * we can't locate the `test` subcommand token (unexpected invocation
 * shape — `bun x -e '…'`, wrapped launcher, etc.).
 */
function extractPositionalArgs(tokens: string[]): string[] | null {
  const testIdx = tokens.indexOf('test');
  if (testIdx < 0) return null;
  const rest = tokens.slice(testIdx + 1);
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok) continue;
    if (tok.startsWith('-')) {
      if (!tok.includes('=') && BUN_TEST_FLAGS_WITH_ARG.has(tok)) {
        i++;
      }
      continue;
    }
    positional.push(tok);
  }
  return positional;
}

/**
 * Map one positional arg to a concrete file path. Returns null (= eager
 * boot) for anything we can't handle cheaply:
 *   - glob characters (shell should have expanded; quoted globs are rare)
 *   - directory paths (recursive scan is too expensive at preload)
 *   - path-prefix filters (bun's substring-match mode — not a real path)
 *   - missing files
 */
function resolvePositionalToFile(arg: string): string | null {
  if (/[*?[{]/.test(arg)) return null;
  if (arg.endsWith('/')) return null;
  if (!/\.[a-z]+$/i.test(arg)) return null;
  const abs = arg.startsWith('/') ? arg : join(process.cwd(), arg);
  if (!existsSync(abs)) return null;
  return abs;
}

/**
 * Resolve every positional arg into an absolute file path. Returns null
 * on ambiguity (any unresolvable arg) or empty input (full-suite run).
 */
function resolveTestFilesForLazyBoot(): string[] | null {
  const tokens = readBunTestCmdline();
  if (!tokens) return null;
  const positional = extractPositionalArgs(tokens);
  if (!positional || positional.length === 0) return null;

  const files: string[] = [];
  for (const arg of positional) {
    const abs = resolvePositionalToFile(arg);
    if (!abs) return null;
    files.push(abs);
  }
  return files;
}

/**
 * True when ANY of the given files references a PG-harness marker in its
 * source. A read error also returns true — the conservative default is to
 * boot rather than risk a silent-skip correctness bug.
 */
function anyFileNeedsPgserve(files: string[]): boolean {
  for (const file of files) {
    let src: string;
    try {
      src = readFileSync(file, 'utf-8');
    } catch {
      return true;
    }
    for (const marker of PG_HARNESS_MARKERS) {
      if (src.includes(marker)) return true;
    }
  }
  return false;
}

/**
 * Decide whether the current `bun test` invocation can skip pgserve.
 * Returns false on every ambiguous signal — eager boot is always safe.
 */
function shouldLazySkipPgserve(): boolean {
  const files = resolveTestFilesForLazyBoot();
  if (!files) return false;
  return !anyFileNeedsPgserve(files);
}

// ============================================================================
// Top-level preload — runs once when bun test loads this file
// ============================================================================

// Lazy-skip: when the invocation's full positional-arg set is statically
// resolvable AND no file in that set references a PG-harness marker, opt
// into GENIE_TEST_SKIP_PGSERVE before the boot gate below sees it. Ambiguous
// invocations (no positional args / directory / unresolvable glob / read
// failure) fall through to eager boot. No side effects on the lockfile, no
// daemon spawn, no template build.
if (
  !process.env.GENIE_TEST_PG_PORT &&
  !process.env.GENIE_TEST_SKIP_PGSERVE &&
  process.env.GENIE_TEST_FORCE_PGSERVE !== '1' &&
  shouldLazySkipPgserve()
) {
  process.env.GENIE_TEST_SKIP_PGSERVE = '1';
  console.log('[test-setup] lazy-skip: no PG-dependent tests in loaded files');
}

// Skip when an explicit opt-out is set (e.g., running a single test file against
// a real daemon for manual debugging) or when already initialized.
//
// Shared-daemon model: at preload we first consult the lockfile at
// <GENIE_HOME>/data/test-pgserve.lock. If the lockfile points at a healthy
// pgserve whose pid is still alive AND the lockfile is less than 1h old, we
// reuse it — no new spawn, no template rebuild (template persists in the
// daemon's data dir). Otherwise we fall through to the spawn path.
//
// Opt-out: `GENIE_TEST_PG_NO_REUSE=1` forces a hermetic spawn every run and
// skips writing the lockfile. CI jobs that need absolute isolation set this.
//
// NOTE: `bun test` does not fire `process.on('exit' | 'beforeExit')` — it hard-exits
// after the last test. That means any exit hook we register here never runs, so we
// cannot clean up the spawned pgserve at shutdown. Instead, we reap orphaned
// pgservers from previous runs at startup (see reapOrphanedTestPgservers). With
// reuse enabled, a healthy orphan matching our lockfile is spared; everything
// else is killed. At worst one pgserve persists between runs; at best zero.
if (!process.env.GENIE_TEST_PG_PORT && !process.env.GENIE_TEST_SKIP_PGSERVE) {
  const reuseEnabled = !process.env.GENIE_TEST_PG_NO_REUSE;
  const currentHash = computeMigrationHash();
  let port: number | null = null;
  let reusedLock: PgserveLock | null = null;

  if (reuseEnabled) {
    const lock = readPgserveLock();
    if (lock && lockWithinMaxAge(lock) && processAlive(lock.pid) && (await isPostgresHealthy(lock.port))) {
      port = lock.port;
      reusedLock = lock;
      console.log(`[test-setup] reusing pgserve on port ${lock.port} (pid ${lock.pid})`);
    } else if (lock) {
      // Stale — drop the lockfile so the next step's reap doesn't try to spare it.
      removePgserveLock();
    }
  }

  if (port === null) {
    // Fresh daemon: always build the template from scratch.
    port = await startTestPgserve();
    await buildTemplateDatabase(port);
    const spawned = child as ChildProcess | null;
    if (reuseEnabled && spawned?.pid) {
      writePgserveLock({ port, pid: spawned.pid, startedAt: Date.now(), migrationHash: currentHash ?? undefined });
    }
  } else if (reusedLock) {
    // Reused daemon: skip the template rebuild when the stored hash matches
    // the current migration sources AND the template DB is still present.
    // Any mismatch forces a drop + rebuild (runMigrations is additive-only,
    // so leaving a stale template would silently skip edited migrations).
    const hashesMatch = Boolean(currentHash) && reusedLock.migrationHash === currentHash;
    const templatePresent = await templateDatabaseExists(port);
    if (hashesMatch && templatePresent) {
      // Fast path — nothing to do.
    } else {
      if (templatePresent) {
        await dropTemplateDatabase(port);
      }
      await buildTemplateDatabase(port);
      writePgserveLock({
        port,
        pid: reusedLock.pid,
        startedAt: reusedLock.startedAt,
        migrationHash: currentHash ?? undefined,
      });
    }
  }

  activeTestPort = port;
  process.env.GENIE_TEST_PG_PORT = String(port);
  process.env.GENIE_TEST_PG_TEMPLATE = TEMPLATE_DB_NAME;
  process.env.GENIE_PG_AVAILABLE = 'true';
}

/**
 * Test-only exports. These are stable enough for the test-setup.test.ts suite
 * to exercise the lockfile + reap logic directly without spawning subprocesses,
 * but they are NOT part of the public API of this module.
 */
export const __testing = {
  lockFilePath,
  readPgserveLock,
  writePgserveLock,
  removePgserveLock,
  lockWithinMaxAge,
  processAlive,
  reapOrphanedTestPgservers,
  computeMigrationHash,
  templateDatabaseExists,
  dropTemplateDatabase,
  buildTemplateDatabase,
  isMacRamEnabled,
  macRamMounted,
  ensureMacRamDisk,
  detachMacRamDisk,
  extractPositionalArgs,
  resolvePositionalToFile,
  anyFileNeedsPgserve,
  shouldLazySkipPgserve,
  PG_HARNESS_MARKERS,
  BUN_TEST_FLAGS_WITH_ARG,
  LOCK_MAX_AGE_MS,
  TEMPLATE_DB_NAME,
  MAC_RAM_MOUNT,
  MAC_RAM_DATA_DIR,
  CREATE_DB_ADVISORY_LOCK_ID,
};
