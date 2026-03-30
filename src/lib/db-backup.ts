/**
 * Database backup & restore — pg_dump + node:zlib for genie DB snapshots.
 *
 * No external dependencies beyond pg_dump (ships with pgserve).
 * Compression uses node:zlib, restore pipes through postgres.js.
 */

import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { getActivePort } from './db.js';
import { resolveRepoPath } from './wish-state.js';

const DB_NAME = 'genie';
const DB_USER = 'postgres';
const DB_HOST = '127.0.0.1';
const SNAPSHOT_FILE = 'snapshot.sql.gz';

/** Resolve the snapshot path inside .genie/ at the repo root. */
export function getSnapshotPath(cwd?: string): string {
  const repoRoot = resolveRepoPath(cwd);
  return join(repoRoot, '.genie', SNAPSHOT_FILE);
}

function pgEnv(port: number): Record<string, string | undefined> {
  return {
    ...process.env,
    PGHOST: DB_HOST,
    PGPORT: String(port),
    PGUSER: DB_USER,
    PGPASSWORD: DB_USER,
    PGDATABASE: DB_NAME,
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
  const port = getActivePort();
  const snapshotPath = getSnapshotPath(cwd);
  const genieDir = join(resolveRepoPath(cwd), '.genie');
  const tmpPath = `${snapshotPath}.tmp`;

  mkdirSync(genieDir, { recursive: true });

  // pg_dump → stdout buffer, exit code checked directly
  const result: SpawnSyncReturns<Buffer> = spawnSync('pg_dump', ['--no-owner', '--no-acl'], {
    env: pgEnv(port),
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
    const sizeResult = spawnSync('psql', ['-t', '-A', '-c', `SELECT pg_database_size('${DB_NAME}')`], {
      env: pgEnv(port),
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
  const port = getActivePort();
  const filePath = snapshotFile ?? getSnapshotPath(cwd);

  if (!existsSync(filePath)) {
    throw new Error(`Snapshot not found: ${filePath}`);
  }

  const env = pgEnv(port);
  const adminEnv = { ...env, PGDATABASE: 'postgres' };

  // Terminate existing connections
  spawnSync(
    'psql',
    [
      '-c',
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid()`,
    ],
    {
      env: adminEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    },
  );

  // Drop and recreate
  const dropResult = spawnSync('psql', ['-c', `DROP DATABASE IF EXISTS ${DB_NAME}`], {
    env: adminEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  if (dropResult.status !== 0) {
    throw new Error(`Failed to drop database: ${dropResult.stderr?.toString().trim()}`);
  }

  const createResult = spawnSync('psql', ['-c', `CREATE DATABASE ${DB_NAME}`], {
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
    env: { ...env, PGDATABASE: DB_NAME },
    input: sql,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 300_000,
    maxBuffer: 1024 * 1024 * 1024,
  });

  if (restoreResult.status !== 0) {
    throw new Error(`psql restore failed (exit ${restoreResult.status}): ${restoreResult.stderr?.toString().trim()}`);
  }
}
