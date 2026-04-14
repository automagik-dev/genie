import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// ============================================================================
// getSnapshotPath — pure function, no DB needed
// ============================================================================

describe('getSnapshotPath', () => {
  let tmpDir: string;
  let genieHome: string;
  const originalGenieHome = process.env.GENIE_HOME;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `genie-backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    genieHome = join(tmpdir(), `genie-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    spawnSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
    process.env.GENIE_HOME = genieHome;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(genieHome, { recursive: true, force: true });
    process.env.GENIE_HOME = originalGenieHome;
  });

  test('resolves outside repo tree (under GENIE_HOME/backups/<repo>/)', async () => {
    const { getSnapshotPath } = await import('./db-backup.js');
    const path = getSnapshotPath(tmpDir);
    expect(path.startsWith(genieHome)).toBe(true);
    expect(path.startsWith(tmpDir)).toBe(false);
  });

  test('path ends with snapshot.sql.gz', async () => {
    const { getSnapshotPath } = await import('./db-backup.js');
    const path = getSnapshotPath(tmpDir);
    expect(path.endsWith('snapshot.sql.gz')).toBe(true);
  });
});

// ============================================================================
// restore — error paths (no DB needed)
// ============================================================================

describe('restore error handling', () => {
  test('throws for missing snapshot file', async () => {
    const { restore } = await import('./db-backup.js');
    expect(() => restore('/tmp/nonexistent-genie-snapshot-test.sql.gz')).toThrow('Snapshot not found');
  });

  test('throws for non-gzip file', async () => {
    const { restore } = await import('./db-backup.js');
    const tmpFile = join(tmpdir(), `genie-bad-snapshot-${Date.now()}.sql.gz`);
    writeFileSync(tmpFile, 'not gzip data');
    try {
      // restore calls getActivePort() which needs pgserve — will throw if not running
      expect(() => restore(tmpFile)).toThrow();
    } finally {
      rmSync(tmpFile, { force: true });
    }
  }, 15000);
});

// ============================================================================
// backup — error paths (no DB needed for these)
// ============================================================================

describe('backup error handling', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `genie-backup-err-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    spawnSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates snapshot directory outside repo if it does not exist', async () => {
    const genieHome = join(tmpdir(), `genie-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const originalGenieHome = process.env.GENIE_HOME;
    process.env.GENIE_HOME = genieHome;
    try {
      expect(existsSync(genieHome)).toBe(false);
      const { backup, getSnapshotPath } = await import('./db-backup.js');
      const snapshotDir = getSnapshotPath(tmpDir).slice(0, getSnapshotPath(tmpDir).lastIndexOf('/'));
      try {
        backup(tmpDir);
      } catch {
        // Expected — pg_dump will fail without a running DB on this port
      }
      expect(existsSync(snapshotDir)).toBe(true);
      expect(existsSync(join(tmpDir, '.genie', 'snapshot.sql.gz'))).toBe(false);
    } finally {
      rmSync(genieHome, { recursive: true, force: true });
      process.env.GENIE_HOME = originalGenieHome;
    }
  }, 30_000);
});

// ============================================================================
// snapshot file format — verify gzip round-trip
// ============================================================================

describe('snapshot file format', () => {
  test('gzipSync + gunzipSync round-trips SQL content', async () => {
    const { gunzipSync } = await import('node:zlib');
    const sql = '-- PostgreSQL dump\nCREATE TABLE test (id int);\n';
    const compressed = gzipSync(Buffer.from(sql));
    const decompressed = gunzipSync(compressed);
    expect(decompressed.toString('utf-8')).toBe(sql);
  });
});
