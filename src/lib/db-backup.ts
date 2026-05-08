/**
 * Database backup & restore — pg_dump + node:zlib for genie DB snapshots.
 *
 * No external dependencies beyond pg_dump (ships with pgserve).
 * Compression uses node:zlib, restore pipes through postgres.js.
 *
 * pgserve v2: connects via Unix socket at $XDG_RUNTIME_DIR/pgserve.
 * The daemon routes via SO_PEERCRED, then the proxied Postgres handshake uses
 * pgserve's local role credentials.
 */

import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  DB_NAME,
  getActivePort,
  resolveDatabaseName,
  resolvePgserveAuthPassword,
  resolvePgserveSocketDir,
  resolveTcpPgPassword,
} from './db.js';
import { resolveRepoPath } from './wish-state.js';

const SNAPSHOT_FILE = 'snapshot.sql.gz';

/**
 * Resolve the snapshot path under GENIE_HOME (default ~/.genie/backups/<repo>/),
 * never inside the repo tree — keeps DB dumps out of source control.
 */
export function getSnapshotPath(cwd?: string): string {
  const repoRoot = resolveRepoPath(cwd);
  const genieHome = process.env.GENIE_HOME ?? join(homedir(), '.genie');
  return join(genieHome, 'backups', basename(repoRoot), SNAPSHOT_FILE);
}

/**
 * Refuse to write a dump inside the repo tree. Second line of defense after getSnapshotPath.
 */
function assertOutsideRepo(snapshotPath: string, cwd?: string): void {
  const repoRoot = resolveRepoPath(cwd);
  const rel = relative(repoRoot, resolve(snapshotPath));
  const insideRepo = !rel.startsWith('..') && rel !== '' && !rel.startsWith('/');
  if (insideRepo) {
    throw new Error(
      `Refusing to write snapshot inside repo tree: ${snapshotPath}. Snapshots must live outside the repo (default: ~/.genie/backups/<repo>/).`,
    );
  }
}

/**
 * Build the env block for pg_dump / psql shell-outs. Mirrors the socket-vs-TCP
 * decision in `_buildConnection()` so backup/restore route through the same
 * transport the live process is on:
 *
 *   - GENIE_PG_FORCE_TCP=1 or GENIE_TEST_PG_PORT set → libpq TCP loopback.
 *     PGHOST=127.0.0.1, PGPORT=<active port>, PGUSER/PGPASSWORD for the
 *     unauthenticated test daemon.
 *   - Otherwise → pgserve v2 Unix socket. PGHOST points at the socket dir,
 *     no PGPORT (libpq dials `<dir>/.s.PGSQL.5432`), PGUSER/PGPASSWORD answer
 *     the embedded Postgres auth challenge after SO_PEERCRED routing.
 */
function pgEnv(database?: string): Record<string, string | undefined> {
  const forceTcp = process.env.GENIE_PG_FORCE_TCP === '1';
  const testPort = process.env.GENIE_TEST_PG_PORT;
  const useSocket = !forceTcp && !testPort;
  const resolvedDatabase = database ?? resolveDatabaseName();

  if (useSocket) {
    return {
      ...process.env,
      PGHOST: resolvePgserveSocketDir(),
      PGUSER: DB_NAME,
      PGPASSWORD: resolvePgserveAuthPassword(),
      PGDATABASE: resolvedDatabase,
    };
  }

  // TCP path. Test mode passes the port via env; legacy GENIE_PG_FORCE_TCP=1
  // peers fall back to the active singleton (set by ensurePgserve).
  const port = testPort && testPort.length > 0 ? testPort : String(getActivePort());
  return {
    ...process.env,
    PGHOST: '127.0.0.1',
    PGPORT: port,
    PGUSER: DB_NAME,
    PGPASSWORD: resolveTcpPgPassword(),
    PGDATABASE: resolvedDatabase,
  };
}

interface BackupResult {
  path: string;
  compressedBytes: number;
  uncompressedBytes: number;
}

/**
 * Run pg_dump → zlib.gzip → snapshot.sql.gz.
 * Replaces the previous snapshot (single file, not accumulating).
 * Uses spawnSync so pg_dump exit code is checked directly — no shell pipeline.
 */
