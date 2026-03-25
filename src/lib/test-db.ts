/**
 * Test Database Helpers — PG schema isolation for tests.
 *
 * Each test file gets its own PG schema so test data never touches
 * the production `public` schema. Schemas are created in beforeAll
 * and dropped in afterAll — zero artifacts after `bun test`.
 *
 * Usage:
 *   import { setupTestSchema, teardownTestSchema } from './test-db.js';
 *
 *   let cleanup: () => Promise<void>;
 *   beforeAll(async () => { cleanup = await setupTestSchema(); });
 *   afterAll(async () => { await cleanup(); });
 */

import { runMigrations } from './db-migrations.js';
import { ensurePgserve, resetConnection } from './db.js';

/**
 * Create an isolated PG schema for this test file.
 * Returns a cleanup function that drops the schema and resets the connection.
 *
 * How it works:
 * 1. Gets a default connection (no schema override)
 * 2. Creates a unique schema named `test_<pid>_<timestamp>`
 * 3. Runs all migrations inside that schema
 * 4. Resets the connection singleton
 * 5. Sets GENIE_TEST_SCHEMA env var so getConnection() uses the test schema
 *
 * All subsequent getConnection() calls in this process will use the test schema.
 */
export async function setupTestSchema(): Promise<() => Promise<void>> {
  const schemaName = `test_${process.pid}_${Date.now()}`;

  // Get a raw connection to create the schema
  const port = await ensurePgserve();
  const postgres = (await import('postgres')).default;
  const adminSql = postgres({
    host: '127.0.0.1',
    port,
    database: 'genie',
    username: 'postgres',
    password: 'postgres',
    max: 2,
    idle_timeout: 1,
    connect_timeout: 5,
  });

  // Create test schema and run migrations inside it
  await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  await adminSql.unsafe(`SET search_path TO "${schemaName}", public`);
  await runMigrations(adminSql);
  await adminSql.end({ timeout: 5 });

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
