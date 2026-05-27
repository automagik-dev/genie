/**
 * Unit tests for tmux-launch-script.ts
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeTmuxLaunchScript } from '../tmux-launch-script.js';

const SPAWN_DIR = join(homedir(), '.genie', 'spawn-scripts');

describe('writeTmuxLaunchScript', () => {
  beforeEach(() => {
    // Clean up any leftover test scripts
    try {
      const files = require('node:fs').readdirSync(SPAWN_DIR);
      for (const f of files) {
        if (f.startsWith('test-') || f.startsWith('omni-')) {
          rmSync(join(SPAWN_DIR, f));
        }
      }
    } catch {
      // dir may not exist yet
    }
  });

  test('creates a script with shebang and exec command', () => {
    const path = writeTmuxLaunchScript('test-worker', 'echo hello');
    expect(existsSync(path)).toBe(true);

    const content = readFileSync(path, 'utf-8');
    expect(content).toStartWith('#!/bin/sh\n');
    expect(content).toInclude('exec echo hello\n');
  });

  test('rewrites --resume <id> to --session-id <id>', () => {
    const cmd = "claude --resume 'sess-uuid-789' --dangerously-skip-permissions";
    const path = writeTmuxLaunchScript('test-worker', cmd);
    const content = readFileSync(path, 'utf-8');
    expect(content).toInclude("exec claude --session-id 'sess-uuid-789' --dangerously-skip-permissions\n");
    expect(content).not.toInclude('--resume');
  });

  test('sanitizes workerId in filename', () => {
    const path = writeTmuxLaunchScript('worker/with:bad@chars', 'echo hello');
    const basename = path.split('/').pop()!;
    expect(basename).toMatch(/^worker-with-bad-chars-/);
    expect(basename).toEndWith('.sh');
  });

  test('creates script in ~/.genie/spawn-scripts', () => {
    const path = writeTmuxLaunchScript('test-worker', 'echo hello');
    expect(path).toStartWith(SPAWN_DIR);
  });

  test('sets executable permissions', () => {
    const path = writeTmuxLaunchScript('test-worker', 'echo hello');
    const stats = require('node:fs').statSync(path);
    // Check owner-execute bit
    expect(stats.mode & 0o100).toBe(0o100);
  });

  test('preserves complex commands with quotes and backticks', () => {
    const cmd = `OMNI_API_KEY='sk-123' claude --permission-mode 'auto' --system-prompt 'Use \`git\` (👍) for (instance: x)'`;
    const path = writeTmuxLaunchScript('omni-chat-123', cmd);
    const content = readFileSync(path, 'utf-8');
    expect(content).toInclude(`exec ${cmd}\n`);
  });
});
