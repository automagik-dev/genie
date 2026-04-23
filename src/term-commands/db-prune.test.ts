/**
 * Tests for `genie db prune-events` command.
 *
 * Run with: bun test src/term-commands/db-prune.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parseDuration } from '../lib/cron.js';
import { getConnection } from '../lib/db.js';
import { publishRuntimeEvent } from '../lib/runtime-events.js';
import { DB_AVAILABLE, setupTestDatabase } from '../lib/test-db.js';

// ============================================================================
// Duration parsing for prune-events
// ============================================================================

describe('prune-events duration parsing', () => {
  test('parses days correctly', () => {
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(parseDuration('14d')).toBe(1_209_600_000);
    expect(parseDuration('30d')).toBe(2_592_000_000);
  });

  test('parses hours correctly', () => {
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(parseDuration('48h')).toBe(172_800_000);
  });

  test('rejects invalid durations', () => {
    expect(() => parseDuration('abc')).toThrow('Invalid duration');
    expect(() => parseDuration('')).toThrow('Invalid duration');
  });
});

// ============================================================================
// DB prune integration tests
// ============================================================================

describe.skipIf(!DB_AVAILABLE)('prune-events DB operations', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  test('dry-run counts old events without deleting', async () => {
    const sql = await getConnection();

    // Insert an old event (created_at 30 days ago)
    await sql`
      INSERT INTO genie_runtime_events (repo_path, kind, source, agent, text, created_at)
      VALUES ('/tmp/test', 'system', 'hook', 'test-agent', 'old event', now() - interval '30 days')
    `;

    // Insert a recent event
    await publishRuntimeEvent({
      repoPath: '/tmp/test',
      kind: 'system',
      source: 'hook',
      agent: 'test-agent',
      text: 'recent event',
    });

    // Count events older than 7 days
    const rows = await sql`
      SELECT count(*) AS cnt
      FROM genie_runtime_events
      WHERE created_at < now() - make_interval(secs => ${7 * 86400})
    `;
    expect(Number(rows[0].cnt)).toBeGreaterThanOrEqual(1);

    // Verify recent event is NOT counted
    const recentRows = await sql`
      SELECT count(*) AS cnt
      FROM genie_runtime_events
      WHERE created_at >= now() - make_interval(secs => ${7 * 86400})
    `;
    expect(Number(recentRows[0].cnt)).toBeGreaterThanOrEqual(1);
  });

  test('delete removes old events and keeps recent ones', async () => {
    const sql = await getConnection();

    // Insert an old event
    await sql`
      INSERT INTO genie_runtime_events (repo_path, kind, source, agent, text, created_at)
      VALUES ('/tmp/test', 'system', 'hook', 'test-agent', 'very old', now() - interval '60 days')
    `;

    // Count before
    const beforeRows = await sql`
      SELECT count(*) AS cnt FROM genie_runtime_events
      WHERE created_at < now() - make_interval(secs => ${7 * 86400})
    `;
    const beforeCount = Number(beforeRows[0].cnt);

    // Delete
    const result = await sql`
      DELETE FROM genie_runtime_events
      WHERE created_at < now() - make_interval(secs => ${7 * 86400})
    `;
    expect(Number(result.count)).toBe(beforeCount);

    // Verify old events are gone
    const afterRows = await sql`
      SELECT count(*) AS cnt FROM genie_runtime_events
      WHERE created_at < now() - make_interval(secs => ${7 * 86400})
    `;
    expect(Number(afterRows[0].cnt)).toBe(0);

    // Recent events still exist
    const recentRows = await sql`
      SELECT count(*) AS cnt FROM genie_runtime_events
      WHERE created_at >= now() - make_interval(secs => ${7 * 86400})
    `;
    expect(Number(recentRows[0].cnt)).toBeGreaterThanOrEqual(1);
  });
});
