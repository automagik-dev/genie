/**
 * Database backup & restore — pg_dump + node:zlib for genie DB snapshots.
 *
 * No external dependencies beyond pg_dump (ships with pgserve).
 * Compression uses node:zlib, restore pipes through postgres.js.
 *
 * pgserve v2: connects via Unix socket at $XDG_RUNTIME_DIR/pgserve.
 * No port, no user, no password — the daemon authenticates via SO_PEERCRED
 * and routes the peer to its fingerprinted database automatically. The libpq
 * default `database = user` resolves to the fingerprint's DB.
 */

import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { resolveDatabaseName, resolvePgserveSocketDir } from './db.js';
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

function pgEnv(database?: string): Record<string, string | undefined> {
  return {
    ...process.env,
    PGHOST: resolvePgserveSocketDir(),
    PGDATABASE: database ?? resolveDatabaseName(),
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

  // pg_dump → stdout buffer, exit code checked directly
  const result: SpawnSyncReturns<Buffer> = spawnSync('pg_dump', ['--no-owner', '--no-acl'], {
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
 * Drops the existing DB, creates fresh, restores via psql stdin.
 * Decompression uses node:zlib — no gunzip binary needed.
 */
export function restore(snapshotFile?: string, cwd?: string): void {
  const filePath = snapshotFile ?? getSnapshotPath(cwd);

  if (!existsSync(filePath)) {
    throw new Error(`Snapshot not found: ${filePath}`);
  }

  const dbName = resolveDatabaseName();
  const env = pgEnv();
  const adminEnv = pgEnv('postgres');

  // Terminate existing connections (use psql variable to avoid string interpolation)
  spawnSync(
    'psql',
    [
      '-v',
      `target_db=${dbName}`,
      '-c',
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'target_db' AND pid <> pg_backend_pid()",
    ],
    {
      env: adminEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    },
  );

  // Drop and recreate (use psql variable to avoid string interpolation)
  const dropResult = spawnSync('psql', ['-v', `target_db=${dbName}`, '-c', 'DROP DATABASE IF EXISTS :"target_db"'], {
    env: adminEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  if (dropResult.status !== 0) {
    throw new Error(`Failed to drop database: ${dropResult.stderr?.toString().trim()}`);
  }

  const createResult = spawnSync('psql', ['-v', `target_db=${dbName}`, '-c', 'CREATE DATABASE :"target_db"'], {
    env: adminEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  if (createResult.status !== 0) {
    throw new Error(`Failed to create database: ${createResult.stderr?.toString().trim()}`);
  }

  // Decompress with node:zlib, feed to psql via stdin
  const compressed = readFileSync(filePath);
  const sql = gunzipSync(compressed);

  const restoreResult = spawnSync('psql', [], {
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
