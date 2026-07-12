import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'reconcile-release-note.sh');
const roots: string[] = [];

interface FakeReleaseState {
  exists: boolean;
  body: string;
  calls?: string[][];
  draft?: boolean;
  prerelease?: boolean;
  latest?: boolean;
  failOn?: string;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(state: FakeReleaseState, overrides: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'genie-release-note-'));
  roots.push(root);
  const statePath = join(root, 'state.json');
  const ghPath = join(root, 'gh');
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
const path = process.env.GH_FAKE_STATE;
const state = JSON.parse(readFileSync(path, 'utf8'));
const args = process.argv.slice(2);
state.calls ??= [];
state.calls.push(args);
const save = () => writeFileSync(path, JSON.stringify(state));
const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const assigned = (flag) => args.find((arg) => arg.startsWith(flag + '='))?.slice(flag.length + 1);
if (state.failOn && args.join(' ').includes(state.failOn)) { save(); process.exit(42); }
if (args[0] !== 'release') { save(); process.exit(2); }
if (args[1] === 'view') {
  if (!state.exists) { save(); process.exit(1); }
  if (value('--json') === 'body') console.log(state.body ?? '');
  save();
  process.exit(0);
}
if (args[1] === 'create') {
  state.exists = true;
  state.body = value('--notes') ?? '';
  state.draft = args.includes('--draft');
  state.prerelease = args.includes('--prerelease');
  save();
  process.exit(0);
}
if (args[1] === 'edit') {
  if (value('--notes') !== undefined) state.body = value('--notes');
  if (assigned('--prerelease') !== undefined) state.prerelease = assigned('--prerelease') === 'true';
  if (args.includes('--latest')) state.latest = true;
  if (assigned('--latest') !== undefined) state.latest = assigned('--latest') === 'true';
  save();
  process.exit(0);
}
save();
process.exit(2);
`,
  );
  chmodSync(ghPath, 0o755);
  const result = Bun.spawnSync(['bash', SCRIPT], {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH ?? ''}`,
      GH_FAKE_STATE: statePath,
      VERSION: '5.260711.6',
      CHANNEL: 'stable',
      DRAFT: 'false',
      RELEASE_REPOSITORY: 'automagik-dev/genie',
      ...overrides,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    result,
    state: JSON.parse(readFileSync(statePath, 'utf8')) as FakeReleaseState,
  };
}

describe('release migration-note reconciliation', () => {
  test('creates a new release with one version-bounded migration note', () => {
    const { result, state } = run({ exists: false, body: '' });
    expect(result.exitCode).toBe(0);
    expect(state.body.match(/genie-agent-sync-migration-v1/g)).toHaveLength(1);
    expect(state.body).toContain('older than `5.260711.6`');
    expect(state.calls?.filter((args) => args[1] === 'create')).toHaveLength(1);
  });

  test('preserves an existing human body and is idempotent', () => {
    const first = run({ exists: true, body: 'Human-authored release notes.' });
    expect(first.result.exitCode).toBe(0);
    expect(first.state.body).toStartWith('Human-authored release notes.');
    expect(first.state.body.match(/genie-agent-sync-migration-v1/g)).toHaveLength(1);

    const second = run(first.state);
    expect(second.result.exitCode).toBe(0);
    expect(second.state.body.match(/genie-agent-sync-migration-v1/g)).toHaveLength(1);
    expect(second.state.calls?.filter((args) => args.includes('--notes'))).toHaveLength(1);
  });

  test('promotes stable releases and keeps non-stable releases prerelease', () => {
    const stable = run({ exists: true, body: '<!-- genie-agent-sync-migration-v1 -->', prerelease: true });
    expect(stable.result.exitCode).toBe(0);
    expect(stable.state.prerelease).toBe(false);
    expect(stable.state.latest).toBe(true);

    const dev = run(
      { exists: true, body: '<!-- genie-agent-sync-migration-v1 -->', prerelease: false },
      { CHANNEL: 'dev' },
    );
    expect(dev.result.exitCode).toBe(0);
    expect(dev.state.prerelease).toBe(true);
    expect(dev.state.latest).toBe(false);
  });

  test('propagates gh failures instead of reporting reconciliation success', () => {
    const { result } = run({ exists: true, body: 'needs note', failOn: 'release edit' });
    expect(result.exitCode).toBe(42);
  });
});
