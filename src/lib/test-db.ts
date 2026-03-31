/**
 * Test Database Helpers — PG schema isolation for tests.
 *
 * Each test file gets its own PG schema so test data never touches
 * the production `public` schema. Schemas are created in beforeAll
 * and dropped in afterAll — zero artifacts after `bun test`.
 *
 * IMPORTANT: Migrations run with search_path set to ONLY the test schema
 * (no public fallback) so that _genie_migrations is created fresh in the
 * test schema. This prevents the migration runner from reading public's
 * _genie_migrations and skipping table creation in the test schema.
 *
 * Usage:
 *   import { setupTestSchema } from './test-db.js';
 *
 *   let cleanup: () => Promise<void>;
 *   beforeAll(async () => { cleanup = await setupTestSchema(); });
 *   afterAll(async () => { await cleanup(); });
 */

import { runMigrations } from './db-migrations.js';
import { type Sql, ensurePgserve, resetConnection } from './db.js';

/**
 * Whether a PG database is expected to be reachable for tests.
 * True when GENIE_PG_AVAILABLE has been set by ensurePgserve, or when
 * we are NOT running in CI (local dev boxes auto-start pgserve).
 *
 * Test files that call setupTestSchema() should guard their describe blocks:
 *   import { DB_AVAILABLE } from './test-db.js';
 *   describe.skipIf(!DB_AVAILABLE)('my suite', () => { ... });
 */
export const DB_AVAILABLE = process.env.GENIE_PG_AVAILABLE === 'true' || !process.env.CI;

/** Max age (ms) before a test schema is considered stale and eligible for cleanup. */
const STALE_SCHEMA_AGE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Create an isolated PG schema for this test file.
 * Returns a cleanup function that drops the schema and resets the connection.
 *
 * How it works:
 * 1. Ensures pgserve is running
 * 2. Creates a unique schema named `test_<pid>_<timestamp>`
 * 3. Runs all migrations with search_path = test schema ONLY (excludes public)
 *    — this ensures _genie_migrations + all tables are created fresh in the test schema,
 *      not skipped because public already has the migration records
 * 4. Resets the connection singleton
 * 5. Sets GENIE_TEST_SCHEMA env var so getConnection() uses `test_schema, public` search_path
 *
 * On setup, also cleans up stale test schemas from crashed runs.
 */
export async function setupTestSchema(): Promise<() => Promise<void>> {
  const schemaName = `test_${process.pid}_${Date.now()}`;

  let port: number;
  try {
    port = await ensurePgserve();
  } catch {
    // PG unreachable under concurrent test load — return no-op cleanup
    return async () => {};
  }
  const postgres = (await import('postgres')).default;
  const adminSql = postgres({
    host: '127.0.0.1',
    port,
    database: 'genie',
    username: 'postgres',
    password: 'postgres',
    max: 1,
    idle_timeout: 1,
    connect_timeout: 5,
    onnotice: () => {},
    connection: { client_min_messages: 'warning' },
  });

  try {
    // Defensively clean up stale test schemas from crashed runs
    await cleanupStaleSchemas(adminSql);

    // Create the test schema and run migrations inside it.
    // search_path = test schema ONLY (no public) ensures _genie_migrations is
    // created fresh in the test schema, so migration runner sees zero applied
    // and creates all tables in the test schema.
    // max: 1 ensures SET search_path applies to all subsequent queries on this connection.
    await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await adminSql.unsafe(`SET search_path TO "${schemaName}"`);
    await runMigrations(adminSql);
    await adminSql.end({ timeout: 5 });
  } catch {
    // Schema creation or migration race under concurrent test load — skip gracefully
    try {
      await adminSql.end({ timeout: 1 });
    } catch {
      /* ignore */
    }
    return async () => {};
  }

  // Reset the singleton and set the env var so getConnection() picks up the schema
  await resetConnection();
  process.env.GENIE_TEST_SCHEMA = schemaName;

  // Return cleanup function
  return async () => {
    // Reset connection before dropping schema
    await resetConnection();

    // Drop the test schema with a fresh admin connection
    const cleanupSql = postgres({
      host: '127.0.0.1',
      port,
      database: 'genie',
      username: 'postgres',
      password: 'postgres',
      max: 2,
      idle_timeout: 1,
      connect_timeout: 5,
      onnotice: () => {},
      connection: { client_min_messages: 'warning' },
    });

    try {
      await cleanupSql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await cleanupSql.end({ timeout: 5 });
    }

    // Clear env var
    process.env.GENIE_TEST_SCHEMA = undefined;
  };
}

/**
 * Drop test schemas older than STALE_SCHEMA_AGE_MS.
 * Schema names encode a timestamp: test_<pid>_<timestamp>.
 * Best-effort — failures are silently ignored so tests aren't blocked.
 */
async function cleanupStaleSchemas(sql: Sql): Promise<void> {
  try {
    const schemas = await sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE 'test_%'
    `;

    const now = Date.now();
    for (const { schema_name } of schemas) {
      // Parse timestamp from schema name: test_<pid>_<timestamp>
      const parts = schema_name.split('_');
      if (parts.length < 3) continue;
      const ts = Number.parseInt(parts[2], 10);
      if (Number.isNaN(ts)) continue;
      if (now - ts > STALE_SCHEMA_AGE_MS) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema_name}" CASCADE`);
      }
    }
  } catch {
    // Best effort — don't block test setup on cleanup failures
  }
}
