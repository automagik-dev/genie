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
  id?: number;
  makeLatest?: string;
  verifiedTag?: boolean;
  failOn?: string;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(
  state: FakeReleaseState,
  mode: 'prepare' | 'finalize' = 'prepare',
  overrides: Record<string, string> = {},
) {
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
const field = (flag, name) => {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === flag && args[index + 1].startsWith(name + '=')) return args[index + 1].slice(name.length + 1);
  }
};
if (state.failOn && args.join(' ').includes(state.failOn)) { save(); process.exit(42); }
if (args[0] === 'release' && args[1] === 'view') {
  if (!state.exists) { save(); process.exit(1); }
  const json = value('--json');
  if (json === 'body') console.log(state.body ?? '');
  if (json === 'isPrerelease,isDraft') {
    console.log(String(state.prerelease === true) + '\\t' + String(state.draft === true));
  }
  if (json === 'databaseId,isDraft,isPrerelease') {
    console.log(String(state.id ?? 101) + '\\t' + String(state.draft === true) + '\\t' + String(state.prerelease === true));
  }
  save();
  process.exit(0);
}
if (args[0] === 'release' && args[1] === 'create') {
  state.exists = true;
  state.id ??= 101;
  state.body = value('--notes') ?? '';
  state.draft = args.includes('--draft');
  state.prerelease = args.includes('--prerelease');
  state.makeLatest = assigned('--latest');
  state.verifiedTag = args.includes('--verify-tag');
  save();
  process.exit(0);
}
if (args[0] === 'release' && args[1] === 'edit') {
  if (value('--notes') !== undefined) state.body = value('--notes');
  save();
  process.exit(0);
}
if (args[0] === 'api') {
  const draft = field('-F', 'draft');
  const prerelease = field('-F', 'prerelease');
  const makeLatest = field('-f', 'make_latest');
  if (draft !== undefined) state.draft = draft === 'true';
  if (prerelease !== undefined) state.prerelease = prerelease === 'true';
  if (makeLatest !== undefined) state.makeLatest = makeLatest;
  save();
  process.exit(0);
}
save();
process.exit(2);
`,
  );
  chmodSync(ghPath, 0o755);
  const result = Bun.spawnSync(['bash', SCRIPT, mode], {
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
  test('prepare creates a verified-tag draft that is explicitly non-latest', () => {
    const { result, state } = run({ exists: false, body: '' });
    expect(result.exitCode).toBe(0);
    expect(state.body.match(/genie-agent-sync-migration-v1/g)).toHaveLength(1);
    expect(state.body).toContain('older than `5.260711.6`');
    expect(state.draft).toBe(true);
    expect(state.makeLatest).toBe('false');
    expect(state.verifiedTag).toBe(true);
    expect(state.calls?.filter((args) => args[1] === 'create')).toHaveLength(1);
  });

  test('prepare preserves an existing human body and is idempotent', () => {
    const first = run({ exists: true, body: 'Human-authored release notes.', draft: true });
    expect(first.result.exitCode).toBe(0);
    expect(first.state.body).toStartWith('Human-authored release notes.');
    expect(first.state.body.match(/genie-agent-sync-migration-v1/g)).toHaveLength(1);

    const second = run(first.state);
    expect(second.result.exitCode).toBe(0);
    expect(second.state.body.match(/genie-agent-sync-migration-v1/g)).toHaveLength(1);
    expect(second.state.calls?.filter((args) => args[1] === 'edit')).toHaveLength(1);
  });

  test('stable finalize promotes to Latest from a fresh draft or a dev-published prerelease', () => {
    const fromDraft = run(
      { exists: true, id: 77, body: '<!-- genie-agent-sync-migration-v1 -->', draft: true, prerelease: false },
      'finalize',
    );
    expect(fromDraft.result.exitCode).toBe(0);
    expect(fromDraft.state.draft).toBe(false);
    expect(fromDraft.state.prerelease).toBe(false);
    expect(fromDraft.state.makeLatest).toBe('true');

    // The bug this fixes: the dev channel already published the tag as a
    // prerelease (draft=false, prerelease=true). Stable finalize must still
    // promote it — clear the prerelease flag AND select it as Latest.
    const fromDevPublished = run(
      { exists: true, id: 78, body: '<!-- genie-agent-sync-migration-v1 -->', draft: false, prerelease: true },
      'finalize',
    );
    expect(fromDevPublished.result.exitCode).toBe(0);
    expect(fromDevPublished.state.draft).toBe(false);
    expect(fromDevPublished.state.prerelease).toBe(false);
    expect(fromDevPublished.state.makeLatest).toBe('true');
    expect(fromDevPublished.state.calls?.filter((args) => args[0] === 'api')).toHaveLength(1);
  });

  test('dev finalize publishes a prerelease that is never Latest', () => {
    const dev = run(
      { exists: true, id: 79, body: '<!-- genie-agent-sync-migration-v1 -->', draft: true, prerelease: true },
      'finalize',
      { CHANNEL: 'dev' },
    );
    expect(dev.result.exitCode).toBe(0);
    expect(dev.state.draft).toBe(false);
    expect(dev.state.prerelease).toBe(true);
    expect(dev.state.makeLatest).toBe('false');
  });

  test('finalize is idempotent on releases already in their channel terminal state', () => {
    // A stable release already published as non-prerelease Latest is left
    // untouched — no PATCH, metadata preserved.
    const stable = run(
      {
        exists: true,
        id: 77,
        body: '<!-- genie-agent-sync-migration-v1 -->',
        draft: false,
        prerelease: false,
        makeLatest: 'true',
      },
      'finalize',
    );
    expect(stable.result.exitCode).toBe(0);
    expect(stable.state.prerelease).toBe(false);
    expect(stable.state.makeLatest).toBe('true');
    expect(stable.state.calls?.filter((args) => args[0] === 'api')).toHaveLength(0);

    // A dev release already published as a prerelease is immutable on the dev
    // channel — flags preserved, never Latest, no PATCH.
    const devPublished = run(
      {
        exists: true,
        id: 78,
        body: '<!-- genie-agent-sync-migration-v1 -->',
        draft: false,
        prerelease: true,
        makeLatest: 'false',
      },
      'finalize',
      { CHANNEL: 'dev' },
    );
    expect(devPublished.result.exitCode).toBe(0);
    expect(devPublished.state.prerelease).toBe(true);
    expect(devPublished.state.makeLatest).toBe('false');
    expect(devPublished.state.calls?.filter((args) => args[0] === 'api')).toHaveLength(0);
  });

  test('DRAFT=true leaves the fully prepared release unpublished', () => {
    const draft = run({ exists: true, body: '<!-- genie-agent-sync-migration-v1 -->', draft: true }, 'finalize', {
      DRAFT: 'true',
    });
    expect(draft.result.exitCode).toBe(0);
    expect(draft.state.draft).toBe(true);
    expect(draft.state.calls?.filter((args) => args[0] === 'api')).toHaveLength(0);
  });

  test('refuses to replay an existing stable release through a prerelease channel', () => {
    const dev = run(
      { exists: true, body: '<!-- genie-agent-sync-migration-v1 -->', prerelease: false, draft: false },
      'prepare',
      { CHANNEL: 'dev' },
    );
    expect(dev.result.exitCode).toBe(3);
    expect(dev.result.stderr.toString()).toContain('refusing to demote existing stable release');
  });

  test('finalize refuses missing releases and missing reconciled notes', () => {
    const missing = run({ exists: false, body: '' }, 'finalize');
    expect(missing.result.exitCode).toBe(3);
    expect(missing.result.stderr.toString()).toContain('cannot finalize missing release');

    const missingNote = run({ exists: true, body: 'human only', draft: true }, 'finalize');
    expect(missingNote.result.exitCode).toBe(3);
    expect(missingNote.result.stderr.toString()).toContain('without the reconciled migration note');
  });

  test('propagates GitHub API failures instead of reporting success', () => {
    const edit = run({ exists: true, body: 'needs note', draft: true, failOn: 'release edit' });
    expect(edit.result.exitCode).toBe(42);

    const publish = run(
      {
        exists: true,
        body: '<!-- genie-agent-sync-migration-v1 -->',
        draft: true,
        failOn: 'api -X PATCH',
      },
      'finalize',
    );
    expect(publish.result.exitCode).toBe(42);
  });
});
