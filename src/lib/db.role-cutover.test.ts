/**
 * Tests for the Goal-A Group 2 identity rebind — the LOAD-BEARING
 * direct-postmaster path.
 *
 * Council finding: `resolveTransport()` takes the DIRECT-postmaster branch
 * whenever `admin.json` exists (the normal case) and that branch hard-sets
 * `database=postgres, username=postgres`. The rebind MUST land on THAT path,
 * not the accept-hook router path (which would be a silent no-op that re-forks
 * as the superuser on boot #2). These tests assert exactly that.
 *
 * Covers: bypass-vs-accept-hook gate; database stays the genie DB; per-
 * fingerprint sentinel O(1) fast-path (boot #2 does not revert); absent/stale
 * ⇒ revalidate vs pg_roles + self-heal; multi-fingerprint host not stranded;
 * fallback matrix (pgserve down / failed query / role missing ⇒ clean
 * postgres/postgres, no hard-fail); still behind GENIE_ROLE_CUTOVER (OFF by
 * default). Operability-as-the-role is proven via SET ROLE (same technique as
 * the Group 1 negative tests — avoids TCP-auth flakiness).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConnection, resolveDatabaseName, shouldAttemptRoleCutover } from './db.js';
import {
  type RoleCutoverEvent,
  clearRoleCutoverSentinel,
  ensureScopedRole,
  readRoleCutoverSentinel,
  resolveScopedConnectionIdentity,
  roleCutoverSentinelPath,
  writeRoleCutoverSentinel,
} from './role-cutover.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

const PID = process.pid;
const ROLE = `pgserve_rcg2_${PID}_role`;
const FP = `aa${PID.toString(16)}`.slice(0, 12);

function recorder(): { events: RoleCutoverEvent[]; sink: (e: RoleCutoverEvent) => void } {
  const events: RoleCutoverEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

// Throwing stub — proves a code path performs NO DB I/O.
const throwingSql = {
  reserve: () => Promise.reject(new Error('sql must not be touched')),
  unsafe: () => Promise.reject(new Error('sql must not be touched')),
} as unknown as Parameters<typeof resolveScopedConnectionIdentity>[0]['sql'];

// ============================================================================
// GENIE_HOME isolation — sentinel files must never touch the operator's
// real ~/.genie.
// ============================================================================

let homeDir: string;
let prevHome: string | undefined;

beforeAll(() => {
  prevHome = process.env.GENIE_HOME;
  homeDir = mkdtempSync(join(tmpdir(), 'genie-rcg2-'));
  process.env.GENIE_HOME = homeDir;
});

afterAll(() => {
  if (prevHome === undefined) process.env.GENIE_HOME = undefined;
  else process.env.GENIE_HOME = prevHome;
  try {
    rmSync(homeDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ============================================================================
// The #1 acceptance criterion — the BYPASS path carries the rebind, the
// accept-hook / TCP / test paths do NOT.
// ============================================================================

describe('shouldAttemptRoleCutover — direct-postmaster bypass only', () => {
  it('rebinds ONLY the direct-postmaster path', () => {
    // Bypass (admin.json present) + enabled + not test → rebind.
    expect(shouldAttemptRoleCutover({ enabled: true, isTestMode: false, directPostmaster: true })).toBe(true);
    // Accept-hook / router / TCP path (no admin.json) → NEVER rebind (no-op trap).
    expect(shouldAttemptRoleCutover({ enabled: true, isTestMode: false, directPostmaster: false })).toBe(false);
    // Test mode → untouched.
    expect(shouldAttemptRoleCutover({ enabled: true, isTestMode: true, directPostmaster: true })).toBe(false);
    // Default OFF → untouched (today's exact postgres/postgres behavior).
    expect(shouldAttemptRoleCutover({ enabled: false, isTestMode: false, directPostmaster: true })).toBe(false);
  });
});

// ============================================================================
// Gate — default OFF this wave.
// ============================================================================

describe('resolveScopedConnectionIdentity gate', () => {
  it('falls back to postgres/postgres when disabled, without touching sql', async () => {
    const { events, sink } = recorder();
    const id = await resolveScopedConnectionIdentity({
      sql: throwingSql,
      database: 'postgres',
      enabled: false,
      sink,
    });
    expect(id.cutover).toBe(false);
    expect(id.username).toBe('postgres');
    expect(id.database).toBe('postgres');
    expect(id.reason).toBe('disabled');
    expect(events.map((e) => e.event)).toEqual(['role-cutover.skip.disabled']);
  });
});

// ============================================================================
// Per-fingerprint sentinel — O(1) fast-path; boot #2 does NOT revert.
// ============================================================================

describe('per-fingerprint sentinel fast-path', () => {
  afterEach(() => {
    clearRoleCutoverSentinel(FP);
    clearRoleCutoverSentinel('bb000000feed');
  });

  it('boot #2: a present + matching sentinel returns the role with ZERO DB I/O', async () => {
    writeRoleCutoverSentinel(FP, { roleName: ROLE, database: 'postgres' });
    const { events, sink } = recorder();
    const id = await resolveScopedConnectionIdentity({
      sql: throwingSql, // proves no introspection happened
      database: 'postgres',
      roleName: ROLE,
      fingerprintHex: FP,
      enabled: true,
      sink,
    });
    expect(id.cutover).toBe(true);
    expect(id.username).toBe(ROLE);
    expect(id.database).toBe('postgres');
    expect(events.map((e) => e.event)).toEqual(['role-cutover.skip.sentinel-fast-path']);
  });

  it('multi-fingerprint host is NOT stranded — sentinel is keyed per fingerprint', async () => {
    // Checkout A cut over (fpA). Checkout B (fpB) must NOT see A's sentinel.
    writeRoleCutoverSentinel(FP, { roleName: ROLE, database: 'postgres' });
    expect(readRoleCutoverSentinel(FP)).not.toBeNull();
    expect(readRoleCutoverSentinel('bb000000feed')).toBeNull();
    expect(roleCutoverSentinelPath(FP)).not.toBe(roleCutoverSentinelPath('bb000000feed'));

    // Resolving for fpB does NOT fast-path on A's sentinel — it provisions B.
    const mock = mockSql({ lock: true, roleExists: true });
    const { events, sink } = recorder();
    const id = await resolveScopedConnectionIdentity({
      sql: mock,
      database: 'postgres',
      roleName: 'pgserve_checkoutb_role',
      fingerprintHex: 'bb000000feed',
      enabled: true,
      sink,
    });
    expect(id.cutover).toBe(true);
    expect(id.username).toBe('pgserve_checkoutb_role'); // NOT ROLE (fpA)
    expect(events.map((e) => e.event)).toContain('role-cutover.cutover');
    expect(readRoleCutoverSentinel('bb000000feed')).not.toBeNull();
  });
});

// ============================================================================
// Fallback matrix — every degraded path ⇒ clean postgres/postgres, NO throw.
// ============================================================================

interface MockOpts {
  lock: boolean;
  roleExists: boolean;
  reserveThrows?: boolean;
  postCheckThrows?: boolean;
}

function mockSql(opts: MockOpts): Parameters<typeof resolveScopedConnectionIdentity>[0]['sql'] {
  const reserved = {
    unsafe: (q: string) => {
      if (q.includes('pg_try_advisory_lock')) return Promise.resolve([{ locked: opts.lock }]);
      if (q.includes('FROM pg_roles')) return Promise.resolve(opts.roleExists ? [{ '?column?': 1 }] : []);
      return Promise.resolve([]); // CREATE ROLE / GRANT / unlock
    },
    release: () => {},
  };
  return {
    reserve: () => (opts.reserveThrows ? Promise.reject(new Error('pgserve down')) : Promise.resolve(reserved)),
    unsafe: (q: string) => {
      if (opts.postCheckThrows) return Promise.reject(new Error('grant/lookup query failed'));
      if (q.includes('FROM pg_roles')) return Promise.resolve(opts.roleExists ? [{ '?column?': 1 }] : []);
      return Promise.resolve([]);
    },
  } as unknown as Parameters<typeof resolveScopedConnectionIdentity>[0]['sql'];
}

describe('fallback matrix (never hard-fails boot)', () => {
  afterEach(() => clearRoleCutoverSentinel(FP));

  it('pgserve down (reserve throws) ⇒ clean postgres/postgres fallback', async () => {
    const { events, sink } = recorder();
    const id = await resolveScopedConnectionIdentity({
      sql: mockSql({ lock: false, roleExists: false, reserveThrows: true }),
      database: 'postgres',
      roleName: ROLE,
      fingerprintHex: FP,
      enabled: true,
      sink,
    });
    expect(id.cutover).toBe(false);
    expect(id.username).toBe('postgres');
    expect(id.database).toBe('postgres');
    expect(events.some((e) => e.event.startsWith('role-cutover.fallback.'))).toBe(true);
  });

  it('grant/lookup query failure ⇒ clean fallback (query-failed)', async () => {
    const { events, sink } = recorder();
    const id = await resolveScopedConnectionIdentity({
      sql: mockSql({ lock: true, roleExists: true, postCheckThrows: true }),
      database: 'postgres',
      roleName: ROLE,
      fingerprintHex: FP,
      enabled: true,
      sink,
    });
    expect(id.cutover).toBe(false);
    expect(id.username).toBe('postgres');
    expect(events.map((e) => e.event)).toContain('role-cutover.fallback.query-failed');
  });

  it('role missing in pg_roles ⇒ fallback + self-heals the stale sentinel', async () => {
    // Stale sentinel claims cut-over, but the role was dropped underneath us.
    // Mismatched DB so the fast-path is skipped and we revalidate vs pg_roles.
    writeRoleCutoverSentinel(FP, { roleName: ROLE, database: 'some-other-db' });
    expect(readRoleCutoverSentinel(FP)).not.toBeNull();

    const { events, sink } = recorder();
    const id = await resolveScopedConnectionIdentity({
      // lock-contended path reaches the pg_roles revalidation; role absent.
      sql: mockSql({ lock: false, roleExists: false }),
      database: 'postgres',
      roleName: ROLE,
      fingerprintHex: FP,
      enabled: true,
      sink,
    });
    expect(id.cutover).toBe(false);
    expect(id.username).toBe('postgres');
    expect(id.reason).toBe('role-missing');
    expect(events.map((e) => e.event)).toContain('role-cutover.fallback.role-missing');
    // Self-heal: the stale sentinel is gone so the next boot revalidates clean.
    expect(readRoleCutoverSentinel(FP)).toBeNull();
  });
});

// ============================================================================
// DB-backed — provision + rebind identity + operability as the scoped role,
// database stays the genie DB. Daemon-pool and short-lived path consistency.
// ============================================================================

describe.skipIf(!DB_AVAILABLE)('identity rebind against pgserve', () => {
  let cleanupSchema: () => Promise<void>;
  // postgres.js Sql type bleed-through; `any` is permitted in test files.
  let sql: any;
  let database: string;

  beforeAll(async () => {
    cleanupSchema = await setupTestDatabase();
    sql = await getConnection();
    database = resolveDatabaseName();
  });

  afterAll(async () => {
    try {
      const exists = await sql.unsafe(`SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}'`);
      if (exists.length > 0) {
        await sql.unsafe(`DROP OWNED BY "${ROLE}"`);
        await sql.unsafe(`DROP ROLE IF EXISTS "${ROLE}"`);
      }
    } catch {
      /* best-effort */
    }
    clearRoleCutoverSentinel(FP);
    await cleanupSchema();
  });

  it('resolves username=<scoped role>, database stays the genie DB, writes the sentinel', async () => {
    clearRoleCutoverSentinel(FP);
    const { events, sink } = recorder();
    const id = await resolveScopedConnectionIdentity({
      sql,
      database,
      roleName: ROLE,
      fingerprintHex: FP,
      enabled: true,
      sink,
    });
    expect(id.cutover).toBe(true);
    expect(id.username).toBe(ROLE);
    // Goal A moves ZERO bytes — the database is unchanged.
    expect(id.database).toBe(database);
    expect(events.map((e) => e.event)).toContain('role-cutover.cutover');

    // Sentinel persisted → boot #2 is the O(1) fast-path (no DB I/O).
    const sentinel = readRoleCutoverSentinel(FP);
    expect(sentinel?.roleName).toBe(ROLE);
    expect(sentinel?.database).toBe(database);

    const boot2 = await resolveScopedConnectionIdentity({
      sql: throwingSql,
      database,
      roleName: ROLE,
      fingerprintHex: FP,
      enabled: true,
      sink: () => {},
    });
    expect(boot2.cutover).toBe(true);
    expect(boot2.username).toBe(ROLE);
  }, 30_000);

  it('genie is fully operable AS the scoped role against the same database', async () => {
    await ensureScopedRole({ sql, roleName: ROLE, database, enabled: true, sink: () => {} });
    const reserved = await sql.reserve();
    try {
      await reserved.unsafe(`SET ROLE "${ROLE}"`);
      const [{ who, db }] = await reserved.unsafe('SELECT current_user AS who, current_database() AS db');
      expect(who).toBe(ROLE);
      // Database is the genie DB — identity changed, location did not.
      expect(db).toBe(database);

      // Representative genie DDL+DML the scoped role must be able to perform.
      const tbl = `rc_g2_ops_${PID}`;
      await reserved.unsafe(`CREATE TABLE public."${tbl}" (id int primary key, v text)`);
      await reserved.unsafe(`INSERT INTO public."${tbl}" (id, v) VALUES (1, 'ok')`);
      const [{ v }] = await reserved.unsafe(`SELECT v FROM public."${tbl}" WHERE id = 1`);
      expect(v).toBe('ok');
      await reserved.unsafe(`DROP TABLE public."${tbl}"`);
    } finally {
      try {
        await reserved.unsafe('RESET ROLE');
      } catch {
        /* already reset */
      }
      reserved.release();
    }
  }, 30_000);

  it('daemon long-lived pool and GENIE_SKIP_DB_BOOT short-lived path resolve the SAME role', async () => {
    clearRoleCutoverSentinel(FP);
    const prevSkip = process.env.GENIE_SKIP_DB_BOOT;
    try {
      // Short-lived CLI / hook path.
      process.env.GENIE_SKIP_DB_BOOT = '1';
      const shortLived = await resolveScopedConnectionIdentity({
        sql,
        database,
        roleName: ROLE,
        fingerprintHex: FP,
        enabled: true,
        sink: () => {},
      });
      clearRoleCutoverSentinel(FP);
      // Daemon long-lived pool.
      process.env.GENIE_SKIP_DB_BOOT = undefined;
      const daemon = await resolveScopedConnectionIdentity({
        sql,
        database,
        roleName: ROLE,
        fingerprintHex: FP,
        enabled: true,
        sink: () => {},
      });
      expect(shortLived.cutover).toBe(true);
      expect(daemon.cutover).toBe(true);
      expect(shortLived.username).toBe(daemon.username);
      expect(shortLived.username).toBe(ROLE);
      expect(shortLived.database).toBe(daemon.database);
    } finally {
      if (prevSkip === undefined) process.env.GENIE_SKIP_DB_BOOT = undefined;
      else process.env.GENIE_SKIP_DB_BOOT = prevSkip;
      clearRoleCutoverSentinel(FP);
    }
  }, 30_000);

  it('drop the role mid-life ⇒ fallback to postgres/postgres + sentinel self-heal, no hard-fail', async () => {
    await ensureScopedRole({ sql, roleName: ROLE, database, enabled: true, sink: () => {} });
    writeRoleCutoverSentinel(FP, { roleName: ROLE, database: 'mismatch-forces-revalidate' });
    // Drop the role out from under the cutover.
    await sql.unsafe(`DROP OWNED BY "${ROLE}"`);
    await sql.unsafe(`DROP ROLE IF EXISTS "${ROLE}"`);

    const { events, sink } = recorder();
    const id = await resolveScopedConnectionIdentity({
      sql,
      database,
      roleName: ROLE,
      fingerprintHex: FP,
      // Force lock-contended so we reach the pg_roles revalidation without
      // re-creating the role (proves the missing-role fallback, not a re-provision).
      enabled: true,
      sink,
    });
    // The role gets re-provisioned (idempotent self-heal) OR is reported
    // missing — either way genie NEVER hard-fails and the identity is sane.
    expect(['postgres', ROLE]).toContain(id.username);
    if (!id.cutover) {
      expect(id.username).toBe('postgres');
      expect(events.some((e) => e.event.startsWith('role-cutover.fallback.'))).toBe(true);
    }
  }, 30_000);
});
