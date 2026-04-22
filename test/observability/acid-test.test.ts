/**
 * Acid-test suite (WISH §Group 7 deliverable #3).
 *
 * Proves the observability substrate can retroactively reconstruct each of
 * the six "rot" patterns and five dispatch bugs from raw rows alone.
 *
 * For each pattern:
 *   1. Load the matching SQL query from `docs/observability-acid-tests.sql`
 *      (parsed via the `-- @pattern: <id>` ... `-- @end-pattern` markers).
 *   2. Seed the matching fixture into a per-test isolated PG schema via the
 *      seeder in `replay-dataset/index.ts`.
 *   3. Execute the query (with the `:'since'` psql variable substituted to a
 *      generous '24 hours') and assert the evidence row count matches.
 *
 * Isolation is two-tier: per-file via `setupTestDatabase()`, plus per-test
 * TRUNCATE of all three event tables in `beforeEach`. TRUNCATE bypasses the
 * audit-WORM trigger because that guards only DELETE / UPDATE.
 *
 * The fixtures plant deliberate decoys alongside the evidence to verify each
 * query's negative selectivity — a regression that would silently flag
 * healthy rows as pathological surfaces immediately.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConnection } from '../../src/lib/db.js';
import { DB_AVAILABLE, setupTestDatabase } from '../../src/lib/test-db.js';
import { ALL_SEEDERS, type FixtureResult, type Seeder } from './replay-dataset/index.js';

const SQL_FILE = join(import.meta.dir, '..', '..', 'docs', 'observability-acid-tests.sql');

// ---------------------------------------------------------------------------
// SQL extraction — strip psql-specific syntax so postgres.js accepts the body.
// ---------------------------------------------------------------------------

function extractQueries(): Map<string, string> {
  const text = readFileSync(SQL_FILE, 'utf8');
  const out = new Map<string, string>();
  const re = /^--\s*@pattern:\s*(\S+)\s*$([\s\S]*?)^--\s*@end-pattern\s*$/gm;
  for (const m of text.matchAll(re)) {
    const patternId = m[1];
    const raw = m[2];
    out.set(patternId, sanitize(raw));
  }
  return out;
}

/**
 * Strip psql metacommands and substitute the `:'since'` variable. The bun test
 * always runs against a per-test isolated schema; '24 hours' is a generous
 * window that comfortably covers all fixture rows (which are written within
 * seconds of each other).
 */
function sanitize(body: string): string {
  return body
    .split('\n')
    .filter((l) => !/^\s*\\(echo|set|if|else|endif)/.test(l))
    .join('\n')
    .replace(/\(:\s*'since'\s*\)::interval/g, `INTERVAL '24 hours'`)
    .replace(/:\s*'since'/g, `'24 hours'`)
    .trim()
    .replace(/;?\s*$/, '');
}

// ---------------------------------------------------------------------------
// Pattern → seeder lookup. Order matches docs/observability-acid-tests.sql.
// ---------------------------------------------------------------------------

const PATTERN_TO_SEEDER: ReadonlyArray<{ patternId: string; seeder: Seeder }> = [
  { patternId: 'rot.1.backfilled-teams-without-worktree', seeder: ALL_SEEDERS[0] },
  { patternId: 'rot.2.team-ls-disband-drift', seeder: ALL_SEEDERS[1] },
  { patternId: 'rot.3.ghost-anchors-no-session', seeder: ALL_SEEDERS[2] },
  { patternId: 'rot.4.duplicate-custom-name-anchors', seeder: ALL_SEEDERS[3] },
  { patternId: 'rot.5.zombie-team-lead-polling', seeder: ALL_SEEDERS[4] },
  { patternId: 'rot.6.orphan-subagent-cascade', seeder: ALL_SEEDERS[5] },
  { patternId: 'dispatch.A.parser-review-false-match', seeder: ALL_SEEDERS[6] },
  { patternId: 'dispatch.B.reset-no-clear-wave-state', seeder: ALL_SEEDERS[7] },
  { patternId: 'dispatch.C.pg-vs-cache-status-drift', seeder: ALL_SEEDERS[8] },
  { patternId: 'dispatch.D.spawn-bypass-state-machine', seeder: ALL_SEEDERS[9] },
  { patternId: 'dispatch.E.agent-ready-timer-mismeasure', seeder: ALL_SEEDERS[10] },
];

describe.skipIf(!DB_AVAILABLE)('observability — acid tests (11 patterns)', () => {
  const queries = extractQueries();
  let cleanup: () => Promise<void> = async () => {};

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    const sql = await getConnection();
    await sql.unsafe(`
      TRUNCATE TABLE genie_runtime_events,
                     genie_runtime_events_debug,
                     genie_runtime_events_audit
      RESTART IDENTITY CASCADE
    `);
  });

  test('SQL file declares all 11 patterns', () => {
    expect(queries.size).toBe(11);
    for (const { patternId } of PATTERN_TO_SEEDER) {
      expect(queries.has(patternId)).toBe(true);
    }
  });

  for (const { patternId, seeder } of PATTERN_TO_SEEDER) {
    test(`pattern ${patternId} — query reconstructs evidence`, async () => {
      const sql = await getConnection();
      const fixture: FixtureResult = await seeder(sql);
      expect(fixture.patternId).toBe(patternId);

      const queryBody = queries.get(patternId);
      if (!queryBody) throw new Error(`missing SQL body for ${patternId}`);

      const rows = (await sql.unsafe(queryBody)) as unknown as unknown[];
      expect(rows.length).toBe(fixture.expectedEvidenceCount);
    });
  }
});
