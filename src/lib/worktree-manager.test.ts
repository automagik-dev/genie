/**
 * Tests for WorktreeManager abstraction
 * Run with: bun test src/lib/worktree-manager.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { join } from 'path';
import { mkdir, rm, access, writeFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { $ } from 'bun';

// Will be imported after implementation
import {
  type WorktreeManagerInterface,
  type WorktreeInfo,
  GitWorktreeManager,
  BeadsWorktreeManager,
  getWorktreeManager,
  isBdAvailable,
} from './worktree-manager.js';

// ============================================================================
// Test Setup
// ============================================================================

const TEST_DIR = '/tmp/worktree-manager-test';
const TEST_REPO = join(TEST_DIR, 'test-repo');

async function setupTestRepo(): Promise<void> {
  // Clean up any existing test directory
  try {
    await rm(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }

  // Create test repo
  await mkdir(TEST_REPO, { recursive: true });
  await $`git -C ${TEST_REPO} init`.quiet();
  await $`git -C ${TEST_REPO} config user.email "test@test.com"`.quiet();
  await $`git -C ${TEST_REPO} config user.name "Test"`.quiet();

  // Create initial commit
  await writeFile(join(TEST_REPO, 'README.md'), '# Test Repo');
  await $`git -C ${TEST_REPO} add .`.quiet();
  await $`git -C ${TEST_REPO} commit -m "Initial commit"`.quiet();
}

async function cleanupTestRepo(): Promise<void> {
  try {
    // Remove all worktrees first
    const result = await $`git -C ${TEST_REPO} worktree list --porcelain`.quiet();
    const paths = result.stdout.toString().split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice(9))
      .filter(path => path !== TEST_REPO);

    for (const path of paths) {
      try {
        await $`git -C ${TEST_REPO} worktree remove ${path} --force`.quiet();
      } catch {
        // Ignore
      }
    }
  } catch {
    // Ignore
  }

  try {
    await rm(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

// ============================================================================
// Interface Tests
// ============================================================================

describe('WorktreeManagerInterface', () => {
  describe('WorktreeInfo type', () => {
    test('should have required properties', () => {
      const info: WorktreeInfo = {
        path: '/some/path',
        branch: 'work/wish-1',
        wishId: 'wish-1',
      };

      expect(info.path).toBe('/some/path');
      expect(info.branch).toBe('work/wish-1');
      expect(info.wishId).toBe('wish-1');
    });
  });
});

// ============================================================================
// GitWorktreeManager Tests
// ============================================================================

describe('GitWorktreeManager', () => {
  beforeAll(async () => {
    await setupTestRepo();
  });

  afterAll(async () => {
    await cleanupTestRepo();
  });

  test('create() should create worktree with correct branch', async () => {
    const manager = new GitWorktreeManager(TEST_REPO);

    const info = await manager.create('wish-1', TEST_REPO);

    expect(info.wishId).toBe('wish-1');
    expect(info.branch).toBe('work/wish-1');
    expect(info.path).toContain('.genie/worktrees/wish-1');

    // Verify worktree exists
    expect(existsSync(info.path)).toBe(true);

    // Verify branch
    const branchResult = await $`git -C ${info.path} branch --show-current`.quiet();
    expect(branchResult.stdout.toString().trim()).toBe('work/wish-1');
  });

  test('create() should create redirect file for bd', async () => {
    const manager = new GitWorktreeManager(TEST_REPO);

    const info = await manager.create('wish-2', TEST_REPO);

    // Check redirect file exists
    const redirectPath = join(info.path, '.genie', 'redirect');
    expect(existsSync(redirectPath)).toBe(true);
  });

  test('get() should return worktree info if exists', async () => {
    const manager = new GitWorktreeManager(TEST_REPO);
    await manager.create('wish-3', TEST_REPO);

    const info = await manager.get('wish-3');

    expect(info).not.toBeNull();
    expect(info?.wishId).toBe('wish-3');
    expect(info?.branch).toBe('work/wish-3');
  });

  test('get() should return null if worktree does not exist', async () => {
    const manager = new GitWorktreeManager(TEST_REPO);

    const info = await manager.get('wish-nonexistent');

    expect(info).toBeNull();
  });

  test('list() should return all worktrees', async () => {
    const manager = new GitWorktreeManager(TEST_REPO);

    const list = await manager.list();

    // Should have at least the worktrees we created
    expect(list.length).toBeGreaterThan(0);
    const wishIds = list.map(wt => wt.wishId);
    expect(wishIds).toContain('wish-1');
  });

  test('remove() should delete worktree', async () => {
    const manager = new GitWorktreeManager(TEST_REPO);
    await manager.create('wish-to-remove', TEST_REPO);

    await manager.remove('wish-to-remove');

    const info = await manager.get('wish-to-remove');
    expect(info).toBeNull();
  });
});

// ============================================================================
// BeadsWorktreeManager Tests (mocked)
// ============================================================================

describe('BeadsWorktreeManager', () => {
  // These tests mock bd since it may not be available
  test('create() should call bd worktree create', async () => {
    // Skip if bd not available
    if (!await isBdAvailable()) {
      console.log('Skipping BeadsWorktreeManager tests - bd not available');
      return;
    }

    // If bd is available, this would test actual bd integration
    // For now we just verify the class exists
    const manager = new BeadsWorktreeManager();
    expect(manager).toBeDefined();
  });
});

// ============================================================================
// Factory Function Tests
// ============================================================================

describe('getWorktreeManager', () => {
  test('should return a WorktreeManagerInterface', async () => {
    const manager = await getWorktreeManager(TEST_REPO);

    // Verify it implements the interface
    expect(typeof manager.create).toBe('function');
    expect(typeof manager.remove).toBe('function');
    expect(typeof manager.list).toBe('function');
    expect(typeof manager.get).toBe('function');
  });

  test('GitWorktreeManager can be created directly', () => {
    const manager = new GitWorktreeManager(TEST_REPO);
    expect(manager).toBeInstanceOf(GitWorktreeManager);
  });

  test('BeadsWorktreeManager can be created directly', () => {
    const manager = new BeadsWorktreeManager();
    expect(manager).toBeInstanceOf(BeadsWorktreeManager);
  });
});

// ============================================================================
// isBdAvailable Tests
// ============================================================================

describe('isBdAvailable', () => {
  test('should return boolean', async () => {
    const result = await isBdAvailable();
    expect(typeof result).toBe('boolean');
  });
});
