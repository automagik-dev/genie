/**
 * Database backup & restore — pg_dump/psql wrappers for genie DB snapshots.
 *
 * - backup(): pg_dump → gzip → .genie/snapshot.sql.gz
 * - restore(): gunzip → psql (drop + create + restore + migrate)
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
 * Run pg_dump → gzip → snapshot.sql.gz.
 * Replaces the previous snapshot (single file, not accumulating).
 */
export function backup(cwd?: string): BackupResult {
  const port = getActivePort();
  const snapshotPath = getSnapshotPath(cwd);
  const genieDir = join(resolveRepoPath(cwd), '.genie');

  mkdirSync(genieDir, { recursive: true });

  // pg_dump piped through gzip — single atomic write
  execSync(`pg_dump --no-owner --no-acl | gzip > "${snapshotPath}.tmp"`, {
    env: pgEnv(port),
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
  });

  // Atomic rename
  execSync(`mv "${snapshotPath}.tmp" "${snapshotPath}"`, { stdio: 'ignore' });

  const compressedBytes = statSync(snapshotPath).size;

  // Get uncompressed size estimate from pg_database_size
  let uncompressedBytes = 0;
  try {
    const out = execSync(`psql -t -A -c "SELECT pg_database_size('${DB_NAME}')"`, {
      env: pgEnv(port),
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
    uncompressedBytes = Number.parseInt(out, 10) || 0;
  } catch {
    // Non-critical — just won't show uncompressed size
  }

  return { path: snapshotPath, compressedBytes, uncompressedBytes };
}

/**
 * Restore DB from a snapshot file.
 * Drops the existing DB, creates fresh, restores, then runs migrations.
 */
export function restore(snapshotFile?: string, cwd?: string): void {
  const port = getActivePort();
  const filePath = snapshotFile ?? getSnapshotPath(cwd);

  if (!existsSync(filePath)) {
    throw new Error(`Snapshot not found: ${filePath}`);
  }

  const env = pgEnv(port);

  // Drop and recreate the database
  // Connect to 'postgres' DB to drop/create genie
  const adminEnv = { ...env, PGDATABASE: 'postgres' };

  // Terminate existing connections
  execSync(
    `psql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid()"`,
    { env: adminEnv, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000 },
  );

  execSync(`psql -c "DROP DATABASE IF EXISTS ${DB_NAME}"`, {
    env: adminEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10_000,
  });

  execSync(`psql -c "CREATE DATABASE ${DB_NAME}"`, {
    env: adminEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10_000,
  });

  // Restore from compressed dump
  execSync(`gunzip -c "${filePath}" | psql`, {
    env: { ...env, PGDATABASE: DB_NAME },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 300_000,
  });
}
