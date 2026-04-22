/**
 * Test Database Helpers — per-test PG database isolation.
 *
 * Each test file gets its own PG database, cloned from the `genie_template`
 * DB that the preload (`test-setup.ts`) built once per `bun test` run. The
 * template carries all migrations already applied, so per-test setup is
 * effectively just `CREATE DATABASE ... TEMPLATE genie_template` — milliseconds
 * rather than the multi-second 48-migration replay this file used to do per
 * test file.
 *
 * Usage:
 *   import { setupTestDatabase } from './test-db.js';
 *
 *   let cleanup: () => Promise<void>;
 *   beforeAll(async () => { cleanup = await setupTestDatabase(); });
 *   afterAll(async () => { await cleanup(); });
 */

import { ensurePgserve, resetConnection } from './db.js';
import { createTestDatabase, dropTestDatabase } from './test-setup.js';

/**
 * Whether a PG database is expected to be reachable for tests.
 * True when GENIE_PG_AVAILABLE has been set by ensurePgserve, or when
 * we are NOT running in CI (local dev boxes auto-start pgserve).
 *
 * Test files that call setupTestDatabase() should guard their describe blocks:
 *   import { DB_AVAILABLE } from './test-db.js';
 *   describe.skipIf(!DB_AVAILABLE)('my suite', () => { ... });
 */
export const DB_AVAILABLE = process.env.GENIE_PG_AVAILABLE === 'true' || !process.env.CI;

// Monotonic counter so multiple setup calls from the same process get unique names.
let dbCounter = 0;

/**
 * When running under the parallel shard runner (scripts/test-parallel.ts),
 * each worker exports `GENIE_TEST_SHARD_INDEX=<1-based>`. We fold that index
 * into the generated DB name so two shards racing to create clones of
 * `genie_template` can't ever collide on an identifier — even on systems where
 * process.pid recycles fast. Falsy / non-numeric values fall back to the plain
 * `test_<pid>_…` layout used by a lone `bun test`.
 */
function shardPrefix(): string {
  const raw = process.env.GENIE_TEST_SHARD_INDEX;
  if (!raw) return 'test';
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 'test';
  return `test_shard${n}`;
}

/**
 * Create an isolated PG database for this test file.
 * Returns a cleanup function that drops the database and resets the connection.
 *
 * How it works:
 * 1. Ensures pgserve is running (preload usually already did this).
 * 2. Picks a unique database name `test_<pid>_<counter>`.
 * 3. Calls `createTestDatabase(name)` which issues
 *    `CREATE DATABASE <name> TEMPLATE genie_template` — fast, atomic clone.
 * 4. Sets `GENIE_TEST_DB_NAME` so `db.ts` connects to the new database.
 * 5. Resets the connection singleton so the next `getConnection()` rebuilds.
 *
 * No migration replay, no search_path gymnastics, no NOTIFY-trigger surgery:
 * DB-level isolation means each test gets a clean universe.
 */
export async function setupTestDatabase(): Promise<() => Promise<void>> {
  // Under concurrent test load, pgserve may have died unexpectedly. If that
  // happens, fall back to a no-op cleanup so describe.skipIf(!DB_AVAILABLE)
  // can still make progress.
  try {
    await ensurePgserve();
  } catch {
    return async () => {};
  }

  const dbName = `${shardPrefix()}_${process.pid}_${Date.now()}_${++dbCounter}`;

  try {
    await createTestDatabase(dbName);
  } catch {
    return async () => {};
  }

  // Point db.ts at the new database and force a rebuild.
  process.env.GENIE_TEST_DB_NAME = dbName;
  await resetConnection();

  return async () => {
    // Close the singleton BEFORE dropping the DB so DROP doesn't fail on
    // "database is being accessed by other users" (defensive — dropTestDatabase
    // also force-terminates backends).
    await resetConnection();
    await dropTestDatabase(dbName);
    if (process.env.GENIE_TEST_DB_NAME === dbName) {
      process.env.GENIE_TEST_DB_NAME = undefined;
    }
  };
}
