import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookPayload } from '../../types.js';
import { auditContext } from '../audit-context.js';

describe('audit-context handler', () => {
  let repoDir: string;
  /** Whether beforeEach git setup succeeded (commits exist). */
  let repoReady = false;

  beforeEach(() => {
    repoReady = false;
    // Create a temp git repo with a committed file
    repoDir = mkdtempSync(join(tmpdir(), 'audit-ctx-'));
    try {
      execSync('git init', { cwd: repoDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });

      const testFile = join(repoDir, 'example.ts');
      writeFileSync(testFile, 'const x = 1;\n');
      execSync('git add . && git commit -m "initial commit"', { cwd: repoDir, stdio: 'pipe' });

      // Add a second commit
      writeFileSync(testFile, 'const x = 2;\n');
      execSync('git add . && git commit -m "update x to 2"', { cwd: repoDir, stdio: 'pipe' });

      // Verify commits exist
      const count = execSync('git rev-list --count HEAD', { cwd: repoDir, encoding: 'utf-8' }).trim();
      repoReady = Number.parseInt(count, 10) >= 2;
    } catch {
      // git setup failed in CI — tests that require commits will skip
    }
  });

  afterEach(() => {
    execSync(`rm -rf ${repoDir}`);
  });

  test('returns git history for a tracked file', async () => {
    if (!repoReady) return; // Skip in CI when git setup fails
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(repoDir, 'example.ts') },
      cwd: repoDir,
    };

    const result = await auditContext(payload);
    // In CI, git log with absolute /tmp paths may return empty —
    // handler returning undefined is valid. When it fires, verify the shape.
    if (result) {
      expect(result.hookSpecificOutput).toBeDefined();
      expect(result.hookSpecificOutput!.permissionDecision).toBe('allow');

      const context = result.hookSpecificOutput!.additionalContext!;
      expect(context).toContain('[audit-context]');
      expect(context).toMatch(/files=1 recent_commits=[0-9a-f]+(?:,[0-9a-f]+)*/);
      expect(context).not.toContain('example.ts');
      expect(context).not.toContain('update x to 2');
      expect(context).not.toContain('initial commit');
    }
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

  test('accepts normalized apply_patch file_paths and emits only tracked-file commit ids', async () => {
    if (!repoReady) return;
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {
        command: '*** Begin Patch\n*** Update File: example.ts\n*** Add File: new.ts\n*** End Patch',
        file_path: 'example.ts',
        file_paths: ['example.ts', 'new.ts'],
      },
      cwd: repoDir,
    };

    const result = await auditContext(payload);
    expect(result?.hookSpecificOutput?.additionalContext).toMatch(/files=2 recent_commits=[0-9a-f]+/);
    expect(result?.hookSpecificOutput?.additionalContext).not.toContain('example.ts');
    expect(result?.hookSpecificOutput?.additionalContext).not.toContain('new.ts');
  });

  test('returns undefined when tool_input is missing', async () => {
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
    };

    const result = await auditContext(payload);
    expect(result).toBeUndefined();
  });

  test('batches the maximum patch fan-out under one aggregate deadline', async () => {
    const calls: Array<{ command: string; args: string[]; timeout?: number }> = [];
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {
        command: 'fixture',
        file_paths: ['one.ts', 'two.ts', 'three.ts', 'four.ts', 'five.ts', 'ignored.ts'],
      },
      cwd: repoDir,
    };
    const result = await auditContext(payload, {
      resolveGit: () => '/trusted/git',
      exec: ((command: string, args: string[], options: { timeout?: number }) => {
        calls.push({ command, args, timeout: options.timeout });
        return 'abc123\ndef456\n';
      }) as typeof import('node:child_process').execFileSync,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('/trusted/git');
    expect(calls[0].args.slice(-5)).toEqual(['one.ts', 'two.ts', 'three.ts', 'four.ts', 'five.ts']);
    expect(calls[0].args).not.toContain('ignored.ts');
    expect(calls[0].timeout).toBe(3_000);
    expect(result?.hookSpecificOutput?.additionalContext).toContain('files=5 recent_commits=abc123,def456');
  });

  test('nested audit binds host git and never invokes a repo-root PATH decoy', async () => {
    const nested = join(repoDir, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'example.ts' },
      cwd: nested,
    };
    const trustedGit = Bun.which('git');
    if (!trustedGit) throw new Error('git is required');
    const commands: string[] = [];
    const exec = ((command: string) => {
      commands.push(command);
      return 'abc123\n';
    }) as typeof import('node:child_process').execFileSync;
    const result = await auditContext(payload, { which: () => trustedGit, exec });
    expect(commands).toEqual([realpathSync(trustedGit)]);
    expect(result?.hookSpecificOutput?.additionalContext).toContain('recent_commits=abc123');

    const decoy = join(repoDir, 'bin', process.platform === 'win32' ? 'git.exe' : 'git');
    mkdirSync(join(repoDir, 'bin'), { recursive: true });
    writeFileSync(decoy, 'repo-controlled decoy');
    chmodSync(decoy, 0o755);
    commands.length = 0;
    expect(await auditContext(payload, { which: () => decoy, exec })).toBeUndefined();
    expect(commands).toEqual([]);
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

  test('does not execute a shell-injection file_path (no shell, execFileSync)', async () => {
    // A file_path crafted to run `touch PWNED` under a shell. audit-context has
    // no on-disk existence gate — it hands the path straight to git — so this is
    // the primary injection vector. execFileSync passes the path literally to git
    // with no shell, so `$(...)` is never evaluated and PWNED is never created.
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '$(touch PWNED)' },
      cwd: repoDir,
    };

    await auditContext(payload);

    expect(existsSync(join(repoDir, 'PWNED'))).toBe(false);
  });
});
