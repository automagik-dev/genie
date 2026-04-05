/**
 * Test-only preload hook — boots a dedicated pgserve in --ram mode on a
 * non-production port so `bun test` never touches the real database.
 *
 * Wired via `bunfig.toml [test] preload = ["./src/lib/test-setup.ts"]`, so it
 * runs exactly once before any test file is loaded. Subsequent `ensurePgserve()`
 * calls in `db.ts` see `GENIE_TEST_PG_PORT` and short-circuit to the test port.
 *
 * Why this exists: tests and the live `genie serve` daemon previously shared
 * one PG database, and their asymmetric catalog-lock orderings made the
 * PostgreSQL deadlock detector abort team.test.ts under full-suite load.
 * See `.genie/wishes/test-pg-ram-isolation/TRACE.md` for the full analysis.
 */

import { type ChildProcess, execSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

// Test pgserves live on ports 20900-20999 — well clear of:
//   - 19642 (production pgserve public port)
//   - 20642 (production pgserve internal postgres port)
//   - 8432  (pgserve default)
// The range is wide enough to survive parallel test runs on the same host.
const PORT_SCAN_START = 20900;
const PORT_SCAN_END = 20999;
const HOST = '127.0.0.1';
const HEALTH_TIMEOUT_MS = 15_000;

let child: ChildProcess | null = null;
let dataDir: string | null = null;

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
      password: 'postgres',
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

/** Build the pgserve argv for a given port, honoring RAM vs disk fallback. */
function buildPgserveArgs(port: number, useRam: boolean): string[] {
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
async function tryStartOnPort(port: number, useRam: boolean): Promise<boolean> {
  if (await isPostgresHealthy(port)) return false; // another runner has it — skip
  try {
    child = spawn(findPgserveBin(), buildPgserveArgs(port, useRam), {
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

/** Check whether a given pid is alive. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively collect all descendant PIDs of a given root. Returns [root, ...children].
 * Used to walk the wrapper → pglite-server → postgres tree when reaping.
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
        const child = Number.parseInt(line, 10);
        if (!Number.isNaN(child) && !all.has(child)) {
          all.add(child);
          queue.push(child);
        }
      }
    } catch {
      /* best-effort */
    }
  }
  return [...all];
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
 * What leaks: pgserve spawns a chain `pgserve-wrapper.cjs → pglite-server.js →
 * native postgres`. When bun test exits, the wrapper (spawned directly by us)
 * becomes orphaned (ppid=1), but its pglite-server and postgres children are
 * NOT orphaned — they still point at the wrapper as parent. So reaping by
 * "postgres with ppid=1" misses everything; we must find the orphaned
 * wrapper first, then walk its descendant tree.
 *
 * Strategy:
 *   1. Find all pgserve-wrapper processes whose port is in our test range and
 *      whose ppid === 1 (orphaned by a dead test runner).
 *   2. For each, collect all descendants (wrapper + pglite + postgres) and
 *      SIGKILL the whole tree.
 *   3. Remove any `/dev/shm/pgserve-*` data dirs whose owner pid is dead.
 *
 * Scoped strictly to orphaned (ppid=1) wrappers so concurrent test runs on the
 * same host don't kill each other.
 */
/** Extract `/dev/shm/pgserve-*` data dir from a postgres command line, or null. */
function extractShmDataDir(pid: number): string | null {
  try {
    const args = execSync(`ps -o args= -p ${pid} 2>/dev/null || true`, {
      encoding: 'utf-8',
      timeout: 1000,
    });
    return /-D (\/dev\/shm\/pgserve-[^\s]+)/.exec(args)?.[1] ?? null;
  } catch {
    return null;
  }
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

/** Reap a single orphaned wrapper tree. Returns the data dirs it touched. */
function reapWrapperTree(wrapperPid: number): string[] {
  const tree = collectDescendants(wrapperPid);
  const dirs: string[] = [];
  for (const pid of tree) {
    const dir = extractShmDataDir(pid);
    if (dir) dirs.push(dir);
  }
  killPidsLeavesFirst(tree);
  return dirs;
}

/** Remove a set of /dev/shm data dirs. Best-effort. */
function removeDataDirs(dirs: Iterable<string>): void {
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Sweep any `/dev/shm/pgserve-*` dirs whose owner pid (encoded in the dir name)
 * is dead. Catches dirs whose wrappers were killed by external means (Ctrl-C,
 * oom-killer, prior manual cleanup) and never made it through the tree walk.
 */
function sweepDeadShmDirs(): void {
  const shmRoot = '/dev/shm';
  if (!existsSync(shmRoot)) return;
  for (const name of readdirSync(shmRoot)) {
    if (!name.startsWith('pgserve-')) continue;
    const ownerPid = Number.parseInt(name.split('-')[1] ?? '', 10);
    if (Number.isNaN(ownerPid)) continue;
    if (isPidAlive(ownerPid)) continue;
    try {
      rmSync(join(shmRoot, name), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

function reapOrphanedTestPgservers(): void {
  try {
    const raw = execSync(`pgrep -a -f 'pgserve-wrapper.*--port 20[89][0-9][0-9]' 2>/dev/null || true`, {
      encoding: 'utf-8',
      timeout: 2000,
    });
    const dirsToRemove = new Set<string>();
    for (const line of raw.split('\n').filter(Boolean)) {
      const wrapperPid = Number.parseInt(line.split(' ', 1)[0] ?? '', 10);
      if (Number.isNaN(wrapperPid)) continue;
      if (readPpid(wrapperPid) !== 1) continue; // not orphaned — another runner owns it
      for (const dir of reapWrapperTree(wrapperPid)) dirsToRemove.add(dir);
    }
    removeDataDirs(dirsToRemove);
    sweepDeadShmDirs();
  } catch {
    /* best-effort — never block startup on reap failures */
  }
}

/** Start the test pgserve. Scans ports 20900..20999 for the first free slot. */
async function startTestPgserve(): Promise<number> {
  reapOrphanedTestPgservers();

  const useRam = platform() === 'linux' && existsSync('/dev/shm');
  dataDir = useRam ? null : join('/tmp', `genie-test-pg-${process.pid}`);

  for (let port = PORT_SCAN_START; port <= PORT_SCAN_END; port++) {
    if (await tryStartOnPort(port, useRam)) {
      console.log(`[test-setup] pgserve ${useRam ? '--ram' : `--data ${dataDir}`} on port ${port}`);
      return port;
    }
  }

  throw new Error(`test-setup: could not start pgserve on any port in ${PORT_SCAN_START}..${PORT_SCAN_END}`);
}

/** Exported for unit tests — manually tears down the test pgserve. */
export async function stopTestPgserve(): Promise<void> {
  if (child) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* best-effort */
    }
    child = null;
  }
  if (dataDir && existsSync(dataDir)) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    dataDir = null;
  }
}

// ============================================================================
// Top-level preload — runs once when bun test loads this file
// ============================================================================

/**
 * Pre-migrate the public schema of the fresh test pgserve.
 *
 * Why: tests that call `setupTestSchema()` create per-file isolated schemas and
 * run migrations into them, but rely on postgres.js's `SET search_path` which is
 * per-connection. Under pool churn (max:1, idle_timeout:1) the search_path can
 * be lost between queries, causing tables to land in the wrong place. Previously
 * tests got lucky because production pgserve already had tables in `public` as a
 * fall-through. With a fresh RAM pgserve there is no such fall-through, and the
 * latent bug surfaces as `relation "genie_runtime_events" does not exist`.
 *
 * Running migrations on `public` once at preload time restores that fall-through
 * without touching any test file or `test-db.ts`. Per-schema isolation (when
 * set up correctly) still works — tables just also exist in `public`.
 */
async function primePublicSchema(port: number): Promise<void> {
  const postgres = (await import('postgres')).default;
  const sql = postgres({
    host: HOST,
    port,
    database: 'genie',
    username: 'postgres',
    password: 'postgres',
    max: 1,
    connect_timeout: 5,
    onnotice: () => {},
  });
  try {
    const { runMigrations } = await import('./db-migrations.js');
    await runMigrations(sql);
  } finally {
    try {
      await sql.end({ timeout: 5 });
    } catch {
      /* best-effort */
    }
  }
}

// Skip when an explicit opt-out is set (e.g., running a single test file against
// a real daemon for manual debugging) or when already initialized.
//
// NOTE: `bun test` does not fire `process.on('exit' | 'beforeExit')` — it hard-exits
// after the last test. That means any exit hook we register here never runs, so we
// cannot clean up the spawned pgserve at shutdown. Instead, we reap orphaned
// pgservers from previous runs at startup (see reapOrphanedTestPgservers). This is
// self-healing: at worst one pgserve persists between runs, at best zero.
if (!process.env.GENIE_TEST_PG_PORT && !process.env.GENIE_TEST_SKIP_PGSERVE) {
  const port = await startTestPgserve();
  await primePublicSchema(port);
  process.env.GENIE_TEST_PG_PORT = String(port);
  process.env.GENIE_PG_AVAILABLE = 'true';
}
