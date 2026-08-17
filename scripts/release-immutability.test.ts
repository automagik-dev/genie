import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'release-immutability.sh');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(mode: string, state: { immutable?: unknown; fail?: boolean; failTimes?: number; calls?: number }) {
  const root = mkdtempSync(join(tmpdir(), 'genie-release-immutability-'));
  roots.push(root);
  const statePath = join(root, 'state.json');
  writeFileSync(statePath, JSON.stringify(state));
  const gh = join(root, 'gh');
  writeFileSync(
    gh,
    `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
const state = JSON.parse(readFileSync(process.env.GH_FAKE_STATE, 'utf8'));
state.calls = (state.calls ?? 0) + 1;
writeFileSync(process.env.GH_FAKE_STATE, JSON.stringify(state));
if (state.failTimes && state.calls <= state.failTimes) {
  console.error('gh: Internal Server Error (HTTP 502)');
  process.exit(1);
}
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
      GH_RETRY_SLEEPS: '0 0 0 0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    result,
    state: JSON.parse(readFileSync(statePath, 'utf8')) as { calls?: number },
  };
}

describe('immutable release publication gate', () => {
  test('requires the exact published release object to be immutable before manifests', () => {
    expect(run('release', { immutable: true }).result.exitCode).toBe(0);
    const mutable = run('release', { immutable: false });
    expect(mutable.result.exitCode).toBe(3);
    expect(mutable.result.stderr.toString()).toContain('refusing to advance channel manifests');
    // immutable=false is a policy failure on a successful response — it is
    // never retried.
    expect(mutable.state.calls).toBe(1);
  });

  test('propagates GitHub API failures', () => {
    // Unknown-class failures (empty stderr) are not retried — this pins both
    // the verbatim exit-code passthrough and the default-closed classification.
    const failed = run('release', { fail: true });
    expect(failed.result.exitCode).toBe(42);
    expect(failed.state.calls).toBe(1);
  });

  test('rides out transient API failures before the immutability check', () => {
    const flaky = run('release', { immutable: true, failTimes: 2 });
    expect(flaky.result.exitCode).toBe(0);
    expect(flaky.state.calls).toBe(3);
  });

  test('does not assume GITHUB_TOKEN can read repository Administration settings', () => {
    expect(readFileSync(SCRIPT, 'utf8')).not.toContain('/immutable-releases');
    const unsupported = run('repository', { immutable: true });
    expect(unsupported.result.exitCode).toBe(64);
  });
});
