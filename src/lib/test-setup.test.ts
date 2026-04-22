/**
 * Tests for the bun test preload hook at src/lib/test-setup.ts.
 *
 * These tests verify that the single-daemon preload ran before any test file
 * was loaded:
 *   - GENIE_TEST_PG_PORT is set to a non-default port in 20900..20999
 *   - GENIE_TEST_PG_TEMPLATE names the template DB (built once by preload)
 *   - getConnection() routes through the test port (not the production daemon)
 *   - /tmp does NOT contain legacy `genie-test-pg-*` leak dirs
 *     (bug we're fixing — pgserve self-manages its own ephemeral temp dir now)
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { platform } from 'node:os';

describe('test-setup preload hook', () => {
  test('sets GENIE_TEST_PG_PORT to a valid non-default port', () => {
    const raw = process.env.GENIE_TEST_PG_PORT;
    expect(raw).toBeDefined();
    const port = Number.parseInt(raw ?? '', 10);
    expect(Number.isNaN(port)).toBe(false);
    expect(port).toBeGreaterThanOrEqual(20900);
    expect(port).toBeLessThanOrEqual(20999);
  });

  test('test port differs from production default 19642', () => {
    const port = Number.parseInt(process.env.GENIE_TEST_PG_PORT ?? '', 10);
    expect(port).not.toBe(19642);
  });

  test('test port differs from GENIE_PG_PORT env var (if set)', () => {
    const prod = process.env.GENIE_PG_PORT;
    if (!prod) return; // skip when unset
    const test = process.env.GENIE_TEST_PG_PORT;
    expect(test).not.toBe(prod);
  });

  test('GENIE_PG_AVAILABLE is set to true', () => {
    expect(process.env.GENIE_PG_AVAILABLE).toBe('true');
  });

  test('GENIE_TEST_PG_TEMPLATE is set to genie_template', () => {
    expect(process.env.GENIE_TEST_PG_TEMPLATE).toBe('genie_template');
  });

  test('does NOT create legacy /tmp/genie-test-pg-* data dir', () => {
    // The previous implementation wrote a persistent dir at
    // `/tmp/genie-test-pg-${process.pid}` and never cleaned it up on macOS,
    // leaking 3+ GB across runs. The new single-daemon design omits --data,
    // so pgserve manages its own ephemeral temp dir instead.
    if (!existsSync('/tmp')) return; // skip on non-POSIX weirdness
    const entries = readdirSync('/tmp').filter((n) => n.startsWith('genie-test-pg-'));
    expect(entries).toEqual([]);
  });

  test('getConnection() reaches a live postgres', async () => {
    const { getConnection } = await import('./db.js');
    const sql = await getConnection();
    const [{ one }] = await sql<[{ one: number }]>`SELECT 1::int AS one`;
    expect(one).toBe(1);
  });

  test('template database exists on the test pgserve', async () => {
    const { getConnection } = await import('./db.js');
    const sql = await getConnection();
    const rows = await sql<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname = 'genie_template'
    `;
    expect(rows.length).toBe(1);
  });

  test('admin connection is shared across createTestDatabase / dropTestDatabase', async () => {
    // The shared admin client keeps exactly one TCP session open to the
    // `postgres` maintenance DB for the lifetime of the bun test process.
    // Multiple create/drop cycles must NOT open a new admin session each time.
    const { createTestDatabase, dropTestDatabase } = await import('./test-setup.js');
    const names = ['test_admin_reuse_a', 'test_admin_reuse_b', 'test_admin_reuse_c'];
    for (const n of names) {
      await createTestDatabase(n);
      await dropTestDatabase(n);
    }

    // Filter pg_stat_activity by the per-process application_name we set on
    // the shared admin — that way concurrent bun-test runs sharing one daemon
    // (Group 1's lockfile-reuse path) don't inflate the count. With a shared
    // admin this test sees exactly 1 session; with the old per-call pattern
    // it would oscillate 0↔1 and either value could race through.
    const { getConnection } = await import('./db.js');
    const sql = await getConnection();
    const appName = `genie-test-admin-${process.pid}`;
    const rows = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM pg_stat_activity
      WHERE datname = 'postgres' AND application_name = ${appName}
    `;
    expect(rows[0]?.n ?? 0).toBe(1);
  });
});

describe('test-setup shared-daemon lockfile', () => {
  // The preload runs once per bun-test process. When reuse is enabled (the
  // default), it either finds a valid lockfile and reuses the daemon, or it
  // spawns fresh and writes a new lockfile. Either way, by the time this
  // describe block runs the lockfile exists and points at the live daemon
  // we're currently talking to — unless GENIE_TEST_PG_NO_REUSE is set.
  const noReuse = Boolean(process.env.GENIE_TEST_PG_NO_REUSE);

  test('preload writes a lockfile whose port matches the active test pgserve', async () => {
    if (noReuse) return; // opt-out: no lockfile is expected
    const { __testing } = await import('./test-setup.js');
    const lock = __testing.readPgserveLock();
    expect(lock).not.toBeNull();
    const activePort = Number.parseInt(process.env.GENIE_TEST_PG_PORT ?? '', 10);
    expect(lock?.port).toBe(activePort);
    expect(typeof lock?.pid).toBe('number');
    expect(typeof lock?.startedAt).toBe('number');
  });

  test('reuse case: lockfile pid is alive and lockfile is within max age', async () => {
    if (noReuse) return;
    const { __testing } = await import('./test-setup.js');
    const lock = __testing.readPgserveLock();
    expect(lock).not.toBeNull();
    if (!lock) return;

    // This is the exact check the preload performs on a subsequent bun-test
    // invocation. If all three conditions hold, the second run will reuse
    // without logging `[test-setup] pgserve --ram on port` — the acceptance
    // criterion for reuse.
    expect(__testing.processAlive(lock.pid)).toBe(true);
    expect(__testing.lockWithinMaxAge(lock)).toBe(true);
  });

  test('reap-after-kill: a lockfile pointing at a dead pid is detected as stale', async () => {
    const { __testing } = await import('./test-setup.js');
    // Fabricate a lockfile entry for a pid that cannot exist (pid 0 is the
    // kernel scheduler on POSIX — process.kill(0, 0) reports ESRCH).
    const fake = { port: 29999, pid: 0, startedAt: Date.now() };
    expect(__testing.processAlive(fake.pid)).toBe(false);

    // Age check: a lockfile older than LOCK_MAX_AGE_MS is stale regardless of pid state.
    const old = { port: 29999, pid: 0, startedAt: Date.now() - __testing.LOCK_MAX_AGE_MS - 1 };
    expect(__testing.lockWithinMaxAge(old)).toBe(false);
  });

  test('lockfile round-trips through read / write / remove', async () => {
    const { __testing } = await import('./test-setup.js');
    // Snapshot the real lockfile and restore it at the end so this test
    // doesn't interfere with any other bun-test process sharing the host.
    const original = __testing.readPgserveLock();
    try {
      const sample = { port: 20950, pid: 99999, startedAt: 1_700_000_000_000 };
      __testing.writePgserveLock(sample);
      expect(__testing.readPgserveLock()).toEqual(sample);
      __testing.removePgserveLock();
      expect(__testing.readPgserveLock()).toBeNull();
    } finally {
      if (original) __testing.writePgserveLock(original);
    }
  });

  test('processAlive returns true for the current process and false for pid 0', async () => {
    const { __testing } = await import('./test-setup.js');
    expect(__testing.processAlive(process.pid)).toBe(true);
    expect(__testing.processAlive(0)).toBe(false);
  });
});

describe('test-setup template cache (migration hash)', () => {
  const noReuse = Boolean(process.env.GENIE_TEST_PG_NO_REUSE);

  test('computeMigrationHash returns a stable 64-char hex digest', async () => {
    const { __testing } = await import('./test-setup.js');
    const a = __testing.computeMigrationHash();
    const b = __testing.computeMigrationHash();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (!a || !b) return;
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('preload persists the migration hash in the lockfile', async () => {
    if (noReuse) return;
    const { __testing } = await import('./test-setup.js');
    const lock = __testing.readPgserveLock();
    expect(lock).not.toBeNull();
    const current = __testing.computeMigrationHash();
    expect(lock?.migrationHash).toBe(current ?? undefined);
  });

  test('hash-match skip: template exists and lockfile hash matches current sources', async () => {
    if (noReuse) return;
    const { __testing } = await import('./test-setup.js');
    const activePort = Number.parseInt(process.env.GENIE_TEST_PG_PORT ?? '', 10);
    expect(Number.isNaN(activePort)).toBe(false);

    const current = __testing.computeMigrationHash();
    const lock = __testing.readPgserveLock();
    expect(lock?.migrationHash).toBe(current ?? undefined);
    expect(await __testing.templateDatabaseExists(activePort)).toBe(true);
    // These are the three conditions the preload checks on the reuse fast path.
    // All true ⇒ buildTemplateDatabase is skipped.
  });

  test('hash-mismatch rebuild: a stored hash that differs triggers a rebuild path', async () => {
    if (noReuse) return;
    const { __testing } = await import('./test-setup.js');
    const activePort = Number.parseInt(process.env.GENIE_TEST_PG_PORT ?? '', 10);
    expect(Number.isNaN(activePort)).toBe(false);

    const current = __testing.computeMigrationHash();
    const original = __testing.readPgserveLock();
    expect(original).not.toBeNull();
    if (!original) return;

    try {
      // Simulate a prior run with different migration content. On the next
      // preload this hash would fail the equality check against `current`,
      // forcing dropTemplateDatabase + buildTemplateDatabase.
      const stale = { ...original, migrationHash: 'deadbeef'.repeat(8) };
      __testing.writePgserveLock(stale);
      const reread = __testing.readPgserveLock();
      expect(reread?.migrationHash).toBe(stale.migrationHash);
      expect(reread?.migrationHash).not.toBe(current);

      // Directly exercise the rebuild branch: drop + rebuild must leave the
      // template in a working state for subsequent `CREATE DATABASE ...
      // TEMPLATE genie_template` calls.
      await __testing.dropTemplateDatabase(activePort);
      expect(await __testing.templateDatabaseExists(activePort)).toBe(false);
      await __testing.buildTemplateDatabase(activePort);
      expect(await __testing.templateDatabaseExists(activePort)).toBe(true);
    } finally {
      // Restore the real lockfile so follow-up tests (and subsequent bun-test
      // runs sharing this daemon) observe the true migration hash.
      __testing.writePgserveLock({ ...original, migrationHash: current ?? undefined });
    }
  });
});

describe('test-setup macOS RAM disk (Group 6)', () => {
  test('isMacRamEnabled respects platform and env flag', async () => {
    const { __testing } = await import('./test-setup.js');
    const prev = process.env.GENIE_TEST_MAC_RAM;
    try {
      Reflect.deleteProperty(process.env, 'GENIE_TEST_MAC_RAM');
      expect(__testing.isMacRamEnabled()).toBe(false);

      process.env.GENIE_TEST_MAC_RAM = '1';
      // The platform gate decides whether flag-enabled actually turns on.
      expect(__testing.isMacRamEnabled()).toBe(platform() === 'darwin');

      process.env.GENIE_TEST_MAC_RAM = '0';
      expect(__testing.isMacRamEnabled()).toBe(false);
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, 'GENIE_TEST_MAC_RAM');
      else process.env.GENIE_TEST_MAC_RAM = prev;
    }
  });

  test('macRamMounted reports true once the preload has ensured the volume (darwin + flag)', async () => {
    const { __testing } = await import('./test-setup.js');
    if (!__testing.isMacRamEnabled()) return; // no contract when flag is off — a leftover mount may persist from a prior opt-in run
    expect(__testing.macRamMounted()).toBe(true);
  });

  test('constants point at the documented /Volumes/genie-test-ram paths', async () => {
    const { __testing } = await import('./test-setup.js');
    expect(__testing.MAC_RAM_MOUNT).toBe('/Volumes/genie-test-ram');
    expect(__testing.MAC_RAM_DATA_DIR).toBe('/Volumes/genie-test-ram/pgserve');
  });

  test('env flag set on darwin: pgserve data resides on the RAM volume', async () => {
    if (platform() !== 'darwin') return; // darwin-only smoke
    if (process.env.GENIE_TEST_MAC_RAM !== '1') return; // opt-in only
    const { __testing } = await import('./test-setup.js');
    expect(__testing.macRamMounted()).toBe(true);
    expect(existsSync('/Volumes/genie-test-ram/pgserve')).toBe(true);
  });
});

describe('test-setup lazy-boot detector (Group 5)', () => {
  test('extractPositionalArgs peels flags with and without values', async () => {
    const { __testing } = await import('./test-setup.js');
    const tokens = [
      'bun',
      'test',
      '--preload',
      '/tmp/probe.ts',
      '-t',
      'nomatch',
      '--timeout=500',
      'src/lib/foo.test.ts',
      'src/lib/bar.test.ts',
    ];
    const positional = __testing.extractPositionalArgs(tokens);
    expect(positional).toEqual(['src/lib/foo.test.ts', 'src/lib/bar.test.ts']);
  });

  test('extractPositionalArgs returns null when the `test` subcommand is absent', async () => {
    const { __testing } = await import('./test-setup.js');
    expect(__testing.extractPositionalArgs(['bun', 'run', 'build'])).toBeNull();
  });

  test('extractPositionalArgs returns empty when only flags follow `test`', async () => {
    const { __testing } = await import('./test-setup.js');
    expect(__testing.extractPositionalArgs(['bun', 'test', '--coverage', '-t', 'x'])).toEqual([]);
  });

  test('resolvePositionalToFile accepts a real file path', async () => {
    const { __testing } = await import('./test-setup.js');
    const abs = __testing.resolvePositionalToFile('src/lib/knip-stub.test.ts');
    expect(abs).not.toBeNull();
    expect(abs?.endsWith('src/lib/knip-stub.test.ts')).toBe(true);
  });

  test('resolvePositionalToFile rejects globs, directories, and prefix filters', async () => {
    const { __testing } = await import('./test-setup.js');
    expect(__testing.resolvePositionalToFile('src/lib/*.test.ts')).toBeNull();
    expect(__testing.resolvePositionalToFile('src/lib/')).toBeNull();
    expect(__testing.resolvePositionalToFile('src/lib/cron')).toBeNull();
    expect(__testing.resolvePositionalToFile('src/lib/does-not-exist.test.ts')).toBeNull();
  });

  test('anyFileNeedsPgserve trips on the PG harness markers', async () => {
    const { __testing } = await import('./test-setup.js');
    const pgFile = new URL('./wish-state.test.ts', import.meta.url).pathname;
    const noPgFile = new URL('./knip-stub.test.ts', import.meta.url).pathname;
    expect(__testing.anyFileNeedsPgserve([pgFile])).toBe(true);
    expect(__testing.anyFileNeedsPgserve([noPgFile])).toBe(false);
    expect(__testing.anyFileNeedsPgserve([noPgFile, pgFile])).toBe(true);
  });

  test('anyFileNeedsPgserve returns true when a file is unreadable (safe default)', async () => {
    const { __testing } = await import('./test-setup.js');
    expect(__testing.anyFileNeedsPgserve(['/does/not/exist.ts'])).toBe(true);
  });

  test('PG_HARNESS_MARKERS covers the four canonical signals', async () => {
    const { __testing } = await import('./test-setup.js');
    expect(new Set(__testing.PG_HARNESS_MARKERS)).toEqual(
      new Set(['test-db', 'test-setup', 'getConnection', 'GENIE_TEST_PG']),
    );
  });

  test('shouldLazySkipPgserve is false for this process (test-setup.test.ts references the harness)', async () => {
    // This very test file references `test-setup`, so the detector must see
    // `anyFileNeedsPgserve` = true on the current argv and return false.
    // Proves the happy-path wiring end-to-end under a real bun-test run.
    const { __testing } = await import('./test-setup.js');
    expect(__testing.shouldLazySkipPgserve()).toBe(false);
  });
});

describe('test-setup CREATE DATABASE advisory lock (Group 7)', () => {
  test('CREATE_DB_ADVISORY_LOCK_ID is a stable signed int64 derived from the wish-scoped key', async () => {
    const { __testing } = await import('./test-setup.js');
    // Constant is computed at module load from SHA-256("pg-test-perf:create-db").
    // Any change to the key would shift the lock id and break cross-worker
    // coordination on a running daemon, so we pin the exact value.
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update('pg-test-perf:create-db').digest().readBigInt64BE(0);
    expect(__testing.CREATE_DB_ADVISORY_LOCK_ID).toBe(expected);
    expect(typeof __testing.CREATE_DB_ADVISORY_LOCK_ID).toBe('bigint');
  });

  test('pg_try_advisory_lock on the id is unowned between createTestDatabase calls', async () => {
    // After createTestDatabase returns (success OR failure), the advisory lock
    // must be released so the next shard's clone can proceed. Probe from a
    // fresh session: pg_try_advisory_lock returns false if anyone else holds
    // it. Under CI's parallel-shard runner, 4 shards share one pgserve and any
    // shard may currently hold the lock during its own createTestDatabase call,
    // so we retry until the lock is observed unowned within a deadline.
    const { __testing } = await import('./test-setup.js');
    const port = Number.parseInt(process.env.GENIE_TEST_PG_PORT ?? '', 10);
    expect(Number.isNaN(port)).toBe(false);

    const { default: postgres } = await import('postgres');
    const probe = postgres({
      host: '127.0.0.1',
      port,
      database: 'postgres',
      username: 'postgres',
      password: 'postgres',
      max: 1,
      idle_timeout: 1,
      onnotice: () => {},
    });
    try {
      const lockIdStr = __testing.CREATE_DB_ADVISORY_LOCK_ID.toString();
      const deadline = Date.now() + 2000;
      let got = false;
      while (Date.now() < deadline) {
        const rows = await probe.unsafe<{ got: boolean }[]>(`SELECT pg_try_advisory_lock(${lockIdStr}::bigint) AS got`);
        got = rows[0]?.got === true;
        if (got) {
          await probe.unsafe(`SELECT pg_advisory_unlock(${lockIdStr}::bigint)`);
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(got).toBe(true);
    } finally {
      await probe.end({ timeout: 2 }).catch(() => {
        /* best-effort */
      });
    }
  });

  test('concurrent createTestDatabase calls succeed without template-busy races', async () => {
    // Four simultaneous clones of genie_template — exactly what the parallel
    // shard runner does at cold start — must all succeed. Before the advisory
    // lock was added, two of four routinely died with
    //   "source database is being accessed by other users"
    // because pgserve briefly keeps an admin session open on the template
    // between CREATE DATABASE calls. Serialization via pg_advisory_lock
    // makes them queue instead of racing.
    const { createTestDatabase, dropTestDatabase } = await import('./test-setup.js');
    const names = [0, 1, 2, 3].map((i) => `test_group7_concurrent_${process.pid}_${Date.now()}_${i}`);
    try {
      await Promise.all(names.map((n) => createTestDatabase(n)));
    } finally {
      await Promise.all(
        names.map((n) =>
          dropTestDatabase(n).catch(() => {
            /* best-effort */
          }),
        ),
      );
    }
  });
});
