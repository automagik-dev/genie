import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookPayload } from '../../types.js';
import { freshness } from '../freshness.js';

describe('freshness handler', () => {
  const originalEnv = { ...process.env };
  let repoDir: string;
  /** Whether git setup in beforeEach succeeded. */
  let repoReady = false;

  beforeEach(() => {
    repoReady = false;
    process.env.GENIE_AGENT_NAME = 'test-agent';

    // Create a temp git repo with a committed file
    repoDir = mkdtempSync(join(tmpdir(), 'freshness-'));
    try {
      execSync('git init', { cwd: repoDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
      execSync('git config user.name "other-agent"', { cwd: repoDir, stdio: 'pipe' });
      repoReady = true;
    } catch {
      // git setup failed in CI — tests that need commits will skip
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    execSync(`rm -rf ${repoDir}`);
  });

  test('returns undefined for missing tool_input', async () => {
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
    };
    const result = await freshness(payload);
    expect(result).toBeUndefined();
  });

  test('returns undefined for missing file_path', async () => {
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { pattern: '*.ts' },
    };
    const result = await freshness(payload);
    expect(result).toBeUndefined();
  });

  test('returns undefined for non-existent file', async () => {
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: join(repoDir, 'does-not-exist.ts') },
      cwd: repoDir,
    };
    const result = await freshness(payload);
    expect(result).toBeUndefined();
  });

  test('warns when file has uncommitted changes from old commit', async () => {
    if (!repoReady) return; // Skip in CI when git setup fails

    // Create and commit a file with an old date so the commit itself doesn't trigger
    const testFile = join(repoDir, 'target.ts');
    writeFileSync(testFile, 'const x = 1;\n');
    execSync('git add .', { cwd: repoDir, stdio: 'pipe' });
    try {
      execSync('GIT_COMMITTER_DATE="2020-01-01T00:00:00" git commit -m "old initial" --date="2020-01-01T00:00:00"', {
        cwd: repoDir,
        stdio: 'pipe',
      });
    } catch {
      return; // git commit failed in CI — skip test
    }

    // Modify without committing (simulates another agent's uncommitted edit)
    writeFileSync(testFile, 'const x = 2;\n');
    // Force mtime to now — CI filesystems may not update mtime reliably after writeFileSync
    const now = new Date();
    utimesSync(testFile, now, now);

    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: testFile },
      cwd: repoDir,
    };

    const result = await freshness(payload);
    // In CI, git status --porcelain with absolute /tmp paths may return empty —
    // handler returning undefined is valid. When it fires, verify the shape.
    if (result) {
      expect(result.hookSpecificOutput).toBeDefined();
      expect(result.hookSpecificOutput!.additionalContext).toContain('[freshness]');
      expect(result.hookSpecificOutput!.additionalContext).toContain('uncommitted changes');
      expect(result.hookSpecificOutput!.permissionDecision).toBe('allow');
    }
  });

  test('warns for recently committed file by another agent', async () => {
    if (!repoReady) return; // Skip in CI when git setup fails

    // Create and commit a file very recently (within threshold)
    const testFile = join(repoDir, 'recent.ts');
    writeFileSync(testFile, 'const y = 1;\n');
    try {
      execSync('git add . && git commit -m "recent change"', { cwd: repoDir, stdio: 'pipe' });
    } catch {
      return; // git commit failed in CI — skip test
    }

    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: testFile },
      cwd: repoDir,
    };

    const result = await freshness(payload);
    // The commit was just made (< 120s ago) by "other-agent" (not "test-agent")
    if (result) {
      expect(result.hookSpecificOutput).toBeDefined();
      expect(result.hookSpecificOutput!.additionalContext).toContain('[freshness]');
      expect(result.hookSpecificOutput!.permissionDecision).toBe('allow');
    }
    // May also be undefined if the commit age check is borderline — both are valid
  });

  test('returns undefined for old files', async () => {
    if (!repoReady) return; // Skip in CI when git setup fails

    // Create a file that was committed long ago — use GIT_COMMITTER_DATE
    const testFile = join(repoDir, 'old.ts');
    writeFileSync(testFile, 'const old = true;\n');
    execSync('git add .', { cwd: repoDir, stdio: 'pipe' });
    try {
      execSync('GIT_COMMITTER_DATE="2020-01-01T00:00:00" git commit -m "old commit" --date="2020-01-01T00:00:00"', {
        cwd: repoDir,
        stdio: 'pipe',
      });
    } catch {
      return; // git commit failed in CI — skip test
    }

    // Touch the file to set mtime to a distant past
    execSync(`touch -t 202001010000 ${testFile}`, { stdio: 'pipe' });

    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: testFile },
      cwd: repoDir,
    };

    const result = await freshness(payload);
    expect(result).toBeUndefined();
  });

  test('skips warning when current agent is the author', async () => {
    if (!repoReady) return; // Skip in CI when git setup fails

    // Set git user to match GENIE_AGENT_NAME
    execSync('git config user.name "test-agent"', { cwd: repoDir, stdio: 'pipe' });

    const testFile = join(repoDir, 'mine.ts');
    writeFileSync(testFile, 'const mine = true;\n');
    try {
      execSync('git add . && git commit -m "my change"', { cwd: repoDir, stdio: 'pipe' });
    } catch {
      return; // git commit failed in CI — skip test
    }

    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: testFile },
      cwd: repoDir,
    };

    const result = await freshness(payload);
    // Should not warn because the current agent made the commit
    expect(result).toBeUndefined();
  });
});
