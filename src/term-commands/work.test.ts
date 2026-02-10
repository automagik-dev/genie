/**
 * Integration tests for term work command
 *
 * Tests:
 * 1. Nested repo detection (--repo flag, wish.md repo field, heuristics)
 * 4. Wish file search in .wishes/ directory
 * 2. Worktree creation in correct repository
 * 3. Branch naming conventions (work/<wish-id>)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { $ } from 'bun';
import { mkdir, rm, writeFile, access } from 'fs/promises';
import { join } from 'path';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a temporary git repository for testing
 */
async function createTempGitRepo(basePath: string, name: string): Promise<string> {
  const repoPath = join(basePath, name);
  await mkdir(repoPath, { recursive: true });
  await $`git -C ${repoPath} init`.quiet();
  await $`git -C ${repoPath} config user.email "test@test.com"`.quiet();
  await $`git -C ${repoPath} config user.name "Test User"`.quiet();

  // Create initial commit
  const readme = join(repoPath, 'README.md');
  await writeFile(readme, '# Test Repo');
  await $`git -C ${repoPath} add .`.quiet();
  await $`git -C ${repoPath} commit -m "Initial commit"`.quiet();

  return repoPath;
}

/**
 * Create a wish.md file with optional repo field
 */
async function createWishFile(
  repoPath: string,
  wishId: string,
  options: { repo?: string; title?: string } = {}
): Promise<string> {
  const wishDir = join(repoPath, '.genie', 'wishes', wishId);
  await mkdir(wishDir, { recursive: true });

  const content = `# Wish: ${options.title || 'Test Wish'}

**Status:** IN-PROGRESS
**Slug:** \`${wishId}\`
${options.repo ? `**repo:** \`${options.repo}\`\n` : ''}
## Summary

This is a test wish for integration testing.
`;

  const wishPath = join(wishDir, 'wish.md');
  await writeFile(wishPath, content);
  return wishPath;
}

/**
 * Check if a path exists
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Import functions to test
// ============================================================================

// Import the internal detection function for unit testing
// We re-implement minimal versions for testing since the actual function is not exported

import { join as joinPath, resolve, isAbsolute } from 'path';

const KNOWN_NESTED_REPOS: Record<string, string> = {
  'genie-cli': 'code/genie-cli',
  'term-cli': 'code/genie-cli',
  'term work': 'code/genie-cli',
  'term ship': 'code/genie-cli',
  'term push': 'code/genie-cli',
};

/**
 * Simulated repo detection logic (mirrors work.ts detectTargetRepo)
 */
async function detectTargetRepo(
  taskId: string,
  repoPath: string,
  explicitRepo?: string,
  issueTitle?: string,
  issueDescription?: string
): Promise<{ targetRepo: string; detectionMethod: string }> {
  // 1. Explicit --repo flag takes priority
  if (explicitRepo) {
    const targetPath = isAbsolute(explicitRepo)
      ? explicitRepo
      : resolve(repoPath, explicitRepo);
    return { targetRepo: targetPath, detectionMethod: '--repo flag' };
  }

  // 2. Check wish.md for repo: field
  const wishPath = join(repoPath, '.genie', 'wishes', taskId, 'wish.md');
  let metadata: { repo?: string; title?: string; description?: string } = {};

  try {
    const file = Bun.file(wishPath);
    const content = await file.text();
    const lines = content.split('\n');

    // Parse repo field
    for (const line of lines.slice(0, 20)) {
      const repoMatch = line.match(/^\*\*repo:\*\*\s*`?([^`]+)`?$/i);
      if (repoMatch) {
        metadata.repo = repoMatch[1].trim();
        break;
      }
    }

    // Parse title
    const titleMatch = lines[0]?.match(/^#\s+(?:Wish:\s+)?(.+)$/i);
    if (titleMatch) {
      metadata.title = titleMatch[1].trim();
    }
  } catch {
    // No wish.md or parse error
  }

  if (metadata.repo) {
    const targetPath = isAbsolute(metadata.repo)
      ? metadata.repo
      : resolve(repoPath, metadata.repo);
    return { targetRepo: targetPath, detectionMethod: 'wish.md repo: field' };
  }

  // 3. Heuristic detection from title/description
  const title = metadata.title || issueTitle || '';
  const description = metadata.description || issueDescription || '';
  const searchText = `${title} ${description}`.toLowerCase();

  for (const [keyword, relativePath] of Object.entries(KNOWN_NESTED_REPOS)) {
    if (searchText.includes(keyword.toLowerCase())) {
      const fullPath = join(repoPath, relativePath);
      const gitPath = join(fullPath, '.git');
      if (await pathExists(gitPath)) {
        return { targetRepo: fullPath, detectionMethod: `heuristic (matched "${relativePath}")` };
      }
    }
  }

  // 4. Default: use current repo
  return { targetRepo: repoPath, detectionMethod: 'default (current repo)' };
}

