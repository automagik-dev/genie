import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  type MigrationJournalEntry,
  executeMigration,
  hasDirtyWorkingTree,
  isInsideSeparateGitRepo,
  planMigration,
  recalculateInternalSymlinks,
  rollbackMigration,
} from '../lib/migrate.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  const raw = join(tmpdir(), `genie-migrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  // macOS: tmpdir() lives under /var → /private/var symlink; realpath so
  // computed paths match what migrate.ts returns after resolving links.
  testDir = realpathSync(raw);
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/** Create a minimal workspace with .genie/ and agents/ dirs. */
function mkWorkspace(root: string): void {
  mkdirSync(join(root, '.genie'), { recursive: true });
  mkdirSync(join(root, 'agents'), { recursive: true });
}

/** Create an agent directory with AGENTS.md. */
function mkAgent(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'AGENTS.md'), '---\nname: test\n---\n# Agent\n');
}

/** Create a symlink in agents/ pointing to an external directory (relative). */
function mkSymlink(workspaceRoot: string, agentName: string, targetPath: string): string {
  const linkPath = join(workspaceRoot, 'agents', agentName);
  const relTarget = relative(join(workspaceRoot, 'agents'), targetPath);
  symlinkSync(relTarget, linkPath);
  return linkPath;
}

/** Read the migration journal from a workspace. */
function readJournal(workspaceRoot: string): MigrationJournalEntry[] {
  const path = join(workspaceRoot, '.genie', 'migration-journal.json');
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// ─── planMigration ──────────────────────────────────────────────────────────

describe('planMigration()', () => {
  test('finds symlinked agents and returns plans', () => {
    mkWorkspace(testDir);
    const extDir = join(testDir, 'services', 'auth');
    mkAgent(extDir);
    mkSymlink(testDir, 'auth', extDir);

    const plans = planMigration(testDir);

    expect(plans.length).toBe(1);
    expect(plans[0].agent).toBe('auth');
    expect(plans[0].from).toBe(extDir);
    expect(plans[0].to).toBe(join(testDir, 'agents', 'auth'));
  });

  test('skips physical directories (not symlinks)', () => {
    mkWorkspace(testDir);
    // Create a physical agent dir directly in agents/
    mkAgent(join(testDir, 'agents', 'physical'));

    const plans = planMigration(testDir);

    expect(plans).toEqual([]);
  });

  test('returns empty array when no symlinks exist', () => {
    mkWorkspace(testDir);

    const plans = planMigration(testDir);

    expect(plans).toEqual([]);
  });

  test('returns empty array when agents/ does not exist', () => {
    mkdirSync(join(testDir, '.genie'), { recursive: true });
    // No agents/ dir

    const plans = planMigration(testDir);

    expect(plans).toEqual([]);
  });

  test('detects cross-repo risk', () => {
    mkWorkspace(testDir);
    // Create a fake separate git repo
    const externalRepo = join(testDir, 'external-repo');
    mkAgent(join(externalRepo, 'agent-x'));
    mkdirSync(join(externalRepo, '.git'), { recursive: true });
    // Create a .git in the workspace root too
    mkdirSync(join(testDir, '.git'), { recursive: true });

    mkSymlink(testDir, 'agent-x', join(externalRepo, 'agent-x'));

    const plans = planMigration(testDir);

    expect(plans.length).toBe(1);
    expect(plans[0].risks).toContain('Cross-repo agent');
  });
});

// ─── executeMigration ───────────────────────────────────────────────────────

describe('executeMigration()', () => {
  test('converts symlink to physical directory via copy', () => {
    mkWorkspace(testDir);
    const extDir = join(testDir, 'services', 'billing');
    mkAgent(extDir);
    writeFileSync(join(extDir, 'config.json'), '{"key":"value"}');
    mkSymlink(testDir, 'billing', extDir);

    const plans = planMigration(testDir);
    // Force copy method for this test
    const plan = plans.map((p) => ({ ...p, method: 'copy' as const, risks: [] }));
    const result = executeMigration(testDir, plan, { noGit: true });

    expect(result.migrated).toEqual(['billing']);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);

    // Verify the destination is now a physical directory (not a symlink)
    const destPath = join(testDir, 'agents', 'billing');
    expect(existsSync(destPath)).toBe(true);
    expect(lstatSync(destPath).isSymbolicLink()).toBe(false);
    expect(lstatSync(destPath).isDirectory()).toBe(true);

    // Verify files were copied
    expect(existsSync(join(destPath, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(destPath, 'config.json'))).toBe(true);
    expect(readFileSync(join(destPath, 'config.json'), 'utf-8')).toBe('{"key":"value"}');
  });

  test('writes journal entries', () => {
    mkWorkspace(testDir);
    const extDir = join(testDir, 'services', 'auth');
    mkAgent(extDir);
    mkSymlink(testDir, 'auth', extDir);

    const plans = planMigration(testDir);
    const plan = plans.map((p) => ({ ...p, method: 'copy' as const, risks: [] }));
    const result = executeMigration(testDir, plan, { noGit: true });

    expect(result.migrated).toEqual(['auth']);

    const journal = readJournal(testDir);
    expect(journal.length).toBe(1);
    expect(journal[0].agent).toBe('auth');
    expect(journal[0].batchId).toBe(result.batchId);
    expect(journal[0].method).toBe('copy');
    expect(journal[0].from).toBe(extDir);
    expect(journal[0].to).toBe(join(testDir, 'agents', 'auth'));
    // Timestamp is ISO 8601
    expect(new Date(journal[0].timestamp).toISOString()).toBe(journal[0].timestamp);
  });

  test('skips cross-repo agents without force', () => {
    mkWorkspace(testDir);
    const externalRepo = join(testDir, 'external-repo');
    mkAgent(join(externalRepo, 'agent-x'));
    mkdirSync(join(externalRepo, '.git'), { recursive: true });
    mkdirSync(join(testDir, '.git'), { recursive: true });
    mkSymlink(testDir, 'agent-x', join(externalRepo, 'agent-x'));

    const plans = planMigration(testDir);
    expect(plans[0].risks).toContain('Cross-repo agent');

    const result = executeMigration(testDir, plans, { noGit: true });

    expect(result.skipped).toEqual(['agent-x']);
    expect(result.migrated).toEqual([]);
    // Symlink should still exist
    expect(lstatSync(join(testDir, 'agents', 'agent-x')).isSymbolicLink()).toBe(true);
  });

  test('migrates cross-repo agents with force', () => {
    mkWorkspace(testDir);
    const externalRepo = join(testDir, 'external-repo');
    mkAgent(join(externalRepo, 'agent-x'));
    mkdirSync(join(externalRepo, '.git'), { recursive: true });
    mkdirSync(join(testDir, '.git'), { recursive: true });
    mkSymlink(testDir, 'agent-x', join(externalRepo, 'agent-x'));

    const plans = planMigration(testDir);
    const result = executeMigration(testDir, plans, { force: true, noGit: true });

    expect(result.migrated).toEqual(['agent-x']);
    expect(result.skipped).toEqual([]);
    expect(lstatSync(join(testDir, 'agents', 'agent-x')).isDirectory()).toBe(true);
    expect(lstatSync(join(testDir, 'agents', 'agent-x')).isSymbolicLink()).toBe(false);
  });

  test('aborts on dirty source repos', () => {
    mkWorkspace(testDir);
    const extDir = join(testDir, 'services', 'dirty');
    mkAgent(extDir);
    mkSymlink(testDir, 'dirty', extDir);

    // Create plan with "Uncommitted changes" risk manually
    const plan = [
      {
        agent: 'dirty',
        from: extDir,
        to: join(testDir, 'agents', 'dirty'),
        method: 'copy' as const,
        risks: ['Uncommitted changes'],
      },
    ];

    const result = executeMigration(testDir, plan, { noGit: true });

    expect(result.errors.length).toBe(1);
    expect(result.errors[0].agent).toBe('dirty');
    expect(result.errors[0].error).toContain('Uncommitted changes');
    expect(result.migrated).toEqual([]);
    // Symlink should still exist
    expect(lstatSync(join(testDir, 'agents', 'dirty')).isSymbolicLink()).toBe(true);
  });

  test('recalculates internal relative symlinks', () => {
    mkWorkspace(testDir);
    // Create an agent with an internal relative symlink
    const extDir = join(testDir, 'services', 'linked');
    mkAgent(extDir);

    // Create a shared dir and a symlink from the agent to it
    const sharedDir = join(testDir, 'services', 'shared');
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(join(sharedDir, 'utils.ts'), 'export const x = 1;');
    // Relative symlink: services/linked/shared-link -> ../shared
    symlinkSync('../shared', join(extDir, 'shared-link'));

    mkSymlink(testDir, 'linked', extDir);

    const plans = planMigration(testDir);
    const plan = plans.map((p) => ({ ...p, method: 'copy' as const, risks: [] }));
    const result = executeMigration(testDir, plan, { noGit: true });

    expect(result.migrated).toEqual(['linked']);

    // The internal symlink should be recalculated
    const newSharedLink = join(testDir, 'agents', 'linked', 'shared-link');
    expect(existsSync(newSharedLink)).toBe(true);
    expect(lstatSync(newSharedLink).isSymbolicLink()).toBe(true);
    // The target should resolve to the same shared dir
    const linkTarget = readlinkSync(newSharedLink);
    // From agents/linked/shared-link, the relative path to services/shared is ../../services/shared
    expect(linkTarget).toBe('../../services/shared');
  });
});

// ─── rollbackMigration ──────────────────────────────────────────────────────

describe('rollbackMigration()', () => {
  test('reverses moves from journal', () => {
    mkWorkspace(testDir);
    const extDir = join(testDir, 'services', 'auth');
    mkAgent(extDir);
    mkSymlink(testDir, 'auth', extDir);

    // Execute migration first
    const plans = planMigration(testDir);
    const plan = plans.map((p) => ({ ...p, method: 'copy' as const, risks: [] }));
    const migrateResult = executeMigration(testDir, plan, { noGit: true });
    expect(migrateResult.migrated).toEqual(['auth']);

    // Verify it's a physical dir now
    expect(lstatSync(join(testDir, 'agents', 'auth')).isSymbolicLink()).toBe(false);

    // Source was removed during migration
    expect(existsSync(extDir)).toBe(false);

    // Rollback
    const rollbackResult = rollbackMigration(testDir);

    expect(rollbackResult.rolledBack).toEqual(['auth']);
    expect(rollbackResult.errors).toEqual([]);

    // Source should be restored
    expect(existsSync(extDir)).toBe(true);
    expect(existsSync(join(extDir, 'AGENTS.md'))).toBe(true);

    // agents/auth should be a symlink again
    expect(lstatSync(join(testDir, 'agents', 'auth')).isSymbolicLink()).toBe(true);
    // Relative symlink
    const linkTarget = readlinkSync(join(testDir, 'agents', 'auth'));
    expect(linkTarget).toBe('../services/auth');

    // Journal should be empty after rollback
    const journal = readJournal(testDir);
    expect(journal).toEqual([]);
  });

  test('returns empty result when journal is empty', () => {
    mkWorkspace(testDir);

    const result = rollbackMigration(testDir);

    expect(result.rolledBack).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test('only rolls back the most recent batch', () => {
    mkWorkspace(testDir);

    // Write a fake journal with two batches
    const journalEntries: MigrationJournalEntry[] = [
      {
        agent: 'old-agent',
        from: '/tmp/old',
        to: '/tmp/old-dest',
        timestamp: '2025-01-01T00:00:00.000Z',
        method: 'copy',
        batchId: 'batch-old',
      },
      {
        agent: 'new-agent',
        from: join(testDir, 'services', 'new'),
        to: join(testDir, 'agents', 'new'),
        timestamp: '2025-06-01T00:00:00.000Z',
        method: 'copy',
        batchId: 'batch-new',
      },
    ];
    writeFileSync(join(testDir, '.genie', 'migration-journal.json'), JSON.stringify(journalEntries));

    // Create the physical dir that would be rolled back
    mkAgent(join(testDir, 'agents', 'new'));

    const result = rollbackMigration(testDir);

    expect(result.rolledBack).toEqual(['new-agent']);

    // Old batch should remain in journal
    const remaining = readJournal(testDir);
    expect(remaining.length).toBe(1);
    expect(remaining[0].batchId).toBe('batch-old');
  });
});

// ─── recalculateInternalSymlinks ────────────────────────────────────────────

describe('recalculateInternalSymlinks()', () => {
  test('fixes relative symlinks when directory moves', () => {
    // Setup: dir at "old/" contains a symlink "link" -> "../target"
    const oldDir = join(testDir, 'old');
    const newDir = join(testDir, 'new', 'nested');
    const targetDir = join(testDir, 'target');

    mkdirSync(oldDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'file.txt'), 'content');

    // Create a relative symlink in oldDir
    symlinkSync('../target', join(oldDir, 'link'));

    // Verify the old symlink works
    expect(existsSync(join(oldDir, 'link', 'file.txt'))).toBe(true);

    // "Move" oldDir to newDir by manual copy that preserves symlinks
    mkdirSync(newDir, { recursive: true });
    // Manually copy: file + symlink
    writeFileSync(join(newDir, 'placeholder'), ''); // ensure dir exists
    rmSync(join(newDir, 'placeholder'));
    for (const entry of readdirSync(oldDir)) {
      const srcPath = join(oldDir, entry);
      const destPath = join(newDir, entry);
      const stat = lstatSync(srcPath);
      if (stat.isSymbolicLink()) {
        symlinkSync(readlinkSync(srcPath), destPath);
      } else {
        writeFileSync(destPath, readFileSync(srcPath));
      }
    }

    // The symlink in newDir is now broken (../target doesn't exist from new/nested/)
    // Recalculate
    recalculateInternalSymlinks(newDir, oldDir, newDir);

    // The symlink should now point to ../../target (from new/nested/ to target/)
    const newLinkTarget = readlinkSync(join(newDir, 'link'));
    expect(newLinkTarget).toBe('../../target');
    expect(existsSync(join(newDir, 'link', 'file.txt'))).toBe(true);
  });

  test('leaves absolute symlinks unchanged', () => {
    const dir = join(testDir, 'mydir');
    const absTarget = join(testDir, 'abs-target');
    mkdirSync(dir, { recursive: true });
    mkdirSync(absTarget, { recursive: true });

    symlinkSync(absTarget, join(dir, 'abs-link'));

    recalculateInternalSymlinks(dir, dir, dir);

    expect(readlinkSync(join(dir, 'abs-link'))).toBe(absTarget);
  });
});

// ─── isInsideSeparateGitRepo ────────────────────────────────────────────────

describe('isInsideSeparateGitRepo()', () => {
  test('returns true when path is in a different git repo', () => {
    // Workspace git root
    mkdirSync(join(testDir, '.git'), { recursive: true });
    // External git root
    const externalRoot = join(testDir, 'external');
    mkdirSync(join(externalRoot, '.git'), { recursive: true });
    const agentDir = join(externalRoot, 'agents', 'bot');
    mkdirSync(agentDir, { recursive: true });

    expect(isInsideSeparateGitRepo(agentDir, testDir)).toBe(true);
  });

  test('returns false when path is in the same git repo', () => {
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const agentDir = join(testDir, 'services', 'auth');
    mkdirSync(agentDir, { recursive: true });

    expect(isInsideSeparateGitRepo(agentDir, testDir)).toBe(false);
  });

  test('returns false when no .git directory exists', () => {
    const agentDir = join(testDir, 'services', 'auth');
    mkdirSync(agentDir, { recursive: true });

    expect(isInsideSeparateGitRepo(agentDir, testDir)).toBe(false);
  });
});

// ─── hasDirtyWorkingTree ────────────────────────────────────────────────────

describe('hasDirtyWorkingTree()', () => {
  test('returns false for non-git directory', () => {
    const dir = join(testDir, 'not-a-repo');
    mkdirSync(dir, { recursive: true });

    expect(hasDirtyWorkingTree(dir)).toBe(false);
  });

  test('returns false for clean git repo', () => {
    const dir = join(testDir, 'clean-repo');
    mkdirSync(dir, { recursive: true });

    // Initialize a real git repo
    const { execSync } = require('node:child_process');
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
    writeFileSync(join(dir, 'file.txt'), 'content');
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    expect(hasDirtyWorkingTree(dir)).toBe(false);
  });

  test('returns true for dirty git repo', () => {
    const dir = join(testDir, 'dirty-repo');
    mkdirSync(dir, { recursive: true });

    const { execSync } = require('node:child_process');
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
    writeFileSync(join(dir, 'file.txt'), 'content');
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    // Make it dirty
    writeFileSync(join(dir, 'dirty.txt'), 'uncommitted');

    expect(hasDirtyWorkingTree(dir)).toBe(true);
  });
});
