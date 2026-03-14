/**
 * Tests for Team CLI commands.
 * Run with: bun test src/term-commands/team.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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

  test('ensure command does not exist', async () => {
    const { exitCode } = await genie('team', 'ensure', 'test');
    expect(exitCode).not.toBe(0);
  });
});
