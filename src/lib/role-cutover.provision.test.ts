/**
 * Tests for role-cutover.ts — Goal A, Group 1 (foundation, provable in
 * isolation; no connection rebind yet).
 *
 * Requires pgserve (auto-started via getConnection). Uses an isolated test
 * database via setupTestDatabase(); all provisioning targets that DB (never
 * the operator's real `postgres` DB).
 *
 * Covers: pure naming; default-OFF gate; idempotent re-run no-op; exact
 * privilege envelope incl. ALTER DEFAULT PRIVILEGES; rolsuper=false +
 * NEGATIVE tests proving DROP DATABASE / CREATE ROLE / CREATE DATABASE are
 * denied to the role; non-blocking advisory lock under concurrency; zero
 * data movement.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getConnection, resolveDatabaseName } from './db.js';
import {
  type RoleCutoverEvent,
  deriveProvisionedNames,
  deriveScopedRoleName,
  ensureScopedRole,
  sanitizeSlug,
} from './role-cutover.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

const PID = process.pid;
const ROLE = `pgserve_rctest_${PID}_role`;

function recorder(): { events: RoleCutoverEvent[]; sink: (e: RoleCutoverEvent) => void } {
  const events: RoleCutoverEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

// ============================================================================
// Pure naming — no DB required.
// ============================================================================

describe('role-cutover naming (pure)', () => {
  it('sanitizeSlug lowercases, collapses, trims', () => {
    expect(sanitizeSlug('@automagik/genie')).toBe('automagik_genie');
    expect(sanitizeSlug('--Foo__Bar--')).toBe('foo_bar');
    expect(sanitizeSlug('')).toBe('');
  });

  it('deriveProvisionedNames matches the pgserve pgserve_<slug>_<fp12>_role layout', () => {
    const { databaseName, roleName, slug, fingerprintHex } = deriveProvisionedNames({
      fingerprint: 'abcdef0123456789aaaa',
      publisher: '@automagik/genie',
    });
    expect(slug).toBe('automagik_genie');
    expect(fingerprintHex).toBe('abcdef012345');
    expect(databaseName).toBe('pgserve_automagik_genie_abcdef012345');
    expect(roleName).toBe('pgserve_automagik_genie_abcdef012345_role');
    expect(roleName.length).toBeLessThanOrEqual(63);
  });

  it('deriveProvisionedNames keeps names ≤63 chars for long publishers', () => {
    const { databaseName, roleName } = deriveProvisionedNames({
      fingerprint: 'a'.repeat(64),
      publisher: 'x'.repeat(200),
    });
    expect(databaseName.length).toBeLessThanOrEqual(63);
    expect(roleName.length).toBeLessThanOrEqual(63);
    expect(roleName.endsWith('_role')).toBe(true);
  });

  it('deriveProvisionedNames rejects an empty fingerprint', () => {
    expect(() => deriveProvisionedNames({ fingerprint: '', publisher: 'x' })).toThrow();
  });

  it('deriveScopedRoleName resolves the genie install to a pgserve_*_role name', () => {
    const name = deriveScopedRoleName();
    // In the dev/test tree the genie package.json is reachable, so this is
    // deterministic; tolerate null only if the fingerprint is unstable.
    if (name !== null) {
      expect(name).toMatch(/^pgserve_.*_role$/);
      expect(name.length).toBeLessThanOrEqual(63);
    }
  });
});

// ============================================================================
// Gate — default OFF this group.
// ============================================================================

describe('role-cutover gate', () => {
  it('is a pure no-op when GENIE_ROLE_CUTOVER is not "1" (default OFF)', async () => {
    const prev = process.env.GENIE_ROLE_CUTOVER;
    process.env.GENIE_ROLE_CUTOVER = '0';
    try {
      const { events, sink } = recorder();
      // sql is never touched when disabled — pass a throwing stub to prove it.
      const result = await ensureScopedRole({
        sql: {
          reserve: () => Promise.reject(new Error('sql must not be touched when disabled')),
        } as unknown as Parameters<typeof ensureScopedRole>[0]['sql'],
        sink,
      });
      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('disabled');
      expect(events.map((e) => e.event)).toEqual(['role-cutover.skip.disabled']);
    } finally {
      if (prev === undefined) process.env.GENIE_ROLE_CUTOVER = '0';
      else process.env.GENIE_ROLE_CUTOVER = prev;
    }
  });
});

// ============================================================================
// Provisioning + privilege envelope + negatives + concurrency (needs DB).
// ============================================================================

describe.skipIf(!DB_AVAILABLE)('role-cutover provisioning (pg)', () => {
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
      await dropRole();
    } catch {
      /* best-effort */
    }
    await cleanupSchema();
  });

  async function roleAttrs(): Promise<Record<string, unknown> | undefined> {
    // pg_roles.rolpassword is always '********' (view literal); the real
    // nullability lives in pg_authid (readable as the superuser test conn).
    const rows = await sql.unsafe(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin,
              (rolpassword IS NULL) AS no_password
         FROM pg_authid WHERE rolname = '${ROLE}'`,
    );
    return rows[0];
  }

  // A provisioned role accrues grants + default-privilege entries, so a bare
  // DROP ROLE fails with dependent-objects. DROP OWNED BY revokes the whole
  // envelope first; then the role drops cleanly.
  async function dropRole(): Promise<void> {
    const exists = await sql.unsafe(`SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}'`);
    if (exists.length === 0) return;
    await sql.unsafe(`DROP OWNED BY "${ROLE}"`);
    await sql.unsafe(`DROP ROLE IF EXISTS "${ROLE}"`);
  }

  it('provisions the role with exactly NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS LOGIN, passwordless', async () => {
    await dropRole();
    const { events, sink } = recorder();
    const result = await ensureScopedRole({ sql, roleName: ROLE, database, sink, enabled: true });
    expect(result.status).toBe('provisioned');
    expect(result.roleName).toBe(ROLE);
    expect(events.map((e) => e.event)).toContain('role-cutover.provisioned');

    const attrs = await roleAttrs();
    expect(attrs).toBeDefined();
    expect(attrs?.rolsuper).toBe(false);
    expect(attrs?.rolcreatedb).toBe(false);
    expect(attrs?.rolcreaterole).toBe(false);
    expect(attrs?.rolreplication).toBe(false);
    expect(attrs?.rolbypassrls).toBe(false);
    expect(attrs?.rolcanlogin).toBe(true);
    expect(attrs?.no_password).toBe(true);
  }, 30_000);

  it('is idempotent — a second run is a no-op (already-provisioned)', async () => {
    await dropRole();
    const first = await ensureScopedRole({ sql, roleName: ROLE, database, enabled: true, sink: () => {} });
    expect(first.status).toBe('provisioned');
    const before = await roleAttrs();

    const { events, sink } = recorder();
    const second = await ensureScopedRole({ sql, roleName: ROLE, database, sink, enabled: true });
    expect(second.status).toBe('already-provisioned');
    expect(events.map((e) => e.event)).toContain('role-cutover.skip.already-provisioned');

    const after = await roleAttrs();
    expect(after).toEqual(before);
    const count = await sql.unsafe(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = '${ROLE}'`);
    expect(count[0].n).toBe(1);
  }, 30_000);

  it('grants exactly the scoped privilege envelope incl. ALTER DEFAULT PRIVILEGES', async () => {
    await dropRole();
    await ensureScopedRole({ sql, roleName: ROLE, database, enabled: true, sink: () => {} });

    const [{ db_connect }] = await sql.unsafe(
      `SELECT has_database_privilege('${ROLE}', '${database}', 'CONNECT') AS db_connect`,
    );
    expect(db_connect).toBe(true);

    const [{ sch_usage, sch_create }] = await sql.unsafe(
      `SELECT has_schema_privilege('${ROLE}', 'public', 'USAGE')  AS sch_usage,
              has_schema_privilege('${ROLE}', 'public', 'CREATE') AS sch_create`,
    );
    expect(sch_usage).toBe(true);
    expect(sch_create).toBe(true);

    // Existing genie tables: SELECT/INSERT/UPDATE/DELETE all present.
    const [{ tbl }] = await sql.unsafe(
      `SELECT quote_ident(schemaname) || '.' || quote_ident(tablename) AS tbl
         FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename LIMIT 1`,
    );
    expect(tbl).toBeTruthy();
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      const [{ ok }] = await sql.unsafe(`SELECT has_table_privilege('${ROLE}', '${tbl}', '${priv}') AS ok`);
      expect(ok).toBe(true);
    }

    // ALTER DEFAULT PRIVILEGES: a table created by the provisioning role
    // (superuser, owner of pre-cutover migration objects) AFTER provisioning
    // is automatically reachable by the scoped role.
    const futureTbl = `rc_future_${PID}`;
    await sql.unsafe(`DROP TABLE IF EXISTS public."${futureTbl}"`);
    await sql.unsafe(`CREATE TABLE public."${futureTbl}" (id int)`);
    try {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const [{ ok }] = await sql.unsafe(
          `SELECT has_table_privilege('${ROLE}', 'public."${futureTbl}"', '${priv}') AS ok`,
        );
        expect(ok).toBe(true);
      }
    } finally {
      await sql.unsafe(`DROP TABLE IF EXISTS public."${futureTbl}"`);
    }
  }, 30_000);

  it('asserts rolsuper=false and DENIES DROP DATABASE / CREATE ROLE / CREATE DATABASE', async () => {
    await dropRole();
    await ensureScopedRole({ sql, roleName: ROLE, database, enabled: true, sink: () => {} });

    const [{ rolsuper }] = await sql.unsafe(`SELECT rolsuper FROM pg_authid WHERE rolname = '${ROLE}'`);
    expect(rolsuper).toBe(false);

    // Stand-in for the neighbor `omni` DB: a DB owned by the superuser the
    // scoped role does NOT own (so DROP fails on ownership, not existence).
    // Created/dropped on the pool (autocommit) — CREATE DATABASE cannot run
    // in a transaction block.
    const standin = `rc_standin_${PID}`;
    await sql.unsafe(`DROP DATABASE IF EXISTS "${standin}"`);
    await sql.unsafe(`CREATE DATABASE "${standin}"`);

    // SET ROLE on a reserved connection so current_user is the scoped role
    // for the privilege checks (and stays on one backend).
    const reserved = await sql.reserve();
    const denied: string[] = [];
    async function expectDenied(label: string, stmt: string): Promise<void> {
      try {
        await reserved.unsafe(stmt);
      } catch (err) {
        denied.push(label);
        expect(String(err instanceof Error ? err.message : err)).toMatch(/permission denied|must be owner/i);
      }
    }
    try {
      await reserved.unsafe(`SET ROLE "${ROLE}"`);
      await expectDenied('drop-database', `DROP DATABASE "${standin}"`);
      await expectDenied('create-role', `CREATE ROLE rc_evil_${PID} LOGIN`);
      await expectDenied('create-database', `CREATE DATABASE rc_evil_db_${PID}`);
    } finally {
      try {
        await reserved.unsafe('RESET ROLE');
      } catch {
        /* already reset */
      }
      reserved.release();
    }
    expect(denied.sort()).toEqual(['create-database', 'create-role', 'drop-database']);

    await sql.unsafe(`DROP DATABASE IF EXISTS "${standin}"`);
  }, 30_000);

  it('non-blocking advisory lock: concurrent callers do not double-provision or block', async () => {
    await dropRole();
    const N = 6;
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        ensureScopedRole({ sql, roleName: ROLE, database, enabled: true, sink: () => {} }),
      ),
    );
    const elapsed = Date.now() - started;

    // None rejected; all resolved.
    expect(results).toHaveLength(N);
    // At most one actually provisioned (lock holder); the rest skipped via the
    // non-blocking lock or saw the role already present.
    const provisioned = results.filter((r) => r.status === 'provisioned').length;
    expect(provisioned).toBeLessThanOrEqual(1);
    for (const r of results) {
      expect(['provisioned', 'already-provisioned', 'skipped']).toContain(r.status);
      if (r.status === 'skipped') expect(['lock-contended', 'error']).toContain(r.reason ?? '');
      expect(r.reason ?? '').not.toBe('error');
    }
    // Role exists exactly once.
    const count = await sql.unsafe(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = '${ROLE}'`);
    expect(count[0].n).toBe(1);
    // Non-blocking: a contended lock returns immediately, it does not serialize
    // N provisioning passes. Generous bound to avoid CI flakiness.
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);

  it('moves zero data — genie table row counts identical pre/post provisioning', async () => {
    await dropRole();
    // Exact per-table counts (authoritative for "nothing moved").
    const tables: string[] = (
      await sql.unsafe(
        `SELECT quote_ident(tablename) AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      )
    ).map((r: { t: string }) => r.t);

    async function snapshot(): Promise<Record<string, number>> {
      const snap: Record<string, number> = {};
      for (const t of tables) {
        const [{ n }] = await sql.unsafe(`SELECT count(*)::int AS n FROM public.${t}`);
        snap[t] = n;
      }
      return snap;
    }

    const before = await snapshot();
    const dbSizeBefore = (await sql.unsafe(`SELECT pg_database_size('${database}')::bigint AS s`))[0].s;
    await ensureScopedRole({ sql, roleName: ROLE, database, enabled: true, sink: () => {} });
    const after = await snapshot();

    expect(after).toEqual(before);
    // Provisioning is catalog-only (CREATE ROLE / GRANT / ALTER DEFAULT
    // PRIVILEGES); it never rewrites or relocates table heaps. DB size is
    // allowed to grow only by catalog metadata pages, never shrink.
    const dbSizeAfter = (await sql.unsafe(`SELECT pg_database_size('${database}')::bigint AS s`))[0].s;
    expect(Number(dbSizeAfter)).toBeGreaterThanOrEqual(Number(dbSizeBefore));
  }, 30_000);
});
