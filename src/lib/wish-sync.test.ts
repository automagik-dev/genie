/**
 * Tests for Wish Sync — filesystem to PG wish indexing.
 * Run with: bun test src/lib/wish-sync.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConnection } from './db.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';
import { getWish, listWishes, parseWishStatus, syncWishes } from './wish-sync.js';

// ============================================================================
// parseWishStatus (pure parsing — no DB)
// ============================================================================

describe('parseWishStatus', () => {
  test('parses status from markdown table', () => {
    const content = '| **Status** | APPROVED |\n| **Slug** | test |';
    expect(parseWishStatus(content)).toBe('APPROVED');
  });

  test('parses status with extra whitespace', () => {
    const content = '|  **Status**  |  IN_PROGRESS  |';
    expect(parseWishStatus(content)).toBe('IN_PROGRESS');
  });

  test('returns DRAFT when no status found', () => {
    const content = '# Some wish\n\nNo table here.';
    expect(parseWishStatus(content)).toBe('DRAFT');
  });

  test('handles DRAFT status', () => {
    const content = '| **Status** | DRAFT |';
    expect(parseWishStatus(content)).toBe('DRAFT');
  });
});

// ============================================================================
// syncWishes + queries (DB-dependent)
// ============================================================================

describe.skipIf(!DB_AVAILABLE)('pg', () => {
  let cleanupSchema: () => Promise<void>;
  const TEST_DIR = '/tmp/wish-sync-test';
  const TEST_REPO = join(TEST_DIR, 'test-repo');

  async function setupTestRepo(): Promise<void> {
    await rm(TEST_DIR, { recursive: true, force: true });

    // Create a repo with two wishes
    const wish1Dir = join(TEST_REPO, '.genie', 'wishes', 'fix-auth');
    const wish2Dir = join(TEST_REPO, '.genie', 'wishes', 'add-search');
    await mkdir(wish1Dir, { recursive: true });
    await mkdir(wish2Dir, { recursive: true });

    await writeFile(
      join(wish1Dir, 'WISH.md'),
      '# Fix Auth\n\n| Field | Value |\n|-------|-------|\n| **Status** | APPROVED |\n| **Slug** | fix-auth |\n',
    );
    await writeFile(
      join(wish2Dir, 'WISH.md'),
      '# Add Search\n\n| Field | Value |\n|-------|-------|\n| **Status** | DRAFT |\n| **Slug** | add-search |\n',
    );
  }

  beforeAll(async () => {
    cleanupSchema = await setupTestDatabase();
    await setupTestRepo();
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await cleanupSchema();
  });

  test('syncWishes upserts wishes from a repo', async () => {
    const count = await syncWishes(TEST_REPO);
    expect(count).toBe(2);

    // Verify they're in PG
    const sql = await getConnection();
    const rows = await sql`SELECT * FROM wishes WHERE repo = ${TEST_REPO} ORDER BY slug`;
    expect(rows.length).toBe(2);
    expect(rows[0].slug).toBe('add-search');
    expect(rows[0].status).toBe('DRAFT');
    expect(rows[1].slug).toBe('fix-auth');
    expect(rows[1].status).toBe('APPROVED');
  });

  test('syncWishes is idempotent — multiple runs do not duplicate', async () => {
    await syncWishes(TEST_REPO);
    await syncWishes(TEST_REPO);

    const sql = await getConnection();
    const rows = await sql`SELECT * FROM wishes WHERE repo = ${TEST_REPO}`;
    expect(rows.length).toBe(2);
  });

  test('syncWishes updates status on re-sync', async () => {
    // Update the WISH.md status
    const wish1Path = join(TEST_REPO, '.genie', 'wishes', 'fix-auth', 'WISH.md');
    await writeFile(
      wish1Path,
      '# Fix Auth\n\n| Field | Value |\n|-------|-------|\n| **Status** | DONE |\n| **Slug** | fix-auth |\n',
    );

    await syncWishes(TEST_REPO);

    const sql = await getConnection();
    const rows = await sql`SELECT status FROM wishes WHERE slug = ${'fix-auth'} AND repo = ${TEST_REPO}`;
    expect(rows[0].status).toBe('DONE');
  });

  test('listWishes returns all wishes', async () => {
    const wishes = await listWishes();
    expect(wishes.length).toBeGreaterThanOrEqual(2);
  });

  test('listWishes filters by repo', async () => {
    const wishes = await listWishes({ repo: TEST_REPO });
    expect(wishes.length).toBe(2);
  });

  test('listWishes filters by status', async () => {
    const wishes = await listWishes({ status: 'DRAFT' });
    expect(wishes.some((w) => w.slug === 'add-search')).toBe(true);
  });

  test('getWish returns a single wish', async () => {
    const wish = await getWish('add-search', TEST_REPO);
    expect(wish).not.toBeNull();
    expect(wish!.slug).toBe('add-search');
    expect(wish!.status).toBe('DRAFT');
  });

  test('getWish returns null for nonexistent wish', async () => {
    const wish = await getWish('nonexistent', TEST_REPO);
    expect(wish).toBeNull();
  });
});
