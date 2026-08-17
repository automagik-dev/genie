import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HELPER = join(import.meta.dir, 'gh-retry.sh');
const roots: string[] = [];

interface ScriptedResponse {
  exit?: number;
  stdout?: string;
  stderr?: string;
}

interface FakeGhState {
  responses?: ScriptedResponse[];
  calls?: string[][];
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Runs one helper function against a fake `gh` that replays a scripted queue
// of {exit, stdout, stderr} responses in call order.
function run(fn: string, fnArgs: string[], responses: ScriptedResponse[], overrides: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'genie-gh-retry-'));
  roots.push(root);
  const statePath = join(root, 'state.json');
  const ghPath = join(root, 'gh');
  writeFileSync(statePath, JSON.stringify({ responses }));
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
const path = process.env.GH_FAKE_STATE;
const state = JSON.parse(readFileSync(path, 'utf8'));
const args = process.argv.slice(2);
state.calls ??= [];
state.calls.push(args);
const response = state.responses?.length ? state.responses.shift() : { exit: 0 };
writeFileSync(path, JSON.stringify(state));
if (response.stdout) console.log(response.stdout);
if (response.stderr) console.error(response.stderr);
process.exit(response.exit ?? 0);
`,
  );
  chmodSync(ghPath, 0o755);
  const result = Bun.spawnSync(['bash', '-c', 'source "$0" && "$@"', HELPER, fn, ...fnArgs], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH ?? ''}`,
      GH_FAKE_STATE: statePath,
      GH_RETRY_SLEEPS: '0 0 0 0',
      GH_RETRY_LOOKUP_LAG_SLEEP: '0',
      ...overrides,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    result,
    root,
    state: JSON.parse(readFileSync(statePath, 'utf8')) as FakeGhState,
  };
}

const REPO = 'automagik-dev/genie';
const releaseJson = (id: number, tag = 'v1.2.3') => JSON.stringify({ id, tag_name: tag, draft: true, body: '' });

