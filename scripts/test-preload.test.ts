import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

describe('the test preload makes the suite hermetic to inherited colour policy', () => {
  test('a runner started with FORCE_COLOR=3 hands its tests an environment without it', () => {
    // A child `bun test` inherits the harness value; the preload must strip it before any test runs.
    const probe = spawnSync(
      process.execPath,
      ['test', './scripts/test-preload.test.ts', '-t', 'probe: FORCE_COLOR is absent'],
      // A synchronous spawn cannot be interrupted by the test timer, so it carries its own bound.
      { cwd: ROOT, env: { ...process.env, FORCE_COLOR: '3' }, encoding: 'utf8', timeout: 60_000 },
    );
    expect(`${probe.stdout}${probe.stderr}`).toContain('1 pass');
    expect(probe.status).toBe(0);
  });

  test('probe: FORCE_COLOR is absent', () => {
    expect(process.env.FORCE_COLOR).toBeUndefined();
  });
});