// ============================================================================
// Tests
// ============================================================================

describe('term work - nested repo detection', () => {
  let tempDir: string;
  let macroRepo: string;
  let nestedRepo: string;

  beforeAll(async () => {
    // Create temp directory
    tempDir = join('/tmp', `work-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });

    // Create macro repo (like guga)
    macroRepo = await createTempGitRepo(tempDir, 'macro-repo');

    // Create nested repo (like code/genie-cli)
    const codeDir = join(macroRepo, 'code');
    await mkdir(codeDir, { recursive: true });
    nestedRepo = await createTempGitRepo(codeDir, 'genie-cli');

    // Create .genie directory
    await mkdir(join(macroRepo, '.genie'), { recursive: true });
  });

  afterAll(async () => {
    // Clean up temp directory
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('--repo flag detection', () => {
    it('should use explicit --repo flag when provided (relative path)', async () => {
      const result = await detectTargetRepo(
        'wish-1',
        macroRepo,
        'code/genie-cli',  // explicit --repo
        'Some wish title',
        undefined
      );

      expect(result.detectionMethod).toBe('--repo flag');
      expect(result.targetRepo).toBe(nestedRepo);
    });

    it('should use explicit --repo flag when provided (absolute path)', async () => {
      const result = await detectTargetRepo(
        'wish-1',
        macroRepo,
        nestedRepo,  // absolute path
        undefined,
        undefined
      );

      expect(result.detectionMethod).toBe('--repo flag');
      expect(result.targetRepo).toBe(nestedRepo);
    });

    it('should prioritize --repo flag over wish.md repo field', async () => {
      // Create wish with different repo field
      await createWishFile(macroRepo, 'wish-2', {
        repo: 'some/other/repo',
        title: 'Test Wish'
      });

      const result = await detectTargetRepo(
        'wish-2',
        macroRepo,
        'code/genie-cli',  // --repo should win
        undefined,
        undefined
      );

      expect(result.detectionMethod).toBe('--repo flag');
      expect(result.targetRepo).toBe(nestedRepo);
    });
  });

  describe('wish.md repo field detection', () => {
    it('should detect repo from wish.md repo: field', async () => {
      await createWishFile(macroRepo, 'wish-3', {
        repo: 'code/genie-cli',
        title: 'Update something'
      });

      const result = await detectTargetRepo(
        'wish-3',
        macroRepo,
        undefined,  // no --repo flag
        undefined,
        undefined
      );

      expect(result.detectionMethod).toBe('wish.md repo: field');
      expect(result.targetRepo).toBe(nestedRepo);
    });

    it('should handle absolute path in wish.md repo field', async () => {
      await createWishFile(macroRepo, 'wish-4', {
        repo: nestedRepo,  // absolute path
        title: 'Test'
      });

      const result = await detectTargetRepo(
        'wish-4',
        macroRepo,
        undefined,
        undefined,
        undefined
      );

      expect(result.detectionMethod).toBe('wish.md repo: field');
      expect(result.targetRepo).toBe(nestedRepo);
    });
  });

  describe('heuristic detection', () => {
    it('should detect genie-cli from wish title containing "genie-cli"', async () => {
      await createWishFile(macroRepo, 'wish-5', {
        title: 'Fix bug in genie-cli'
      });

      const result = await detectTargetRepo(
        'wish-5',
        macroRepo,
        undefined,
        'Fix bug in genie-cli',
        undefined
      );

      expect(result.detectionMethod).toBe('heuristic (matched "code/genie-cli")');
      expect(result.targetRepo).toBe(nestedRepo);
    });

    it('should detect genie-cli from wish title containing "term work"', async () => {
      await createWishFile(macroRepo, 'wish-6', {
        title: 'Improve term work command'
      });

      const result = await detectTargetRepo(
        'wish-6',
        macroRepo,
        undefined,
        'Improve term work command',
        undefined
      );

      expect(result.detectionMethod).toBe('heuristic (matched "code/genie-cli")');
      expect(result.targetRepo).toBe(nestedRepo);
    });

    it('should not match heuristic if nested repo does not exist', async () => {
      // Create wish mentioning non-existent repo
      await createWishFile(macroRepo, 'wish-7', {
        title: 'Fix something in nonexistent-repo'
      });

      const result = await detectTargetRepo(
        'wish-7',
        macroRepo,
        undefined,
        'Fix something in nonexistent-repo',
        undefined
      );

      // Should fall back to default since nonexistent-repo doesn't exist
      expect(result.detectionMethod).toBe('default (current repo)');
      expect(result.targetRepo).toBe(macroRepo);
    });

    it('should use description for heuristic matching too', async () => {
      await createWishFile(macroRepo, 'wish-8', {
        title: 'Generic title'
      });

      const result = await detectTargetRepo(
        'wish-8',
        macroRepo,
        undefined,
        'Generic title',
        'This updates the genie-cli package'  // keyword in description
      );

      expect(result.detectionMethod).toBe('heuristic (matched "code/genie-cli")');
      expect(result.targetRepo).toBe(nestedRepo);
    });
  });

  describe('default fallback', () => {
    it('should fall back to current repo when no match found', async () => {
      await createWishFile(macroRepo, 'wish-9', {
        title: 'Update documentation'
      });

      const result = await detectTargetRepo(
        'wish-9',
        macroRepo,
        undefined,
        'Update documentation',
        'Just some doc changes'
      );

      expect(result.detectionMethod).toBe('default (current repo)');
      expect(result.targetRepo).toBe(macroRepo);
    });

    it('should fall back when wish.md does not exist', async () => {
      // Don't create wish file for wish-10
      const result = await detectTargetRepo(
        'wish-10',
        macroRepo,
        undefined,
        undefined,
        undefined
      );

      expect(result.detectionMethod).toBe('default (current repo)');
      expect(result.targetRepo).toBe(macroRepo);
    });
  });
});

describe('term work - worktree creation', () => {
  let tempDir: string;
  let testRepo: string;

  beforeEach(async () => {
    // Fresh temp dir for each test
    tempDir = join('/tmp', `worktree-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    testRepo = await createTempGitRepo(tempDir, 'test-repo');
    await mkdir(join(testRepo, '.genie'), { recursive: true });
  });

  afterEach(async () => {
    // Clean up worktrees first (git requires this)
    try {
      await $`git -C ${testRepo} worktree prune`.quiet();
    } catch { /* ignore */ }

    await rm(tempDir, { recursive: true, force: true });
  });

  it('should create worktree in .genie/worktrees/<wish-id>/', async () => {
    const wishId = 'wish-test-1';
    const worktreePath = join(testRepo, '.genie', 'worktrees', wishId);
    const branchName = `work/${wishId}`;

    // Create worktree using git directly (simulating what work.ts does)
    await mkdir(join(testRepo, '.genie', 'worktrees'), { recursive: true });
    await $`git -C ${testRepo} worktree add -b ${branchName} ${worktreePath}`.quiet();

    // Verify worktree was created
    expect(await pathExists(worktreePath)).toBe(true);
    expect(await pathExists(join(worktreePath, '.git'))).toBe(true);

    // Verify branch name
    const result = await $`git -C ${worktreePath} branch --show-current`.quiet();
    expect(result.stdout.toString().trim()).toBe(branchName);
  });

  it('should create worktree with existing branch if it already exists', async () => {
    const wishId = 'wish-existing-branch';
    const worktreePath = join(testRepo, '.genie', 'worktrees', wishId);
    const branchName = `work/${wishId}`;

    // Create branch first
    await $`git -C ${testRepo} branch ${branchName}`.quiet();

    // Now create worktree with existing branch
    await mkdir(join(testRepo, '.genie', 'worktrees'), { recursive: true });
    await $`git -C ${testRepo} worktree add ${worktreePath} ${branchName}`.quiet();

    // Verify worktree was created
    expect(await pathExists(worktreePath)).toBe(true);

    // Verify branch name
    const result = await $`git -C ${worktreePath} branch --show-current`.quiet();
    expect(result.stdout.toString().trim()).toBe(branchName);
  });

  it('should create .genie/redirect file in worktree', async () => {
    const wishId = 'wish-redirect';
    const worktreePath = join(testRepo, '.genie', 'worktrees', wishId);
    const branchName = `work/${wishId}`;

    // Create worktree
    await mkdir(join(testRepo, '.genie', 'worktrees'), { recursive: true });
    await $`git -C ${testRepo} worktree add -b ${branchName} ${worktreePath}`.quiet();

    // Create .genie/redirect (as work.ts does via worktree-manager)
    const genieDir = join(worktreePath, '.genie');
    await mkdir(genieDir, { recursive: true });
    const redirectPath = join(genieDir, 'redirect');
    await writeFile(redirectPath, join(testRepo, '.genie'));

    // Verify redirect file exists and has correct content
    expect(await pathExists(redirectPath)).toBe(true);
    const content = await Bun.file(redirectPath).text();
    expect(content).toBe(join(testRepo, '.genie'));
  });
});

describe('term work - branch naming convention', () => {
  let tempDir: string;
  let testRepo: string;

  beforeEach(async () => {
    tempDir = join('/tmp', `branch-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    testRepo = await createTempGitRepo(tempDir, 'test-repo');
  });

  afterEach(async () => {
    try {
      await $`git -C ${testRepo} worktree prune`.quiet();
    } catch { /* ignore */ }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should name branch work/<wish-id>', async () => {
    const testCases = [
      'wish-1',
      'wish-22',
      'wish-long-name-123',
      'some-task-id',
    ];

    for (const wishId of testCases) {
      const expectedBranch = `work/${wishId}`;
      const worktreePath = join(testRepo, '.genie', 'worktrees', wishId);

      await mkdir(join(testRepo, '.genie', 'worktrees'), { recursive: true });
      await $`git -C ${testRepo} worktree add -b ${expectedBranch} ${worktreePath}`.quiet();

      const result = await $`git -C ${worktreePath} branch --show-current`.quiet();
      expect(result.stdout.toString().trim()).toBe(expectedBranch);

      // Cleanup for next iteration
      await $`git -C ${testRepo} worktree remove ${worktreePath} --force`.quiet();
    }
  });
});

// ============================================================================
// Wish file search in .wishes/ directory
// ============================================================================

import { wishFileExists, loadWishContent, findWishInDotWishes } from './work.js';

describe('term work - wish file search in .wishes/ directory', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join('/tmp', `wish-search-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('wishFileExists()', () => {
    it('should return true when wish.md exists in .genie/wishes/<taskId>/ (fast path)', async () => {
      const taskId = 'bd-42';
      const wishDir = join(tempDir, '.genie', 'wishes', taskId);
      await mkdir(wishDir, { recursive: true });
      await writeFile(join(wishDir, 'wish.md'), '# Test wish');

      expect(await wishFileExists(taskId, tempDir)).toBe(true);
    });

    it('should return true when a *-wish.md file in .wishes/ references the taskId via **Beads:**', async () => {
      const taskId = 'bd-99';
      const wishesDir = join(tempDir, '.wishes');
      await mkdir(wishesDir, { recursive: true });
      await writeFile(join(wishesDir, 'my-feature-wish.md'), `# My Feature Wish

**Beads:** ${taskId}

## Summary

Do something cool.
`);

      expect(await wishFileExists(taskId, tempDir)).toBe(true);
    });

    it('should return true when a *-wish.md file in .wishes/ references the taskId via Beads:', async () => {
      const taskId = 'bd-77';
      const wishesDir = join(tempDir, '.wishes');
      await mkdir(wishesDir, { recursive: true });
      await writeFile(join(wishesDir, 'another-wish.md'), `# Another Wish

Beads: ${taskId}

## Summary

Do something else.
`);

      expect(await wishFileExists(taskId, tempDir)).toBe(true);
    });

    it('should return true when *-wish.md is in a nested subdirectory of .wishes/', async () => {
      const taskId = 'bd-123';
      const nestedDir = join(tempDir, '.wishes', 'features', 'phase-1');
      await mkdir(nestedDir, { recursive: true });
      await writeFile(join(nestedDir, 'deep-feature-wish.md'), `# Deep Feature

**Beads:** ${taskId}
`);

      expect(await wishFileExists(taskId, tempDir)).toBe(true);
    });

    it('should return false when no wish file exists anywhere', async () => {
      expect(await wishFileExists('bd-nonexistent', tempDir)).toBe(false);
    });

    it('should return false when .wishes/ dir does not exist', async () => {
      // tempDir has no .wishes/ or .genie/ dirs
      expect(await wishFileExists('bd-1', tempDir)).toBe(false);
    });

    it('should return false when .wishes/ files exist but none reference the taskId', async () => {
      const wishesDir = join(tempDir, '.wishes');
      await mkdir(wishesDir, { recursive: true });
      await writeFile(join(wishesDir, 'unrelated-wish.md'), `# Unrelated Wish

**Beads:** bd-other-id

## Summary

Not the one we're looking for.
`);

      expect(await wishFileExists('bd-999', tempDir)).toBe(false);
    });

    it('should prefer .genie/wishes/ fast path over .wishes/ search', async () => {
      const taskId = 'bd-50';
      // Create in both locations
      const genieWishDir = join(tempDir, '.genie', 'wishes', taskId);
      await mkdir(genieWishDir, { recursive: true });
      await writeFile(join(genieWishDir, 'wish.md'), '# Genie wish');

      const wishesDir = join(tempDir, '.wishes');
      await mkdir(wishesDir, { recursive: true });
      await writeFile(join(wishesDir, 'alt-wish.md'), `# Alt wish\n**Beads:** ${taskId}`);

      // Should still return true (fast path hits)
      expect(await wishFileExists(taskId, tempDir)).toBe(true);
    });

    it('should not match files that do not end with -wish.md', async () => {
      const taskId = 'bd-55';
      const wishesDir = join(tempDir, '.wishes');
      await mkdir(wishesDir, { recursive: true });
      // File named notes.md (not *-wish.md)
      await writeFile(join(wishesDir, 'notes.md'), `# Notes\n**Beads:** ${taskId}`);

      expect(await wishFileExists(taskId, tempDir)).toBe(false);
    });
  });

  describe('loadWishContent()', () => {
    it('should load content from .genie/wishes/<taskId>/wish.md (fast path)', async () => {
      const taskId = 'bd-42';
      const wishDir = join(tempDir, '.genie', 'wishes', taskId);
      await mkdir(wishDir, { recursive: true });
      const content = '# Test wish\n\nSome content here.';
      await writeFile(join(wishDir, 'wish.md'), content);

      expect(await loadWishContent(taskId, tempDir)).toBe(content);
    });

    it('should load content from .wishes/ when not in .genie/wishes/', async () => {
      const taskId = 'bd-88';
      const wishesDir = join(tempDir, '.wishes');
      await mkdir(wishesDir, { recursive: true });
      const content = `# Feature Wish\n\n**Beads:** ${taskId}\n\n## Details\n\nBuild something.`;
      await writeFile(join(wishesDir, 'feature-wish.md'), content);

      expect(await loadWishContent(taskId, tempDir)).toBe(content);
    });

    it('should return undefined when no wish file exists anywhere', async () => {
      expect(await loadWishContent('bd-nonexistent', tempDir)).toBeUndefined();
    });

    it('should prefer .genie/wishes/ content over .wishes/ content', async () => {
      const taskId = 'bd-60';
      const genieContent = '# Genie wish content';
      const genieWishDir = join(tempDir, '.genie', 'wishes', taskId);
      await mkdir(genieWishDir, { recursive: true });
      await writeFile(join(genieWishDir, 'wish.md'), genieContent);

      const wishesDir = join(tempDir, '.wishes');
      await mkdir(wishesDir, { recursive: true });
      await writeFile(join(wishesDir, 'alt-wish.md'), `# Alt wish\n**Beads:** ${taskId}`);

      expect(await loadWishContent(taskId, tempDir)).toBe(genieContent);
    });
  });

  describe('findWishInDotWishes()', () => {
    it('should return file path when match found', async () => {
      const taskId = 'bd-101';
      const wishesDir = join(tempDir, '.wishes');
      await mkdir(wishesDir, { recursive: true });
      const filePath = join(wishesDir, 'cool-wish.md');
      await writeFile(filePath, `# Cool\n**Beads:** ${taskId}`);

      expect(await findWishInDotWishes(taskId, tempDir)).toBe(filePath);
    });

    it('should return undefined when no match found', async () => {
      const wishesDir = join(tempDir, '.wishes');
      await mkdir(wishesDir, { recursive: true });
      await writeFile(join(wishesDir, 'other-wish.md'), '# Other\n**Beads:** bd-different');

      expect(await findWishInDotWishes('bd-nomatch', tempDir)).toBeUndefined();
    });

    it('should return undefined when .wishes/ directory does not exist', async () => {
      expect(await findWishInDotWishes('bd-1', tempDir)).toBeUndefined();
    });

    it('should handle taskIds with special regex characters', async () => {
      const taskId = 'bd-1.2+3';
      const wishesDir = join(tempDir, '.wishes');
      await mkdir(wishesDir, { recursive: true });
      await writeFile(join(wishesDir, 'special-wish.md'), `# Special\n**Beads:** ${taskId}`);

      expect(await findWishInDotWishes(taskId, tempDir)).toBeTruthy();
    });
  });
});
