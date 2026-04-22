/**
 * Durability tests for the session-sync backfill marker.
 *
 * Locks in three properties that together prevent a repeat of the
 * 2026-04-22 incident where session_sync held a 'complete' row with
 * started_at=NULL, blocking Claude-session ingestion indefinitely:
 *
 *   1. First INSERT populates started_at.
 *   2. Subsequent UPDATEs never overwrite started_at.
 *   3. The schema CHECK constraint rejects a terminal-status row whose
 *      updated_at precedes started_at (the zero-time "complete" pathology).
 *
 * A fourth test verifies shouldSkipBackfill() still returns true for a
 * legitimate 'complete' row so we don't accidentally regress the skip path
 * while hardening the write path.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getConnection } from '../db.js';
import { shouldSkipBackfill, updateSyncState } from '../session-backfill.js';
import { DB_AVAILABLE, setupTestSchema } from '../test-db.js';

describe.skipIf(!DB_AVAILABLE)('session_sync durability', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestSchema();
  });

  afterAll(async () => {
    await cleanup();
  });

  async function resetRow(): Promise<void> {
    const sql = await getConnection();
    await sql`DELETE FROM session_sync WHERE id = 'backfill'`;
  }

  test('first INSERT populates started_at when status=running', async () => {
    await resetRow();
    const sql = await getConnection();

    await updateSyncState(sql, {
      totalFiles: 10,
      processedFiles: 0,
      totalBytes: 1024,
      processedBytes: 0,
      errors: 0,
      status: 'running',
    });

    const [row] = await sql<
      {
        status: string;
        started_at: Date | null;
        updated_at: Date;
      }[]
    >`SELECT status, started_at, updated_at FROM session_sync WHERE id = 'backfill'`;

    expect(row).toBeDefined();
    expect(row.status).toBe('running');
    expect(row.started_at).toBeInstanceOf(Date);
    expect(row.started_at).not.toBeNull();
  });

  test('subsequent UPDATEs preserve started_at', async () => {
    await resetRow();
    const sql = await getConnection();

    await updateSyncState(sql, {
      totalFiles: 10,
      processedFiles: 0,
      totalBytes: 1024,
      processedBytes: 0,
      errors: 0,
      status: 'running',
    });

    const [first] = await sql<{ started_at: Date }[]>`SELECT started_at FROM session_sync WHERE id = 'backfill'`;

    // Sleep enough that now() advances measurably between writes.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await updateSyncState(sql, {
      totalFiles: 10,
      processedFiles: 5,
      totalBytes: 1024,
      processedBytes: 512,
      errors: 0,
      status: 'running',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    await updateSyncState(sql, {
      totalFiles: 10,
      processedFiles: 10,
      totalBytes: 1024,
      processedBytes: 1024,
      errors: 0,
      status: 'complete',
    });

    const [final] = await sql<
      {
        status: string;
        started_at: Date;
        updated_at: Date;
      }[]
    >`SELECT status, started_at, updated_at FROM session_sync WHERE id = 'backfill'`;

    expect(final.status).toBe('complete');
    // started_at is identical across the three writes.
    expect(final.started_at.getTime()).toBe(first.started_at.getTime());
    // updated_at has advanced past started_at — real runtime, not zero-time.
    expect(final.updated_at.getTime()).toBeGreaterThan(final.started_at.getTime());
  });

  test('CHECK rejects a terminal row whose updated_at precedes started_at', async () => {
    await resetRow();
    const sql = await getConnection();

    // Insert a running row with started_at well in the future, then try to
    // flip it to 'complete' with a now() updated_at. That would mean
    // updated_at < started_at — the exact zero-time pathology the CHECK
    // is designed to block.
    await sql`
      INSERT INTO session_sync (id, status, total_files, processed_files, total_bytes, processed_bytes, errors, started_at, updated_at)
      VALUES ('backfill', 'running', 0, 0, 0, 0, 0, now() + interval '1 hour', now() + interval '1 hour')
    `;

    let err: Error | null = null;
    try {
      await sql`
        UPDATE session_sync
           SET status = 'complete',
               updated_at = now()
         WHERE id = 'backfill'
      `;
    } catch (e) {
      err = e as Error;
    }

    expect(err).toBeTruthy();
    expect(err?.message).toMatch(/session_sync_terminal_has_runtime|check constraint/i);
  });

  test('shouldSkipBackfill returns true for a legitimate complete row', async () => {
    await resetRow();
    const sql = await getConnection();

    await updateSyncState(sql, {
      totalFiles: 1,
      processedFiles: 0,
      totalBytes: 0,
      processedBytes: 0,
      errors: 0,
      status: 'running',
    });
    // Small gap so updated_at strictly exceeds started_at, just like a real run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await updateSyncState(sql, {
      totalFiles: 1,
      processedFiles: 1,
      totalBytes: 0,
      processedBytes: 0,
      errors: 0,
      status: 'complete',
    });

    expect(await shouldSkipBackfill(sql)).toBe(true);
  });
});
