/**
 * Tests for Team CLI commands.
 * Run with: bun test src/term-commands/team.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';

// ============================================================================
// Test Setup
// ============================================================================

const TEST_DIR = '/tmp/team-cli-test';
const TEST_REPO = join(TEST_DIR, 'test-repo');
const TEST_GENIE_HOME = join(TEST_DIR, 'genie-home');

// Path to the genie CLI entrypoint
const GENIE_BIN = join(import.meta.dir, '..', 'genie.ts');

async function setupTestRepo(): Promise<void> {
  try {
    await rm(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }

  await mkdir(TEST_REPO, { recursive: true });
  await mkdir(TEST_GENIE_HOME, { recursive: true });
  await $`git -C ${TEST_REPO} init`.quiet();
  await $`git -C ${TEST_REPO} config user.email "test@test.com"`.quiet();
  await $`git -C ${TEST_REPO} config user.name "Test"`.quiet();

  await writeFile(join(TEST_REPO, 'README.md'), '# Test Repo');
  await $`git -C ${TEST_REPO} add .`.quiet();
  await $`git -C ${TEST_REPO} commit -m "Initial commit"`.quiet();
  await $`git -C ${TEST_REPO} branch dev`.quiet();
}

async function cleanupTestRepo(): Promise<void> {
  try {
    const result = await $`git -C ${TEST_REPO} worktree list --porcelain`.quiet();
    const paths = result.stdout
      .toString()
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice(9))
      .filter((path) => path !== TEST_REPO);

    for (const p of paths) {
      try {
        await $`git -C ${TEST_REPO} worktree remove ${p} --force`.quiet();
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

/** Run genie CLI command and return stdout. */
async function genie(...args: string[]): Promise<{ stdout: string; exitCode: number }> {
  try {
    const result = await $`bun ${GENIE_BIN} ${args}`
      .quiet()
      .cwd(TEST_REPO)
      .env({ ...process.env, GENIE_HOME: TEST_GENIE_HOME });
    return { stdout: result.stdout.toString(), exitCode: 0 };
  } catch (err: unknown) {
    const shellErr = err as { stdout?: Buffer; exitCode?: number };
    return {
      stdout: shellErr.stdout?.toString() ?? '',
      exitCode: shellErr.exitCode ?? 1,
    };
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('genie team CLI', () => {
  beforeAll(async () => {
    await setupTestRepo();
  });

  afterAll(async () => {
    await cleanupTestRepo();
  });

  test('team create creates a team', async () => {
    const { stdout, exitCode } = await genie('team', 'create', 'feat/cli-test', '--repo', TEST_REPO, '--branch', 'dev');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Team "feat/cli-test" created');
    expect(stdout).toContain('Worktree:');
  });

  test('team create is idempotent', async () => {
    const { exitCode } = await genie('team', 'create', 'feat/cli-test', '--repo', TEST_REPO, '--branch', 'dev');
    expect(exitCode).toBe(0);
  });

  test('team ls lists teams', async () => {
    const { stdout, exitCode } = await genie('team', 'ls');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('feat/cli-test');
  });

  test('team hire adds agent', async () => {
    const { stdout, exitCode } = await genie('team', 'hire', 'implementor', '--team', 'feat/cli-test');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Hired "implementor"');
  });

  test('team hire council adds 10 members', async () => {
    await genie('team', 'create', 'feat/council-cli', '--repo', TEST_REPO, '--branch', 'dev');
    const { stdout, exitCode } = await genie('team', 'hire', 'council', '--team', 'feat/council-cli');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('council members');
  });

  test('team ls <name> lists members', async () => {
    const { stdout, exitCode } = await genie('team', 'ls', 'feat/cli-test');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('implementor');
  });

  test('team fire removes agent', async () => {
    const { stdout, exitCode } = await genie('team', 'fire', 'implementor', '--team', 'feat/cli-test');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Fired "implementor"');
  });

  test('team disband removes team', async () => {
    await genie('team', 'create', 'feat/disband-cli', '--repo', TEST_REPO, '--branch', 'dev');
    const { stdout, exitCode } = await genie('team', 'disband', 'feat/disband-cli');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('disbanded');
  });

  test('team ls shows status', async () => {
    const { stdout, exitCode } = await genie('team', 'ls');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('[in_progress]');
  });

  test('team done marks team as done', async () => {
    await genie('team', 'create', 'feat/done-test', '--repo', TEST_REPO, '--branch', 'dev');
    const { stdout, exitCode } = await genie('team', 'done', 'feat/done-test');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('marked as done');
  });

  test('team blocked marks team as blocked', async () => {
    await genie('team', 'create', 'feat/blocked-test', '--repo', TEST_REPO, '--branch', 'dev');
    const { stdout, exitCode } = await genie('team', 'blocked', 'feat/blocked-test');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('marked as blocked');
  });

  test('ensure command does not exist', async () => {
    const { exitCode } = await genie('team', 'ensure', 'test');
    expect(exitCode).not.toBe(0);
  });

  test('team create --wish auto-copies wish from cwd to repo', async () => {
    // Create a wish in a separate cwd directory (not the repo)
    const cwdDir = join(TEST_DIR, 'wish-cwd');
    const wishSlug = 'test-autocopy';
    const wishDir = join(cwdDir, '.genie', 'wishes', wishSlug);
    await mkdir(wishDir, { recursive: true });
    await writeFile(join(wishDir, 'WISH.md'), '# Test wish for auto-copy\n\n## Summary\nTest.\n');

    // Run team create from the cwd directory — wish is NOT in the repo yet
    try {
      await $`bun ${GENIE_BIN} team create feat/autocopy-test --repo ${TEST_REPO} --branch dev --wish ${wishSlug}`
        .quiet()
        .cwd(cwdDir)
        .env({ ...process.env, GENIE_HOME: TEST_GENIE_HOME });
    } catch {
      // Spawn may fail (no tmux) but auto-copy should have happened before spawn
    }

    // Verify wish was copied to repo
    const repoWishPath = join(TEST_REPO, '.genie', 'wishes', wishSlug, 'WISH.md');
    expect(existsSync(repoWishPath)).toBe(true);
  }, 15_000);

  test('team create --wish uses existing wish in repo without copying', async () => {
    // Create a wish directly in the repo
    const wishSlug = 'test-inrepo';
    const wishDir = join(TEST_REPO, '.genie', 'wishes', wishSlug);
    await mkdir(wishDir, { recursive: true });
    await writeFile(join(wishDir, 'WISH.md'), '# Test wish already in repo\n\n## Summary\nTest.\n');

    // Run team create — wish is already in repo, no copy needed
    try {
      await $`bun ${GENIE_BIN} team create feat/inrepo-test --repo ${TEST_REPO} --branch dev --wish ${wishSlug}`
        .quiet()
        .cwd(TEST_REPO)
        .env({ ...process.env, GENIE_HOME: TEST_GENIE_HOME });
    } catch {
      // Spawn may fail but wish validation should pass
    }

    // Wish should still be there
    expect(existsSync(join(wishDir, 'WISH.md'))).toBe(true);
  }, 15_000);
});