describe('gh_retry', () => {
  test('retries transient failures and emits only the successful stdout', () => {
    const { result, state } = run(
      'gh_retry',
      ['gh', 'api', 'repos/x/y'],
      [
        { exit: 1, stderr: 'gh: Internal Server Error (HTTP 502)' },
        { exit: 1, stderr: 'gh: Service Unavailable' },
        { exit: 0, stdout: 'payload' },
      ],
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('payload\n');
    expect(state.calls).toHaveLength(3);
  });

  test('never retries permission failures', () => {
    const { result, state } = run(
      'gh_retry',
      ['gh', 'api', 'repos/x/y'],
      [{ exit: 1, stderr: 'gh: HTTP 403 Forbidden' }],
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('403');
    expect(state.calls).toHaveLength(1);
  });

  test('unknown failures (empty stderr) pass through untouched without retry', () => {
    // Default-closed: never blind-retry a mutation against ambiguous state,
    // and preserve caller exit-code passthrough semantics.
    const { result, state } = run('gh_retry', ['gh', 'api', 'repos/x/y'], [{ exit: 42 }]);
    expect(result.exitCode).toBe(42);
    expect(state.calls).toHaveLength(1);
  });

  test('exhaustion preserves the final exit code and stderr', () => {
    const responses = Array.from({ length: 5 }, () => ({ exit: 7, stderr: 'gh: HTTP 502 Bad Gateway' }));
    const { result, state } = run('gh_retry', ['gh', 'api', 'repos/x/y'], responses);
    expect(result.exitCode).toBe(7);
    expect(result.stderr.toString()).toContain('502');
    expect(state.calls).toHaveLength(5);
  });

  test('not-found is retried only under --not-found-transient', () => {
    const closed = run('gh_retry', ['gh', 'api', 'repos/x/y'], [{ exit: 1, stderr: 'release not found' }]);
    expect(closed.result.exitCode).toBe(1);
    expect(closed.state.calls).toHaveLength(1);

    const lag = run(
      'gh_retry',
      ['--not-found-transient', 'gh', 'api', 'repos/x/y'],
      [
        { exit: 1, stderr: 'release not found' },
        { exit: 1, stderr: 'gh: Not Found (HTTP 404)' },
        { exit: 0, stdout: 'found' },
      ],
    );
    expect(lag.result.exitCode).toBe(0);
    expect(lag.result.stdout.toString()).toBe('found\n');
    expect(lag.state.calls).toHaveLength(3);
  });
});

describe('gh_release_lookup', () => {
  test('published release resolves via the tag ref', () => {
    const { result } = run('gh_release_lookup', [REPO, 'v1.2.3'], [{ exit: 0, stdout: releaseJson(55) }]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).id).toBe(55);
  });

  test('draft resolves through the listing and is confirmed by id', () => {
    const { result, state } = run(
      'gh_release_lookup',
      [REPO, 'v1.2.3'],
      [
        { exit: 1, stderr: 'gh: Not Found (HTTP 404)' },
        { exit: 0, stdout: '77' },
        { exit: 0, stdout: releaseJson(77) },
      ],
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).id).toBe(77);
    expect(state.calls?.[2]?.join(' ')).toContain(`repos/${REPO}/releases/77`);
  });

  test('definitive 404 with an empty listing is definitively absent (rc 4)', () => {
    const { result } = run(
      'gh_release_lookup',
      [REPO, 'v1.2.3'],
      [
        { exit: 1, stderr: 'gh: Not Found (HTTP 404)' },
        { exit: 0, stdout: '' },
      ],
    );
    expect(result.exitCode).toBe(4);
  });

  test('transient exhaustion is unknown (rc 3), never "not found"', () => {
    const responses = Array.from({ length: 5 }, () => ({ exit: 1, stderr: 'gh: HTTP 500' }));
    const { result } = run('gh_release_lookup', [REPO, 'v1.2.3'], responses);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('could not determine whether release');
  });

  test('duplicate drafts with the same tag are ambiguous (rc 3)', () => {
    const { result } = run(
      'gh_release_lookup',
      [REPO, 'v1.2.3'],
      [
        { exit: 1, stderr: 'gh: Not Found (HTTP 404)' },
        { exit: 0, stdout: '77\n78' },
      ],
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('multiple draft releases');
  });

  test('--expect-exists rides out listing read-after-write lag', () => {
    const { result } = run(
      'gh_release_lookup',
      ['--expect-exists', REPO, 'v1.2.3'],
      [
        { exit: 1, stderr: 'gh: Not Found (HTTP 404)' },
        { exit: 0, stdout: '' },
        { exit: 1, stderr: 'gh: Not Found (HTTP 404)' },
        { exit: 0, stdout: '' },
        { exit: 1, stderr: 'gh: Not Found (HTTP 404)' },
        { exit: 0, stdout: '77' },
        { exit: 0, stdout: releaseJson(77) },
      ],
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).id).toBe(77);
  });

  test('rejects invalid repository or tag inputs', () => {
    expect(run('gh_release_lookup', ['not-a-repo', 'v1.2.3'], []).result.exitCode).toBe(2);
    expect(run('gh_release_lookup', [REPO, 'v1;rm -rf'], []).result.exitCode).toBe(2);
  });
});

describe('gh_upload_release_asset / gh_download_release_asset', () => {
  test('already_exists surfaces as rc 6 after a single attempt', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-gh-retry-asset-'));
    roots.push(root);
    const asset = join(root, 'genie-1.2.3-linux-x64.tar.gz');
    writeFileSync(asset, 'bytes');
    const { result, state } = run(
      'gh_upload_release_asset',
      [REPO, '55', asset],
      [{ exit: 1, stderr: 'HTTP 422: Validation Failed (already_exists)' }],
    );
    expect(result.exitCode).toBe(6);
    expect(state.calls).toHaveLength(1);
  });

  test('refuses unsafe asset names and non-numeric ids without calling gh', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-gh-retry-asset-'));
    roots.push(root);
    const weird = join(root, 'weird name!.tar.gz');
    writeFileSync(weird, 'bytes');
    const badName = run('gh_upload_release_asset', [REPO, '55', weird], []);
    expect(badName.result.exitCode).toBe(2);
    expect(badName.state.calls ?? []).toHaveLength(0);

    const badId = run('gh_download_release_asset', [REPO, 'abc', join(root, 'out')], []);
    expect(badId.result.exitCode).toBe(2);
    expect(badId.state.calls ?? []).toHaveLength(0);
  });

  test('download writes only the successful attempt bytes to the destination', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-gh-retry-asset-'));
    roots.push(root);
    const dest = join(root, 'asset.bin');
    const { result } = run(
      'gh_download_release_asset',
      [REPO, '901', dest],
      [
        { exit: 1, stdout: 'partial-garbage', stderr: 'gh: HTTP 502' },
        { exit: 0, stdout: 'real-bytes' },
      ],
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(dest, 'utf8')).toBe('real-bytes\n');
  });
});
