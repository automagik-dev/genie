import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  test('socket pg_dump env includes pgserve auth credentials', () => {
    const source = readFileSync(join(__dirname, 'db-backup.ts'), 'utf-8');
    const socketBranch = source.slice(source.indexOf('if (useSocket)'), source.indexOf('// TCP path'));
    expect(socketBranch).toContain('PGHOST: resolvePgserveSocketDir()');
    expect(socketBranch).toContain('PGUSER: DB_NAME');
    expect(socketBranch).toContain('PGPASSWORD: resolvePgserveAuthPassword()');
    expect(socketBranch).toContain('PGDATABASE: resolvedDatabase');
  });
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

// ============================================================================
// rebalanceIdentitySequences — post-restore sequence rebalance
//
// Reproduces the 2026-05-22 khal-os incident: pg_dump --clean --if-exists
// recreates IDENTITY-bearing tables (resetting the implicit sequence to its
// initial value), then COPYs in the rows with their original explicit ids.
// Without an explicit setval() the next INSERT collides with an existing PK.
// ============================================================================

describe('buildIdentityRebalanceSql', () => {
  test('emits a PL/pgSQL DO block that walks attidentity columns', async () => {
    const { buildIdentityRebalanceSql } = await import('./db-backup.js');
    const sql = buildIdentityRebalanceSql();
    expect(sql.trimStart()).toMatch(/^DO \$\$/);
    expect(sql).toContain("attidentity IN ('a', 'd')");
    expect(sql).toContain("n.nspname = 'public'");
    expect(sql).toContain("c.relkind = 'r'");
    expect(sql).toContain('setval(pg_get_serial_sequence');
    expect(sql).toContain('GREATEST(COALESCE');
  });

  test('uses format(%L, %I) — safe against schema/table identifiers', async () => {
    const { buildIdentityRebalanceSql } = await import('./db-backup.js');
    const sql = buildIdentityRebalanceSql();
    expect(sql).toContain('%L');
    expect(sql).toContain('%I');
  });
});

describe('rebalanceIdentitySequences', () => {
  test('runner is invoked with the rebalance SQL block', async () => {
    const { rebalanceIdentitySequences, buildIdentityRebalanceSql } = await import('./db-backup.js');
    let captured = '';
    rebalanceIdentitySequences({
      runner: (sql) => {
        captured = sql;
        return { status: 0 };
      },
    });
    expect(captured).toBe(buildIdentityRebalanceSql());
  });

  test('non-zero exit status throws with stderr context', async () => {
    const { rebalanceIdentitySequences } = await import('./db-backup.js');
    expect(() =>
      rebalanceIdentitySequences({
        runner: () => ({ status: 3, stderr: Buffer.from('ERROR: permission denied\n') }),
      }),
    ).toThrow(/Identity sequence rebalance failed \(exit 3\): ERROR: permission denied/);
  });

  test('handles string stderr (legacy spawnSync encoding paths)', async () => {
    const { rebalanceIdentitySequences } = await import('./db-backup.js');
    expect(() =>
      rebalanceIdentitySequences({
        runner: () => ({ status: 1, stderr: 'syntax error at end of input' }),
      }),
    ).toThrow(/syntax error at end of input/);
  });

  test('null status (timeout) is treated as failure', async () => {
    const { rebalanceIdentitySequences } = await import('./db-backup.js');
    expect(() =>
      rebalanceIdentitySequences({
        runner: () => ({ status: null, stderr: Buffer.from('killed') }),
      }),
    ).toThrow(/exit null/);
  });

  test('missing stderr falls back to "unknown error" sentinel', async () => {
    const { rebalanceIdentitySequences } = await import('./db-backup.js');
    expect(() =>
      rebalanceIdentitySequences({
        runner: () => ({ status: 2 }),
      }),
    ).toThrow(/unknown error/);
  });

  test('zero exit returns void without throwing', async () => {
    const { rebalanceIdentitySequences } = await import('./db-backup.js');
    expect(() =>
      rebalanceIdentitySequences({
        runner: () => ({ status: 0 }),
      }),
    ).not.toThrow();
  });
});

// ============================================================================
// restore() wiring — rebalance must run AFTER the psql replay so the
// freshly-loaded rows are visible to MAX(col).
// ============================================================================

describe('restore() rebalance wiring (source-shape lock)', () => {
  test('restore() calls rebalanceIdentitySequences after the psql pipe', () => {
    const source = readFileSync(join(__dirname, 'db-backup.ts'), 'utf-8');
    const restoreFn = source.slice(
      source.indexOf('export function restore('),
      source.indexOf('export interface RebalanceIdentitySequencesOptions'),
    );
    const psqlIdx = restoreFn.indexOf("spawnSync('psql', ['-v', 'ON_ERROR_STOP=1']");
    const rebalanceIdx = restoreFn.indexOf('rebalanceIdentitySequences(');
    expect(psqlIdx).toBeGreaterThan(-1);
    expect(rebalanceIdx).toBeGreaterThan(-1);
    expect(psqlIdx).toBeLessThan(rebalanceIdx);
  });
});
