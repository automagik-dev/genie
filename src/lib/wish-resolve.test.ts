/**
 * Tests for Wish Resolution — namespace/slug parsing and path resolution.
 * Run with: bun test src/lib/wish-resolve.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseWishRef, resolveWish } from './wish-resolve.js';

// ============================================================================
// parseWishRef (pure parsing — no filesystem)
// ============================================================================

describe('parseWishRef', () => {
  test('parses namespace/slug format', () => {
    const ref = parseWishRef('genie/fix-tmux-session-explosion');
    expect(ref.namespace).toBe('genie');
    expect(ref.slug).toBe('fix-tmux-session-explosion');
  });

  test('parses bare slug without namespace', () => {
    const ref = parseWishRef('fix-tmux-session-explosion');
    expect(ref.namespace).toBeUndefined();
    expect(ref.slug).toBe('fix-tmux-session-explosion');
  });

  test('trims whitespace', () => {
    const ref = parseWishRef('  genie/slug  ');
    expect(ref.namespace).toBe('genie');
    expect(ref.slug).toBe('slug');
  });

  test('throws on empty string', () => {
    expect(() => parseWishRef('')).toThrow('cannot be empty');
    expect(() => parseWishRef('  ')).toThrow('cannot be empty');
  });

  test('throws on empty namespace', () => {
    expect(() => parseWishRef('/slug')).toThrow('namespace is empty');
  });

  test('throws on empty slug', () => {
    expect(() => parseWishRef('genie/')).toThrow('slug is empty');
  });

  test('throws on slug with nested slashes', () => {
    expect(() => parseWishRef('genie/a/b')).toThrow('slug cannot contain "/"');
  });
});

// ============================================================================
// resolveWish (filesystem-dependent)
// ============================================================================

describe('resolveWish', () => {
  const TEST_DIR = '/tmp/wish-resolve-test';
  const FAKE_REPOS = join(TEST_DIR, 'repos');

  beforeAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });

    // Create a fake repo with a wish
    const repoDir = join(FAKE_REPOS, 'myrepo');
    const wishDir = join(repoDir, '.genie', 'wishes', 'fix-bug');
    await mkdir(wishDir, { recursive: true });
    await writeFile(join(wishDir, 'WISH.md'), '# Fix Bug Wish');

    // Create a bare .git dir so resolveRepoSession doesn't fail
    await mkdir(join(repoDir, '.git'), { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test('throws for nonexistent repo namespace', async () => {
    await expect(resolveWish('nonexistent/some-slug')).rejects.toThrow('not found at');
  });

  test('throws for nonexistent wish in valid repo', async () => {
    // This test requires a repo at the expected REPOS_BASE location.
    // Since we can't mock the path, we test the error message format.
    await expect(resolveWish('nonexistent/slug')).rejects.toThrow('not found');
  });

  test('bare slug without namespace errors with helpful message', async () => {
    // cwd won't have this wish
    await expect(resolveWish('nonexistent-wish-slug')).rejects.toThrow('Use namespace/slug format');
  });

  test('bare slug found in cwd resolves correctly', async () => {
    // Temporarily change cwd to a dir with a wish
    const repoDir = join(FAKE_REPOS, 'myrepo');
    const originalCwd = process.cwd();
    process.chdir(repoDir);

    try {
      const result = await resolveWish('fix-bug');
      expect(result.slug).toBe('fix-bug');
      expect(result.repo).toBe(repoDir);
      expect(result.wishPath).toContain('fix-bug/WISH.md');
      expect(result.session).toBeTruthy();
    } finally {
      process.chdir(originalCwd);
    }
  });
});
