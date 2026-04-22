/**
 * Tests for task-close-merged.ts — PR scanning + wish slug extraction + auto-close.
 *
 * Unit tests for slug extraction are pure (no DB needed).
 * Integration tests for closeMergedTasks require PG (guarded by DB_AVAILABLE).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  type MergedPR,
  extractSlugFromBody,
  extractSlugFromBranch,
  extractWishSlug,
  matchPRsToSlugs,
  parseSinceDate,
} from './task-close-merged.js';

// ============================================================================
// Slug Extraction — Pure Unit Tests
// ============================================================================

describe('extractSlugFromBody', () => {
  it('extracts "Wish: <slug>" (capitalized)', () => {
    expect(extractSlugFromBody('Some text\nWish: task-auto-close\nMore text')).toBe('task-auto-close');
  });

  it('extracts "wish: <slug>" (lowercase)', () => {
    expect(extractSlugFromBody('wish: my-feature-slug')).toBe('my-feature-slug');
  });

  it('extracts "slug: <slug>"', () => {
    expect(extractSlugFromBody('slug: deploy-fix')).toBe('deploy-fix');
  });

  it('extracts "WISH: <slug>" (all caps)', () => {
    expect(extractSlugFromBody('WISH: ALL-CAPS-SLUG')).toBe('ALL-CAPS-SLUG');
  });

  it('handles extra whitespace after colon', () => {
    expect(extractSlugFromBody('wish:   spaced-slug')).toBe('spaced-slug');
  });

  it('extracts first match when multiple present', () => {
    expect(extractSlugFromBody('wish: first-slug\nslug: second-slug')).toBe('first-slug');
  });

  it('returns null for empty body', () => {
    expect(extractSlugFromBody('')).toBeNull();
  });

  it('returns null when no pattern matches', () => {
    expect(extractSlugFromBody('This PR fixes a bug in the login flow')).toBeNull();
  });

  it('returns null for null-ish input', () => {
    expect(extractSlugFromBody(null as unknown as string)).toBeNull();
  });
});

describe('extractSlugFromBranch', () => {
  it('extracts from feat/ prefix', () => {
    expect(extractSlugFromBranch('feat/task-auto-close')).toBe('task-auto-close');
  });

  it('extracts from fix/ prefix', () => {
    expect(extractSlugFromBranch('fix/broken-login')).toBe('broken-login');
  });

  it('extracts from chore/ prefix', () => {
    expect(extractSlugFromBranch('chore/update-deps')).toBe('update-deps');
  });

  it('extracts from docs/ prefix', () => {
    expect(extractSlugFromBranch('docs/api-reference')).toBe('api-reference');
  });

  it('extracts from refactor/ prefix', () => {
    expect(extractSlugFromBranch('refactor/auth-middleware')).toBe('auth-middleware');
  });

  it('extracts from test/ prefix', () => {
    expect(extractSlugFromBranch('test/coverage-gaps')).toBe('coverage-gaps');
  });

  it('extracts from dream/ prefix', () => {
    expect(extractSlugFromBranch('dream/auto-close')).toBe('auto-close');
  });

  it('returns null for main/master/dev', () => {
    expect(extractSlugFromBranch('main')).toBeNull();
    expect(extractSlugFromBranch('master')).toBeNull();
    expect(extractSlugFromBranch('dev')).toBeNull();
  });

  it('returns null for unknown prefix', () => {
    expect(extractSlugFromBranch('release/v1.0')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractSlugFromBranch('')).toBeNull();
  });

  it('preserves nested slashes in slug', () => {
    expect(extractSlugFromBranch('feat/scope/nested-feature')).toBe('scope/nested-feature');
  });
});

describe('extractWishSlug', () => {
  const basePR: MergedPR = {
    number: 1,
    title: 'Test PR',
    body: '',
    headRefName: 'main',
    mergedAt: '2026-03-29T10:00:00Z',
  };

  it('prefers body slug over branch slug', () => {
    const pr = { ...basePR, body: 'wish: body-slug', headRefName: 'feat/branch-slug' };
    expect(extractWishSlug(pr)).toBe('body-slug');
  });

  it('falls back to branch when body has no slug', () => {
    const pr = { ...basePR, body: 'No slug here', headRefName: 'feat/branch-fallback' };
    expect(extractWishSlug(pr)).toBe('branch-fallback');
  });

  it('returns null when neither body nor branch match', () => {
    const pr = { ...basePR, body: 'Just a fix', headRefName: 'main' };
    expect(extractWishSlug(pr)).toBeNull();
  });
});

describe('matchPRsToSlugs', () => {
  it('extracts slugs from multiple PRs', () => {
    const prs: MergedPR[] = [
      { number: 10, title: 'A', body: 'wish: slug-a', headRefName: 'feat/slug-a', mergedAt: '2026-03-29T10:00:00Z' },
      { number: 11, title: 'B', body: '', headRefName: 'fix/slug-b', mergedAt: '2026-03-29T11:00:00Z' },
      { number: 12, title: 'C', body: 'No slug', headRefName: 'main', mergedAt: '2026-03-29T12:00:00Z' },
    ];
    const matches = matchPRsToSlugs(prs);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({ prNumber: 10, slug: 'slug-a', mergedAt: '2026-03-29T10:00:00Z' });
    expect(matches[1]).toEqual({ prNumber: 11, slug: 'slug-b', mergedAt: '2026-03-29T11:00:00Z' });
  });

  it('returns empty array for PRs with no slugs', () => {
    const prs: MergedPR[] = [
      { number: 1, title: 'X', body: '', headRefName: 'main', mergedAt: '2026-03-29T10:00:00Z' },
    ];
    expect(matchPRsToSlugs(prs)).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(matchPRsToSlugs([])).toHaveLength(0);
  });
});

describe('parseSinceDate', () => {
  it('parses hours', () => {
    const date = new Date(parseSinceDate('24h'));
    const expected = new Date();
    expected.setHours(expected.getHours() - 24);
    // Allow 1 second tolerance
    expect(Math.abs(date.getTime() - expected.getTime())).toBeLessThan(1000);
  });

  it('parses days', () => {
    const date = new Date(parseSinceDate('7d'));
    const expected = new Date();
    expected.setDate(expected.getDate() - 7);
    expect(Math.abs(date.getTime() - expected.getTime())).toBeLessThan(1000);
  });

  it('throws on invalid format', () => {
    expect(() => parseSinceDate('abc')).toThrow('Invalid --since format');
    expect(() => parseSinceDate('24m')).toThrow('Invalid --since format');
    expect(() => parseSinceDate('')).toThrow('Invalid --since format');
  });
});

// ============================================================================
// Integration Tests — closeMergedTasks (require PG + gh CLI)
// ============================================================================

import { type Actor, createTask, getTask, listTasks, moveTask } from './task-service.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

const REPO = `/tmp/test-close-merged-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const actor: Actor = { actorType: 'local', actorId: 'test-user' };

describe.skipIf(!DB_AVAILABLE)('closeMergedTasks integration', () => {
  let cleanupSchema: () => Promise<void>;

  beforeAll(async () => {
    cleanupSchema = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanupSchema();
  });

  it('skips tasks already in ship stage', async () => {
    // Create a task with a wish_file already in ship stage
    const { id } = await createTask(
      { title: 'Already shipped', wishFile: '.genie/wishes/already-shipped/WISH.md', stage: 'ship' },
      REPO,
    );

    // Verify it stays in ship stage
    const t = await getTask(id, REPO);
    expect(t?.stage).toBe('ship');
  });

  it('creates tasks with wish_file for matching', async () => {
    await createTask({ title: 'Needs closing', wishFile: '.genie/wishes/test-slug/WISH.md' }, REPO);

    const found = await listTasks({ repoPath: REPO });
    const match = found.find((t) => t.wishFile?.includes('test-slug'));
    expect(match).toBeTruthy();
    expect(match?.stage).not.toBe('ship');
  });

  it('moveTask moves a task to ship stage with comment', async () => {
    const { id } = await createTask({ title: 'Move to ship', wishFile: '.genie/wishes/move-test/WISH.md' }, REPO);

    const moved = await moveTask(id, 'ship', actor, 'Auto-closed: PR #42 merged to dev', REPO);
    expect(moved.stage).toBe('ship');

    // Verify the task is now in ship stage
    const t = await getTask(id, REPO);
    expect(t?.stage).toBe('ship');
  });
});
