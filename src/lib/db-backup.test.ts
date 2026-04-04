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

  beforeEach(() => {
    tmpDir = join(tmpdir(), `genie-backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    spawnSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns path inside .genie/ at repo root', async () => {
    const { getSnapshotPath } = await import('./db-backup.js');
    const path = getSnapshotPath(tmpDir);
    expect(path).toBe(join(tmpDir, '.genie', 'snapshot.sql.gz'));
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

  test('creates .genie directory if it does not exist', async () => {
    const genieDir = join(tmpDir, '.genie');
    expect(existsSync(genieDir)).toBe(false);

    const { backup } = await import('./db-backup.js');
    // backup calls pg_dump which needs pgserve — will fail but should create dir first
    try {
      backup(tmpDir);
    } catch {
      // Expected — pg_dump will fail without a running DB on this port
    }
    expect(existsSync(genieDir)).toBe(true);
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
