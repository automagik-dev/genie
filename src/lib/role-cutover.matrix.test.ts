/**
 * Goal-A Group 4 — the rollout HARDENING matrix.
 *
 * Wave 3 flips `GENIE_ROLE_CUTOVER` to DEFAULT-ON behind the documented
 * kill-switch (`=0`). This file is the edge-case matrix the wish mandates
 * before that flip ships:
 *
 *   (a) N=8 concurrent boots ⇒ exactly ONE provision via pg_try_advisory_lock,
 *       none block, all converge connected as the scoped role.
 *   (b) fallback trio (pgserve unreachable / grant query fails / role missing)
 *       ⇒ clean postgres/postgres, no hard-fail, out-of-band fallback event.
 *   (c) multi-fingerprint host (2 fingerprints, 1 home) ⇒ each cuts over
 *       independently; the per-fingerprint sentinel is never stranded.
 *   (d) test-mode (GENIE_TEST_PG_PORT) + GENIE_PG_FORCE_TCP ⇒ SKIP, the rebind
 *       never lands on the accept-hook / TCP / test paths (byte-identical).
 *   (e) kill-switch GENIE_ROLE_CUTOVER=0 ⇒ legacy postgres/postgres exactly as
 *       before; the default-on contract holds for unset / `1` / other values.
 *
 * Pure + mock sections always run; the concurrency section is DB-backed and
 * skips cleanly when pgserve is unavailable.
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
  inspectRoleCutover,
  isRoleCutoverEnabled,
  readRoleCutoverSentinel,
  resolveScopedConnectionIdentity,
  roleCutoverSentinelPath,
  writeRoleCutoverSentinel,
} from './role-cutover.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

const PID = process.pid;
const ROLE = `pgserve_rcmtx_${PID}_role`;
const FP = `cc${PID.toString(16)}`.slice(0, 12);

function recorder(): { events: RoleCutoverEvent[]; sink: (e: RoleCutoverEvent) => void } {
  const events: RoleCutoverEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[key];
  if (value === undefined) process.env[key] = undefined;
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) process.env[key] = undefined;
    else process.env[key] = prev;
  }
}

// Throwing stub — proves a code path performs NO DB I/O.
const throwingSql = {
  reserve: () => Promise.reject(new Error('sql must not be touched')),
  unsafe: () => Promise.reject(new Error('sql must not be touched')),
} as unknown as Parameters<typeof resolveScopedConnectionIdentity>[0]['sql'];

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
      return Promise.resolve([]);
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

// ============================================================================
// GENIE_HOME isolation — sentinel files never touch the operator's ~/.genie.
// ============================================================================

let homeDir: string;
let prevHome: string | undefined;

beforeAll(() => {
  prevHome = process.env.GENIE_HOME;
  homeDir = mkdtempSync(join(tmpdir(), 'genie-rcmtx-'));
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
// (e) Kill-switch + default-on contract.
// ============================================================================

describe('(e) kill-switch + default-on gate', () => {
  it('GENIE_ROLE_CUTOVER=0 is the ONLY off state; unset / 1 / other ⇒ ON', () => {
    expect(withEnv('GENIE_ROLE_CUTOVER', '0', () => isRoleCutoverEnabled())).toBe(false);
    expect(withEnv('GENIE_ROLE_CUTOVER', undefined, () => isRoleCutoverEnabled())).toBe(true);
    expect(withEnv('GENIE_ROLE_CUTOVER', '1', () => isRoleCutoverEnabled())).toBe(true);
    expect(withEnv('GENIE_ROLE_CUTOVER', '2', () => isRoleCutoverEnabled())).toBe(true);
    expect(withEnv('GENIE_ROLE_CUTOVER', 'true', () => isRoleCutoverEnabled())).toBe(true);
  });

  it('kill-switch ⇒ resolveScopedConnectionIdentity is legacy postgres/postgres, zero DB I/O', async () => {
    const { events, sink } = recorder();
    const id = await withEnv('GENIE_ROLE_CUTOVER', '0', () =>
      resolveScopedConnectionIdentity({ sql: throwingSql, database: 'postgres', sink }),
    );
    expect(id.cutover).toBe(false);
    expect(id.username).toBe('postgres');
    expect(id.database).toBe('postgres');
    expect(id.reason).toBe('disabled');
    expect(events.map((e) => e.event)).toEqual(['role-cutover.skip.disabled']);
  });

  it('kill-switch ⇒ ensureScopedRole is a pure no-op (sql untouched)', async () => {
    const { events, sink } = recorder();
    const result = await withEnv('GENIE_ROLE_CUTOVER', '0', () =>
      ensureScopedRole({
        sql: {
          reserve: () => Promise.reject(new Error('sql must not be touched when killed')),
        } as unknown as Parameters<typeof ensureScopedRole>[0]['sql'],
        sink,
      }),
    );
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('disabled');
    expect(events.map((e) => e.event)).toEqual(['role-cutover.skip.disabled']);
  });

  it('inspectRoleCutover reports the kill-switch + default-on state read-only', () => {
    const killed = withEnv('GENIE_ROLE_CUTOVER', '0', () => inspectRoleCutover());
    expect(killed.enabled).toBe(false);
    expect(killed.killSwitch).toBe(true);

    const live = withEnv('GENIE_ROLE_CUTOVER', undefined, () => inspectRoleCutover());
    expect(live.enabled).toBe(true);
    expect(live.killSwitch).toBe(false);
    // Dev/test tree resolves a stable fingerprint → deterministic role name.
    if (live.roleName !== null) {
      expect(live.roleName).toMatch(/^pgserve_.*_role$/);
      expect(live.sentinelPath).toContain(homeDir);
    }
  });
});

// ============================================================================
// (b) Fallback trio — every degraded path ⇒ clean postgres/postgres, NO throw.
// ============================================================================

describe('(b) fallback trio never hard-fails boot', () => {
  afterEach(() => clearRoleCutoverSentinel(FP));

  it('pgserve unreachable (reserve throws) ⇒ clean postgres/postgres + fallback event', async () => {
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

  it('grant/lookup query fails ⇒ clean fallback (query-failed)', async () => {
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
    writeRoleCutoverSentinel(FP, { roleName: ROLE, database: 'mismatch-forces-revalidate' });
    expect(readRoleCutoverSentinel(FP)).not.toBeNull();
    const { events, sink } = recorder();
    const id = await resolveScopedConnectionIdentity({
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
    expect(readRoleCutoverSentinel(FP)).toBeNull();
  });
});

// ============================================================================
// (c) Multi-fingerprint host — sentinel keyed per fingerprint, never stranded.
// ============================================================================

describe('(c) multi-fingerprint host cuts over independently', () => {
  const FP_A = FP;
  const FP_B = `dd${PID.toString(16)}`.slice(0, 12);
  const ROLE_A = ROLE;
  const ROLE_B = `pgserve_rcmtxb_${PID}_role`;

  afterEach(() => {
    clearRoleCutoverSentinel(FP_A);
    clearRoleCutoverSentinel(FP_B);
  });

  it('two fingerprints in one home get distinct sentinels and cut over separately', async () => {
    // Checkout A cuts over.
    const a = await resolveScopedConnectionIdentity({
      sql: mockSql({ lock: true, roleExists: true }),
      database: 'postgres',
      roleName: ROLE_A,
      fingerprintHex: FP_A,
      enabled: true,
      sink: () => {},
    });
    expect(a.cutover).toBe(true);
    expect(a.username).toBe(ROLE_A);

    // Distinct sentinel paths; B does NOT see A's sentinel.
    expect(roleCutoverSentinelPath(FP_A)).not.toBe(roleCutoverSentinelPath(FP_B));
    expect(readRoleCutoverSentinel(FP_A)).not.toBeNull();
    expect(readRoleCutoverSentinel(FP_B)).toBeNull();

    // Checkout B is NOT stranded by A's sentinel — it provisions its own.
    const { events, sink } = recorder();
    const b = await resolveScopedConnectionIdentity({
      sql: mockSql({ lock: true, roleExists: true }),
      database: 'postgres',
      roleName: ROLE_B,
      fingerprintHex: FP_B,
      enabled: true,
      sink,
    });
    expect(b.cutover).toBe(true);
    expect(b.username).toBe(ROLE_B); // NOT ROLE_A
    expect(events.map((e) => e.event)).toContain('role-cutover.cutover');
    expect(readRoleCutoverSentinel(FP_B)?.roleName).toBe(ROLE_B);
    // A's sentinel still intact — B did not stomp it.
    expect(readRoleCutoverSentinel(FP_A)?.roleName).toBe(ROLE_A);
  });
});

// ============================================================================
// (d) Test-mode / FORCE_TCP / accept-hook ⇒ rebind NEVER lands (byte-identical
// to legacy). The rebind gate is `shouldAttemptRoleCutover`; only the
// direct-postmaster bypass carries it.
// ============================================================================

describe('(d) test-mode + FORCE_TCP + accept-hook skip — rebind never lands', () => {
  it('direct-postmaster bypass is the ONLY path that rebinds', () => {
    // The load-bearing path: enabled + not test + admin.json present.
    expect(shouldAttemptRoleCutover({ enabled: true, isTestMode: false, directPostmaster: true })).toBe(true);
    // Test mode (GENIE_TEST_PG_PORT harness) ⇒ never rebind, even on the bypass.
    expect(shouldAttemptRoleCutover({ enabled: true, isTestMode: true, directPostmaster: true })).toBe(false);
    // FORCE_TCP / accept-hook / router path (no admin.json ⇒ directPostmaster
    // false) ⇒ never rebind (rebinding it is a silent no-op trap).
    expect(shouldAttemptRoleCutover({ enabled: true, isTestMode: false, directPostmaster: false })).toBe(false);
    expect(shouldAttemptRoleCutover({ enabled: true, isTestMode: true, directPostmaster: false })).toBe(false);
    // Kill-switch ⇒ never rebind regardless of path.
    expect(shouldAttemptRoleCutover({ enabled: false, isTestMode: false, directPostmaster: true })).toBe(false);
  });

  it('disabled gate ⇒ resolveScopedConnectionIdentity stays byte-identical legacy', async () => {
    const { events, sink } = recorder();
    const id = await resolveScopedConnectionIdentity({
      sql: throwingSql,
      database: 'postgres',
      enabled: false,
      sink,
    });
    expect(id).toEqual({
      username: 'postgres',
      database: 'postgres',
      cutover: false,
      fingerprintHex: null,
      reason: 'disabled',
    });
    expect(events.map((e) => e.event)).toEqual(['role-cutover.skip.disabled']);
  });
});

// ============================================================================
// (a) N=8 concurrent boots — DB-backed. Single provision via the non-blocking
// advisory lock; none block; convergence to the scoped role.
// ============================================================================

describe.skipIf(!DB_AVAILABLE)('(a) N=8 concurrent boots (pg)', () => {
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

  async function dropRole(): Promise<void> {
    const exists = await sql.unsafe(`SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}'`);
    if (exists.length === 0) return;
    await sql.unsafe(`DROP OWNED BY "${ROLE}"`);
    await sql.unsafe(`DROP ROLE IF EXISTS "${ROLE}"`);
  }

  it('cold storm: provisioned exactly once, none block, none error or throw', async () => {
    await dropRole();
    clearRoleCutoverSentinel(FP);
    const N = 8;
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        resolveScopedConnectionIdentity({
          sql,
          database,
          roleName: ROLE,
          fingerprintHex: FP,
          enabled: true,
          sink: () => {},
        }),
      ),
    );
    const elapsed = Date.now() - started;

    expect(results).toHaveLength(N);
    // Every boot is SAFE: it either cut over as the scoped role or fell back
    // CLEANLY to postgres (a loser that checked pg_roles before the winner
    // committed). NEVER an error, NEVER a throw, NEVER a hung boot.
    for (const r of results) {
      if (r.cutover) {
        expect(r.username).toBe(ROLE);
      } else {
        expect(r.username).toBe('postgres');
        expect(r.reason).not.toBe('query-failed');
      }
      expect(r.database).toBe(database);
    }
    // Single provision: the advisory lock guarantees the role is created at
    // most once — it exists exactly once afterwards.
    const count = await sql.unsafe(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = '${ROLE}'`);
    expect(count[0].n).toBe(1);
    // Non-blocking: a contended lock returns immediately. Generous CI bound.
    expect(elapsed).toBeLessThan(20_000);
  }, 45_000);

  it('warm storm: role pre-exists ⇒ all 8 concurrent boots converge as the scoped role', async () => {
    // Provision once, then clear the sentinel so all 8 race the revalidation
    // path with the role already present — no role-missing race window.
    await ensureScopedRole({ sql, roleName: ROLE, database, enabled: true, sink: () => {} });
    clearRoleCutoverSentinel(FP);
    const N = 8;
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        resolveScopedConnectionIdentity({
          sql,
          database,
          roleName: ROLE,
          fingerprintHex: FP,
          enabled: true,
          sink: () => {},
        }),
      ),
    );
    const elapsed = Date.now() - started;

    expect(results).toHaveLength(N);
    for (const r of results) {
      expect(r.cutover).toBe(true);
      expect(r.username).toBe(ROLE);
      expect(r.database).toBe(database);
    }
    // Still exactly one role — concurrent revalidation never re-creates it.
    const count = await sql.unsafe(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = '${ROLE}'`);
    expect(count[0].n).toBe(1);
    expect(elapsed).toBeLessThan(20_000);
  }, 45_000);
});
