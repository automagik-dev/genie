import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'release-immutability.sh');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(mode: string, state: { immutable?: unknown; fail?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'genie-release-immutability-'));
  roots.push(root);
  const statePath = join(root, 'state.json');
  writeFileSync(statePath, JSON.stringify(state));
  const gh = join(root, 'gh');
  writeFileSync(
    gh,
    `#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
const state = JSON.parse(readFileSync(process.env.GH_FAKE_STATE, 'utf8'));
if (state.fail) process.exit(42);
console.log(JSON.stringify({ immutable: state.immutable }));
`,
  );
  chmodSync(gh, 0o755);
  const result = Bun.spawnSync(['bash', SCRIPT, mode], {
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH ?? ''}`,
      GH_FAKE_STATE: statePath,
      RELEASE_REPOSITORY: 'automagik-dev/genie',
      VERSION: '5.260714.3',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result;
}

describe('immutable release publication gate', () => {
  test('requires the exact published release object to be immutable before manifests', () => {
    expect(run('release', { immutable: true }).exitCode).toBe(0);
    const mutable = run('release', { immutable: false });
    expect(mutable.exitCode).toBe(3);
    expect(mutable.stderr.toString()).toContain('refusing to advance channel manifests');
  });

  test('propagates GitHub API failures', () => {
    expect(run('release', { fail: true }).exitCode).toBe(42);
  });

  test('does not assume GITHUB_TOKEN can read repository Administration settings', () => {
    expect(readFileSync(SCRIPT, 'utf8')).not.toContain('/immutable-releases');
    const unsupported = run('repository', { immutable: true });
    expect(unsupported.exitCode).toBe(64);
  });
});
