import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureCommand, resolveInvocation } from './codex-dogfood-harness.ts';

const roots: string[] = [];

function fixture(): { root: string; binary: string; adapter: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dogfood-harness-')));
  roots.push(root);
  // Stands in for the authenticated candidate: it echoes the exact argv it was
  // handed, so the evidence record can be checked against reality.
  const binary = join(root, 'genie');
  writeFileSync(binary, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*"\n');
  chmodSync(binary, 0o755);
  // Stands in for scripts/run-musl-dogfood.sh: takes the candidate binary as
  // its first positional argument and execs it with the remaining argv.
  const adapter = join(root, 'adapter.sh');
  writeFileSync(adapter, '#!/usr/bin/env bash\nset -eu\ncandidate=$1\nshift\nexec "$candidate" "$@"\n');
  chmodSync(adapter, 0o755);
  return { root, binary, adapter };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe('candidate invocation evidence', () => {
  test('resolveInvocation keeps argv on the candidate and names the adapter vector separately', () => {
    expect(resolveInvocation({ binary: '/bin/genie', args: ['board', '--json'] })).toEqual({
      command: '/bin/genie',
      argv: ['board', '--json'],
      spawnArgv: ['board', '--json'],
    });
    expect(
      resolveInvocation({ binary: '/bin/genie', args: ['board', '--json'], executionAdapter: '/bin/adapter' }),
    ).toEqual({
      command: '/bin/adapter',
      argv: ['board', '--json'],
      adapterArgv: ['/bin/genie', 'board', '--json'],
      spawnArgv: ['/bin/genie', 'board', '--json'],
    });
  });

  test('records the candidate argv unchanged with and without an execution adapter', () => {
    const { root, binary, adapter } = fixture();
    const args = ['task', 'list', '--json'];
    const direct = captureCommand({ root, binary, args, cwd: root, env: { PATH: process.env.PATH ?? '' } });
    expect(direct.exit).toBe(0);
    expect(direct.executable).toBe(binary);
    expect(direct.candidateBinary).toBe(binary);
    expect(direct.argv).toEqual(args);
    expect(direct.adapterArgv).toBeUndefined();
    expect(direct.stdout.trim()).toBe('task list --json');

    const adapted = captureCommand({
      root,
      binary,
      args,
      cwd: root,
      env: { PATH: process.env.PATH ?? '' },
      executionAdapter: adapter,
    });
    expect(adapted.exit).toBe(0);
    // The evidence argv is the candidate's own arguments on BOTH legs: a
    // linux-x64-musl run must be byte-comparable with every other platform.
    expect(adapted.argv).toEqual(args);
    expect(adapted.adapterArgv).toEqual([binary, ...args]);
    expect(adapted.executable).toBe(adapter);
    expect(adapted.candidateBinary).toBe(binary);
    // The candidate really did receive exactly `args` through the adapter.
    expect(adapted.stdout.trim()).toBe('task list --json');
  });
});
