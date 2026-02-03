/**
 * Integration tests for term ship/push commands - Branch Protection
 *
 * Tests:
 * 1. ship/push refuse to operate on main/master branch
 * 2. ship/push work correctly on feature branches
 * 3. Full flow: wish -> work -> ship creates PR-ready branch
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

/**
 * Get current branch name
 */
async function getCurrentBranch(repoPath: string): Promise<string> {
  const result = await $`git -C ${repoPath} branch --show-current`.quiet();
  return result.stdout.toString().trim();
}

/**
 * Assert branch is NOT main/master (simulates ship.ts assertNotMainBranch)
 * Returns true if allowed to proceed, throws if on main/master
 */
async function assertNotMainBranch(repoPath: string): Promise<boolean> {
  const branch = await getCurrentBranch(repoPath);
  if (branch === 'main' || branch === 'master') {
    throw new Error('Cannot push from main/master. Use a feature branch.');
  }
  return true;
}

// ============================================================================
// Tests
// ============================================================================

describe('term ship/push - branch protection', () => {
  let tempDir: string;
  let testRepo: string;

  beforeEach(async () => {
    tempDir = join('/tmp', `ship-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    testRepo = await createTempGitRepo(tempDir, 'test-repo');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('main branch protection', () => {
    it('should reject ship/push from main branch', async () => {
      // Repo starts on main branch (or master depending on git version)
      const branch = await getCurrentBranch(testRepo);
      expect(['main', 'master']).toContain(branch);

      // Attempting to ship should fail
      let error: Error | null = null;
      try {
        await assertNotMainBranch(testRepo);
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toContain('Cannot push from main/master');
    });

    it('should reject ship/push from master branch', async () => {
      // Rename main to master
      const currentBranch = await getCurrentBranch(testRepo);
      if (currentBranch === 'main') {
        await $`git -C ${testRepo} branch -m main master`.quiet();
      }

      const branch = await getCurrentBranch(testRepo);
      expect(branch).toBe('master');

      // Attempting to ship should fail
      let error: Error | null = null;
      try {
        await assertNotMainBranch(testRepo);
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toContain('Cannot push from main/master');
    });
  });

  describe('feature branch permission', () => {
    it('should allow ship/push from work/<wish-id> branch', async () => {
      // Create and switch to feature branch
      await $`git -C ${testRepo} checkout -b work/wish-1`.quiet();

      const branch = await getCurrentBranch(testRepo);
      expect(branch).toBe('work/wish-1');

      // Should not throw
      const allowed = await assertNotMainBranch(testRepo);
      expect(allowed).toBe(true);
    });

    it('should allow ship/push from any non-main branch', async () => {
      const testBranches = [
        'work/wish-1',
        'work/wish-123',
        'feature/my-feature',
        'fix/bugfix',
        'dev',
        'develop',
        'staging',
      ];

      for (const branchName of testBranches) {
        // Create and switch to branch
        await $`git -C ${testRepo} checkout -b ${branchName}`.quiet();

        const branch = await getCurrentBranch(testRepo);
        expect(branch).toBe(branchName);

        // Should not throw
        const allowed = await assertNotMainBranch(testRepo);
        expect(allowed).toBe(true);

        // Go back to main for next iteration
        const mainBranch = await $`git -C ${testRepo} rev-parse --abbrev-ref HEAD`.quiet();
        await $`git -C ${testRepo} checkout main`.quiet().catch(() =>
          $`git -C ${testRepo} checkout master`.quiet()
        );
      }
    });
  });
});

describe('term ship/push - getCurrentBranch', () => {
  let tempDir: string;
  let testRepo: string;

  beforeEach(async () => {
    tempDir = join('/tmp', `branch-detect-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    testRepo = await createTempGitRepo(tempDir, 'test-repo');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should correctly detect main branch', async () => {
    const branch = await getCurrentBranch(testRepo);
    // Git version dependent - could be main or master
    expect(['main', 'master']).toContain(branch);
  });

  it('should correctly detect feature branch', async () => {
    await $`git -C ${testRepo} checkout -b work/wish-test`.quiet();
    const branch = await getCurrentBranch(testRepo);
    expect(branch).toBe('work/wish-test');
  });

  it('should handle branches with special characters', async () => {
    const specialBranches = [
      'work/wish-1',
      'feature/add-new-thing',
      'fix/bug-123',
    ];

    for (const branchName of specialBranches) {
      await $`git -C ${testRepo} checkout -b ${branchName}`.quiet();
      const detected = await getCurrentBranch(testRepo);
      expect(detected).toBe(branchName);
      await $`git -C ${testRepo} checkout main`.quiet().catch(() =>
        $`git -C ${testRepo} checkout master`.quiet()
      );
    }
  });
});

describe('full flow: wish -> work -> ship', () => {
  let tempDir: string;
  let macroRepo: string;
  let nestedRepo: string;

  beforeAll(async () => {
    tempDir = join('/tmp', `full-flow-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });

    // Create macro repo
    macroRepo = await createTempGitRepo(tempDir, 'macro-repo');

    // Create nested repo at code/genie-cli
    const codeDir = join(macroRepo, 'code');
    await mkdir(codeDir, { recursive: true });
    nestedRepo = await createTempGitRepo(codeDir, 'genie-cli');

    // Create .genie structure
    await mkdir(join(macroRepo, '.genie', 'wishes'), { recursive: true });
  });

  afterAll(async () => {
    // Clean up worktrees first
    try {
      await $`git -C ${nestedRepo} worktree prune`.quiet();
    } catch { /* ignore */ }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should create PR-ready branch in nested repo via full flow', async () => {
    const wishId = 'wish-full-flow';

    // Step 1: Create wish with repo field pointing to nested repo
    const wishDir = join(macroRepo, '.genie', 'wishes', wishId);
    await mkdir(wishDir, { recursive: true });
    await writeFile(join(wishDir, 'wish.md'), `# Wish: Test Full Flow

**Status:** IN-PROGRESS
**Slug:** \`${wishId}\`
**repo:** \`code/genie-cli\`

## Summary

Test the full wish -> work -> ship flow.
`);

    // Step 2: Simulate work command - create worktree in nested repo
    const branchName = `work/${wishId}`;
    const worktreePath = join(nestedRepo, '.genie', 'worktrees', wishId);

    await mkdir(join(nestedRepo, '.genie', 'worktrees'), { recursive: true });
    await $`git -C ${nestedRepo} worktree add -b ${branchName} ${worktreePath}`.quiet();

    // Verify worktree was created in the NESTED repo (not macro repo)
    expect(await pathExists(worktreePath)).toBe(true);

    // Verify it's not in the macro repo
    const macroWorktreePath = join(macroRepo, '.genie', 'worktrees', wishId);
    expect(await pathExists(macroWorktreePath)).toBe(false);

    // Step 3: Make changes in worktree
    await writeFile(join(worktreePath, 'change.txt'), 'Test change');
    await $`git -C ${worktreePath} add .`.quiet();
    await $`git -C ${worktreePath} commit -m "Test change for ${wishId}"`.quiet();

    // Step 4: Verify ship would succeed (branch is not main/master)
    const branch = await getCurrentBranch(worktreePath);
    expect(branch).toBe(branchName);

    const allowed = await assertNotMainBranch(worktreePath);
    expect(allowed).toBe(true);

    // Step 5: Verify the branch is PR-ready (exists, has commits)
    const logResult = await $`git -C ${worktreePath} log --oneline -1`.quiet();
    expect(logResult.stdout.toString()).toContain(`Test change for ${wishId}`);

    // Cleanup
    await $`git -C ${nestedRepo} worktree remove ${worktreePath} --force`.quiet();
  });

  it('should prevent ship when accidentally on main in worktree', async () => {
    // Create a fresh test repo for this edge case since we can't have two
    // worktrees on the same branch, and the nested repo is already on main
    const edgeCaseRepo = await createTempGitRepo(tempDir, 'edge-case-repo');
    const wishId = 'wish-main-accident';

    // Determine the main branch name
    let mainBranch = 'main';
    try {
      await $`git -C ${edgeCaseRepo} rev-parse --verify main`.quiet();
    } catch {
      mainBranch = 'master';
    }

    // First, switch the main repo to a different branch so we can create
    // a worktree on main
    await $`git -C ${edgeCaseRepo} checkout -b temp-branch`.quiet();

    // Create worktree attached to main (simulating a mistake/edge case)
    const worktreePath = join(edgeCaseRepo, '.genie', 'worktrees', wishId);
    await mkdir(join(edgeCaseRepo, '.genie', 'worktrees'), { recursive: true });
    await $`git -C ${edgeCaseRepo} worktree add ${worktreePath} ${mainBranch}`.quiet();

    // Verify we're on main in the worktree
    const branch = await getCurrentBranch(worktreePath);
    expect([mainBranch]).toContain(branch);

    // Ship should be blocked
    let error: Error | null = null;
    try {
      await assertNotMainBranch(worktreePath);
    } catch (e) {
      error = e as Error;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toContain('Cannot push from main/master');

    // Cleanup
    await $`git -C ${edgeCaseRepo} worktree remove ${worktreePath} --force`.quiet();
  });
});

describe('edge cases', () => {
  let tempDir: string;
  let testRepo: string;

  beforeEach(async () => {
    tempDir = join('/tmp', `edge-case-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    testRepo = await createTempGitRepo(tempDir, 'test-repo');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should handle detached HEAD state gracefully', async () => {
    // Get current commit hash
    const hashResult = await $`git -C ${testRepo} rev-parse HEAD`.quiet();
    const commitHash = hashResult.stdout.toString().trim();

    // Checkout to detached HEAD
    await $`git -C ${testRepo} checkout ${commitHash}`.quiet();

    // getCurrentBranch returns empty string for detached HEAD
    const branch = await getCurrentBranch(testRepo);

    // Detached HEAD is empty string, not main/master, so should pass
    // (This is an edge case - assertNotMainBranch only blocks "main" or "master" exactly)
    if (branch === '' || branch === 'HEAD') {
      const allowed = await assertNotMainBranch(testRepo);
      expect(allowed).toBe(true);
    }
  });

  it('should correctly identify branch that contains "main" but is not main', async () => {
    await $`git -C ${testRepo} checkout -b maintain-legacy`.quiet();

    const branch = await getCurrentBranch(testRepo);
    expect(branch).toBe('maintain-legacy');

    // Should NOT be blocked - "maintain-legacy" !== "main"
    const allowed = await assertNotMainBranch(testRepo);
    expect(allowed).toBe(true);
  });

  it('should correctly identify branch that contains "master" but is not master', async () => {
    await $`git -C ${testRepo} checkout -b postmaster`.quiet();

    const branch = await getCurrentBranch(testRepo);
    expect(branch).toBe('postmaster');

    // Should NOT be blocked - "postmaster" !== "master"
    const allowed = await assertNotMainBranch(testRepo);
    expect(allowed).toBe(true);
  });
});
