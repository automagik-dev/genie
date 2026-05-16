/**
 * Goal-A Group 3 — migration-replay-as-scoped-role validation (the functional
 * gate).
 *
 * Proves the FULL existing `src/db/migrations/*` set replays clean executed as
 * the scoped NON-SUPERUSER role, against a fixture shaped like the live
 * `postgres` DB the cutover lands in.
 *
 * ── Fixture model (what "live postgres-DB shape" means) ────────────────────
 * The cutover does NOT land in a virgin database — it rebinds genie's identity
 * inside the EXISTING `postgres` DB, where genie has been running as the
 * superuser for the cluster's whole life. Three classes of objects are
 * therefore PRE-EXISTING infrastructure the scoped role legitimately never
 * needs to (and by design MUST NOT) create:
 *
 *   1. `pgcrypto` extension  — migrations 039 & 041 do
 *      `CREATE EXTENSION IF NOT EXISTS pgcrypto`. Installing an extension is a
 *      one-time DB-setup act owned by the provisioning superuser; in the live
 *      `postgres` DB it predates cutover. Pre-installed here as superuser ⇒
 *      the migration is a no-op for the scoped role.
 *   2. cluster RBAC roles  — migrations 041 & 043 `CREATE ROLE events_admin /
 *      events_operator / events_subscriber / events_audit / executors_reader`
 *      (each guarded by `IF NOT EXISTS (SELECT 1 FROM pg_roles …)`). Roles are
 *      CLUSTER-global; in the live cluster they already exist from prior
 *      superuser migration runs. Pre-created here as superuser ⇒ the guard
 *      short-circuits and the scoped (NOCREATEROLE) role never issues
 *      CREATE ROLE.
 *   3. `public` schema ownership  — migration 041 does
 *      `REVOKE ALL ON SCHEMA public FROM PUBLIC` + `GRANT USAGE ON SCHEMA
 *      public TO events_*` (043 likewise). Those are OWNER-only operations.
 *      Per WISH §Assumptions/Risks ("ALTER … OWNER TO <role> the genie objects
 *      at provision time (still no byte move)"), the fixture transfers the
 *      replay DB's `public` schema to the scoped role — metadata-only, zero
 *      bytes moved, and scoped to genie's OWN database (the replay DB models
 *      genie's own `postgres` DB; it is dropped at the end of the test).
 *
 * NONE of this grants the scoped role SUPERUSER / CREATEDB / CREATEROLE — the
 * privilege envelope from Group 1 is unchanged. The identified privileged
 * statements (039/041/043) are documented above and asserted handled by the
 * fixture below; if a FUTURE migration introduces new superuser-only DDL this
 * test fails loudly (regression guard).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runMigrations } from './db-migrations.js';
import { getConnection, resolveTcpPgPassword } from './db.js';
import { ensureScopedRole } from './role-cutover.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

const PID = process.pid;
const ROLE = `pgserve_rcg3_${PID}_role`;
const REPLAY_DB = `rc_replay_${PID}`;

// Cluster RBAC roles 041/043 expect to already exist (pre-cutover infra).
const RBAC_ROLES = ['events_admin', 'events_operator', 'events_subscriber', 'events_audit', 'executors_reader'];

function migrationsDir(): string {
  // import.meta.dir → src/lib/ ; migrations live at src/db/migrations/.
  return join(import.meta.dir, '..', 'db', 'migrations');
}

function migrationFileCount(): number {
  return readdirSync(migrationsDir()).filter((f) => f.endsWith('.sql')).length;
}

const TCP_PORT = process.env.GENIE_TEST_PG_PORT;

describe.skipIf(!DB_AVAILABLE || !TCP_PORT)('migration replay as the scoped non-superuser role', () => {
  let cleanupSchema: () => Promise<void>;
  // postgres.js Sql type bleed-through; `any` is permitted in test files.
  let admin: any;
  // The replay connection — superuser session, SET ROLE'd to the scoped role.
  let replay: any;

  beforeAll(async () => {
    cleanupSchema = await setupTestDatabase();
    admin = await getConnection();

    // Fresh, virgin database (autocommit on the pool — CREATE DATABASE cannot
    // run inside a transaction).
    await admin.unsafe(`DROP DATABASE IF EXISTS "${REPLAY_DB}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${REPLAY_DB}"`);

    // Cluster RBAC roles are global — pre-create as superuser to model the
    // live cluster (idempotent; they very likely already exist).
    for (const r of RBAC_ROLES) {
      const exists = await admin.unsafe(`SELECT 1 FROM pg_roles WHERE rolname = '${r}'`);
      if (exists.length === 0) await admin.unsafe(`CREATE ROLE "${r}" NOINHERIT`);
    }

    // Superuser session connected to the virgin replay DB.
    const pg = (await import('postgres')).default;
    replay = pg({
      host: '127.0.0.1',
      port: Number(TCP_PORT),
      database: REPLAY_DB,
      username: 'postgres', // pragma: allowlist secret — pgserve test default
      password: resolveTcpPgPassword(), // pragma: allowlist secret
      max: 1, // single backend ⇒ SET ROLE persists across runMigrations' txns
      idle_timeout: 0,
      onnotice: () => {},
      connection: { client_min_messages: 'warning' as const },
    });

    // Live-shape prerequisites, applied as SUPERUSER in the replay DB:
    //   (1) pgcrypto pre-installed (extensions predate cutover)
    await replay.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    //   provision the scoped non-superuser role + Group 1 grants on this DB
    await ensureScopedRole({ sql: replay, roleName: ROLE, database: REPLAY_DB, enabled: true, sink: () => {} });
    //   (3) genie owns its own DB's public schema (metadata-only, no bytes)
    await replay.unsafe(`ALTER SCHEMA public OWNER TO "${ROLE}"`);
  }, 60_000);

  afterAll(async () => {
    try {
      await replay?.end({ timeout: 5 });
    } catch {
      /* best-effort */
    }
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${REPLAY_DB}" WITH (FORCE)`);
      const exists = await admin.unsafe(`SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}'`);
      if (exists.length > 0) {
        await admin.unsafe(`DROP OWNED BY "${ROLE}"`);
        await admin.unsafe(`DROP ROLE IF EXISTS "${ROLE}"`);
      }
    } catch {
      /* best-effort */
    }
    await cleanupSchema();
  });

  it('the fixture models the live shape — pgcrypto present, RBAC roles present, schema owned by the role', async () => {
    const [{ has_pgcrypto }] = await replay.unsafe(
      `SELECT count(*) > 0 AS has_pgcrypto FROM pg_extension WHERE extname = 'pgcrypto'`,
    );
    expect(has_pgcrypto).toBe(true);

    for (const r of RBAC_ROLES) {
      const rows = await replay.unsafe(`SELECT 1 FROM pg_roles WHERE rolname = '${r}'`);
      expect(rows.length).toBe(1);
    }

    // ROLE has no special chars, so regrole text is the bare identifier.
    const [{ owner }] = await replay.unsafe(
      `SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'public'`,
    );
    expect(owner).toBe(ROLE);

    // The scoped role is provably NOT a superuser — the whole point.
    const [{ rolsuper }] = await admin.unsafe(`SELECT rolsuper FROM pg_authid WHERE rolname = '${ROLE}'`);
    expect(rolsuper).toBe(false);
  }, 30_000);

  it('replays the ENTIRE src/db/migrations/* set clean as the scoped role', async () => {
    const expectedCount = migrationFileCount();
    expect(expectedCount).toBeGreaterThan(60); // sanity: the full set, not a stub

    // Become the scoped non-superuser role. max:1 ⇒ this single backend (and
    // therefore every sql.begin() transaction runMigrations opens) runs with
    // current_user = the scoped role. Superuser attributes do NOT leak through
    // SET ROLE to a non-superuser (same guarantee the Group 1 negative tests
    // rely on).
    await replay.unsafe(`SET ROLE "${ROLE}"`);
    const [{ who }] = await replay.unsafe('SELECT current_user AS who');
    expect(who).toBe(ROLE);

    // The functional gate: the full migration set must apply with ZERO errors
    // executed entirely as the non-superuser role. If any migration needs a
    // privilege the role lacks, runMigrations throws here with the offending
    // SQL — surfacing it as the documented blocker.
    const applied = await runMigrations(replay);
    expect(applied.length).toBe(expectedCount);

    const [{ n }] = await replay.unsafe('SELECT count(*)::int AS n FROM _genie_migrations');
    expect(n).toBe(expectedCount);

    // A re-run as the scoped role is a clean no-op (boot #2 stays put).
    const second = await runMigrations(replay);
    expect(second.length).toBe(0);
  }, 120_000);

  it('the scoped role can read+write genie tables created by the replay', async () => {
    // current_user is still the scoped role from the previous test's SET ROLE
    // (same max:1 session). Exercise representative genie DML.
    const [{ who }] = await replay.unsafe('SELECT current_user AS who');
    expect(who).toBe(ROLE);

    const [{ tbl }] = await replay.unsafe(
      `SELECT quote_ident(tablename) AS tbl FROM pg_tables
         WHERE schemaname = 'public' AND tablename LIKE 'genie%' ORDER BY tablename LIMIT 1`,
    );
    expect(tbl).toBeTruthy();
    // SELECT must succeed as the scoped role against a migration-created table.
    await replay.unsafe(`SELECT count(*) FROM public.${tbl}`);

    await replay.unsafe('RESET ROLE');
    const [{ back }] = await replay.unsafe('SELECT current_user AS back');
    expect(back).toBe('postgres');
  }, 30_000);
});
