import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookPayload } from '../../types.js';
import { auditContext } from '../audit-context.js';

describe('audit-context handler', () => {
  let repoDir: string;

  beforeEach(() => {
    // Create a temp git repo with a committed file
    repoDir = mkdtempSync(join(tmpdir(), 'audit-ctx-'));
    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });

    const testFile = join(repoDir, 'example.ts');
    writeFileSync(testFile, 'const x = 1;\n');
    execSync('git add . && git commit -m "initial commit"', { cwd: repoDir, stdio: 'pipe' });

    // Add a second commit
    writeFileSync(testFile, 'const x = 2;\n');
    execSync('git add . && git commit -m "update x to 2"', { cwd: repoDir, stdio: 'pipe' });
  });

  afterEach(() => {
    execSync(`rm -rf ${repoDir}`);
  });

  test('returns git history for a tracked file', async () => {
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(repoDir, 'example.ts') },
      cwd: repoDir,
    };

    const result = await auditContext(payload);
    expect(result).toBeDefined();
    expect(result!.hookSpecificOutput).toBeDefined();
    expect(result!.hookSpecificOutput!.permissionDecision).toBe('allow');

    const context = result!.hookSpecificOutput!.additionalContext!;
    expect(context).toContain('[audit-context]');
    expect(context).toContain('example.ts');
    expect(context).toContain('update x to 2');
    expect(context).toContain('initial commit');
  });

  test('returns undefined for untracked file', async () => {
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(repoDir, 'new-file.ts') },
      cwd: repoDir,
    };

    const result = await auditContext(payload);
    expect(result).toBeUndefined();
  });

  test('returns undefined when no file_path in input', async () => {
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { content: 'hello' },
      cwd: repoDir,
    };

    const result = await auditContext(payload);
    expect(result).toBeUndefined();
  });

  test('returns undefined when tool_input is missing', async () => {
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
    };

    const result = await auditContext(payload);
    expect(result).toBeUndefined();
  });

  test('returns undefined for non-git directory', async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'audit-nongit-'));
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(nonGitDir, 'test.ts') },
      cwd: nonGitDir,
    };

    const result = await auditContext(payload);
    expect(result).toBeUndefined();
    execSync(`rm -rf ${nonGitDir}`);
  });
});
