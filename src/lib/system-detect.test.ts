import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCommand } from './system-detect.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('checkCommand deadlines', () => {
  test('a hanging version executable is killed within the configured budget and reported actionably', async () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-command-probe-'));
    roots.push(root);
    const hanging = join(root, 'codex');
    writeFileSync(hanging, '#!/bin/sh\nsleep 5\n');
    chmodSync(hanging, 0o755);

    const started = performance.now();
    const result = await checkCommand('codex', { which: () => hanging, timeoutMs: 30 });
    const elapsed = performance.now() - started;

    expect(result).toMatchObject({ exists: true, path: hanging, timedOut: true });
    expect(result.error).toContain('timed out after 30ms');
    expect(elapsed).toBeLessThan(1_000);
  });

  test('a successful split version is parsed without a second probe', async () => {
    let calls = 0;
    const result = await checkCommand('codex', {
      which: () => '/fixture/codex',
      run: (_path, args, timeoutMs) => {
        calls += 1;
        expect(args).toEqual(['--version']);
        expect(timeoutMs).toBe(3_000);
        return { exitCode: 0, stdout: 'codex-cli 1.2.3\n', stderr: '' };
      },
    });
    expect(calls).toBe(1);
    expect(result.version).toBe('1.2.3');
  });
});