export function backup(cwd?: string): BackupResult {
  const snapshotPath = getSnapshotPath(cwd);
  assertOutsideRepo(snapshotPath, cwd);
  const snapshotDir = snapshotPath.slice(0, snapshotPath.lastIndexOf('/'));
  const tmpPath = `${snapshotPath}.tmp`;

  mkdirSync(snapshotDir, { recursive: true });

  // pg_dump → stdout buffer, exit code checked directly.
  // `--clean --if-exists` makes the dump self-contained: it drops every object
  // it owns (idempotently) before recreating them, so restore() can pipe it
  // through psql without a separate DROP DATABASE / CREATE DATABASE dance.
  // That dance is impossible under pgserve v2 anyway — the daemon enforces
  // tenancy and routes every connection back to the peer's fingerprinted DB,
  // so an admin client can't sit in a different "maintenance" DB to drop the
  // app DB.
  const result: SpawnSyncReturns<Buffer> = spawnSync('pg_dump', ['--no-owner', '--no-acl', '--clean', '--if-exists'], {
    env: pgEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
    maxBuffer: 1024 * 1024 * 1024, // 1GB
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || 'unknown error';
    throw new Error(`pg_dump failed (exit ${result.status}): ${stderr}`);
  }

  // Compress with node:zlib (synchronous — data already in memory)
  const compressed = gzipSync(result.stdout);

  // Atomic write: tmp → rename
  writeFileSync(tmpPath, compressed);
  renameSync(tmpPath, snapshotPath);

  const compressedBytes = statSync(snapshotPath).size;

  // Get uncompressed size estimate from pg_database_size
  let uncompressedBytes = 0;
  try {
    const sizeResult = spawnSync('psql', ['-t', '-A', '-c', 'SELECT pg_database_size(current_database())'], {
      env: pgEnv(),
      encoding: 'utf-8',
      timeout: 10_000,
    });
    if (sizeResult.status === 0) {
      uncompressedBytes = Number.parseInt(sizeResult.stdout.trim(), 10) || 0;
    }
  } catch {
    // Non-critical — just won't show uncompressed size
  }

  return { path: snapshotPath, compressedBytes, uncompressedBytes };
}

/**
 * Restore DB from a snapshot file.
 *
 * Under pgserve v2 the daemon enforces tenancy: every peer connection (admin
 * or not) is routed back to the peer's fingerprinted `app_<name>_<12hex>` DB.
 * That makes the legacy "connect admin to a maintenance DB, DROP+CREATE the
 * target" pattern impossible — there is no other DB the admin can sit in
 * while it drops the app DB.
 *
 * Instead we rely on `pg_dump --clean --if-exists` (set in `backup()`) which
 * emits idempotent DROP statements at the head of the dump. We:
 *
 *   1. Terminate any other backends on the target DB so DROPs aren't blocked
 *      ("database is being accessed by other users"). The terminate query
 *      runs from inside our own session against `current_database()` so it
 *      always names the actual fingerprinted DB the daemon routed us into.
 *   2. Pipe the gunzipped dump through psql. The dump's `--clean --if-exists`
 *      prelude drops existing objects, then recreates and reloads them.
 *
 * Decompression uses node:zlib — no gunzip binary needed.
 */
export function restore(snapshotFile?: string, cwd?: string): void {
  const filePath = snapshotFile ?? getSnapshotPath(cwd);

  if (!existsSync(filePath)) {
    throw new Error(`Snapshot not found: ${filePath}`);
  }

  const env = pgEnv();

  // Terminate other backends on the target DB. `current_database()` resolves
  // server-side to the fingerprinted name the daemon routed us into, so we
  // never need to know the literal `app_<name>_<hex>` here.
  spawnSync(
    'psql',
    [
      '-c',
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()',
    ],
    {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    },
  );

  // Decompress with node:zlib, feed to psql via stdin. ON_ERROR_STOP=on so a
  // partial failure surfaces a non-zero exit instead of leaving the DB in a
  // half-restored state.
  const compressed = readFileSync(filePath);
  const sql = gunzipSync(compressed);

  const restoreResult = spawnSync('psql', ['-v', 'ON_ERROR_STOP=1'], {
    env,
    input: sql,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 300_000,
    maxBuffer: 1024 * 1024 * 1024,
  });

  if (restoreResult.status !== 0) {
    throw new Error(`psql restore failed (exit ${restoreResult.status}): ${restoreResult.stderr?.toString().trim()}`);
  }
}
