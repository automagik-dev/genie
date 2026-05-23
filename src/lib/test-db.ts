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

import { ensurePgserve, getConnection, resetConnection } from './db.js';
import { resumeEmitter, shutdownEmitter } from './emit.js';
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

function isConnectionEnded(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'CONNECTION_ENDED';
}

async function warmTestConnection(): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const sql = await getConnection();
      await sql`SELECT 1`;
      return;
    } catch (err) {
      if (attempt === 0 && isConnectionEnded(err)) {
        await resetConnection();
        continue;
      }
      throw err;
    }
  }
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
  // happens, fail closed instead of returning a no-op cleanup: many tests run
  // destructive setup such as `DELETE FROM agents` immediately after this
  // helper returns. Continuing without a guaranteed isolated database can wipe
  // the operator's live Genie registry.
  try {
    await ensurePgserve();
  } catch (error) {
    throw new Error(
      `Unable to prepare isolated Genie test database: pgserve unavailable (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  // Quiesce the emit.ts background flusher BEFORE we swap databases.
  // The flusher holds a reference to the current sqlClient's pool; if we
  // swap the test DB out from under it, the next flush throws
  // `database "test_shardN_..." does not exist` (requeuing the batch on
  // every tick) or `null is not an object (evaluating 'dying.end')` when
  // the pool's reaper races a concurrent getConnection() teardown.
  // Awaiting here guarantees any in-flight writeBatch drains before we
  // invalidate its pool, and the queue resets so no stale rows carry over.
  await shutdownEmitter();

  const dbName = `${shardPrefix()}_${process.pid}_${Date.now()}_${++dbCounter}`;

  try {
    await createTestDatabase(dbName);
  } catch (error) {
    // createTestDatabase failed (e.g. pgserve died, template DB missing).
    // Fail closed: returning a no-op cleanup here leaves GENIE_TEST_DB_NAME
    // unset, so destructive test setup can run against the operator's live DB.
    resumeEmitter();
    throw new Error(
      `Unable to create isolated Genie test database ${dbName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Point db.ts at the new database and force a rebuild.
  process.env.GENIE_TEST_DB_NAME = dbName;
  await resetConnection();
  // Force the first connection while setup still owns the DB swap boundary.
  // postgres.js can otherwise surface a stale socket as CONNECTION_ENDED to
  // the first test body query after the singleton was reset.
  await warmTestConnection();
  // Re-open admits now that the new DB is bound. shutdownEmitter() latched
  // `shuttingDown = true` so leaked background pollers from prior test files
  // couldn't re-arm the flusher mid-swap; with the new sqlClient in place,
  // it's safe to accept new events again.
  resumeEmitter();

  return async () => {
    // Quiesce the emit flusher BEFORE closing the pool. Same rationale as
    // setup: the flusher's in-flight batch against the now-doomed DB would
    // otherwise surface as `database "..." does not exist` in stderr and
    // block the test run from exiting cleanly.
    await shutdownEmitter();
    // Close the singleton BEFORE dropping the DB so DROP doesn't fail on
    // "database is being accessed by other users" (defensive — dropTestDatabase
    // also force-terminates backends).
    await resetConnection();
    await dropTestDatabase(dbName);
    if (process.env.GENIE_TEST_DB_NAME === dbName) {
      process.env.GENIE_TEST_DB_NAME = undefined;
    }
    // Re-open admits so subsequent test files (or the next setupTestDatabase
    // cycle in this process) aren't locked out. Without this, admits stay
    // latched-off indefinitely after the last cleanup runs.
    resumeEmitter();
  };
}

/**
 * Backwards-compat alias. `setupTestSchema` was the prior API name (schema-
 * isolation era). Group 3 replaced it with `setupTestDatabase` (database-
 * clone isolation). Dev still has callsites using the old name that land
 * via merge-preview into this branch — keep the alias so `tsc --noEmit`
 * passes under the merge topology. Safe to delete once dev is rebased.
 *
 * Implemented as a thin wrapper (not `export const setupTestSchema =
 * setupTestDatabase`) so knip does not flag a duplicate export.
 */
export async function setupTestSchema(): Promise<() => Promise<void>> {
  return setupTestDatabase();
}
