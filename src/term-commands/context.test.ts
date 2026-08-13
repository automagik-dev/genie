/**
 * genie context — CLI-level tests. Each case invokes the real `genie.ts`
 * entry as a user would (subprocess), against throwaway REAL git repositories
 * (the contract's whole job is reading git + genie.db truth, so a mocked git
 * would test nothing), and asserts exit code AND stderr, not just stdout.
 */

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveIntegrationBranch } from '../genie-commands/doctor-worktrees.js';
import { peelCommit, resolveIntegration } from '../lib/v5/base-state.js';
import { openDb, resolveDbPath } from '../lib/v5/genie-db.js';
import { claimTask, createTask, listTasks } from '../lib/v5/task-state.js';
import { contextCommand, openReadonlyHandle } from './context.js';

const GENIE = join(import.meta.dir, '..', 'genie.ts');

const scratchRoots: string[] = [];

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
}

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Spawn `bun genie.ts context ...` with a clean color environment (no FORCE_COLOR warning on stderr). */
async function cli(cwd: string, ...args: string[]): Promise<CliResult> {
  const env: Record<string, string> = { NO_COLOR: '1' };
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'FORCE_COLOR' || key === 'NO_COLOR') continue;
    if (value !== undefined) env[key] = value;
  }
  const proc = Bun.spawn(['bun', GENIE, 'context', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

/** The line terminator is the only newline allowed in a payload/failure line. */
function singleLine(text: string): string {
  expect(text.trimEnd().includes('\n')).toBe(false);
  return text.trimEnd();
}

/** Parse the success payload, failing the test on any shape surprise. */
function payloadOf(result: CliResult): Record<string, unknown> {
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(singleLine(result.stdout)) as Record<string, unknown>;
}

/** Parse the machine-readable failure line, failing the test on any shape surprise. */
function failureOf(result: CliResult): { error: string; reason: string } {
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  const parsed = JSON.parse(singleLine(result.stderr)) as { error: string; reason: string };
  expect(typeof parsed.error).toBe('string');
  expect(typeof parsed.reason).toBe('string');
  return parsed;
}

/** A payload field asserted as a string (payloadOf returns unknown-valued fields). */
function str(value: unknown): string {
  expect(typeof value).toBe('string');
  return value as string;
}

interface Fixture {
  dir: string;
  root: string;
}

/** Seeded repo. `integration: 'none'` omits the `dev` branch. */
function makeFixture(options: { integration?: 'dev' | 'none' } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'genie-context-'));
  scratchRoots.push(dir);
  const root = join(dir, 'repo');
  mkdirSync(root);
  git(dir, 'init', '-q', root);
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'seed\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'seed');
  if (options.integration !== 'none') git(root, 'branch', 'dev');
  return { dir, root };
}

/** Bare origin remote whose default branch becomes the integration fallback. */
function addOriginDefault(fx: Fixture, branch: string): void {
  const origin = join(fx.dir, 'origin.git');
  mkdirSync(origin);
  git(fx.dir, 'init', '--bare', '-q', origin);
  git(fx.root, 'remote', 'add', 'origin', origin);
  git(fx.root, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
  git(fx.root, 'remote', 'set-head', 'origin', branch);
}

function devSha(fx: Fixture): string {
  return git(fx.root, 'rev-parse', 'refs/heads/dev^{commit}');
}

function advanceDev(fx: Fixture): string {
  // Commit on the DEV branch (the checkout sits on the init branch, not dev).
  git(fx.root, 'checkout', '-q', 'dev');
  git(fx.root, 'commit', '-q', '--allow-empty', '-m', 'advance');
  git(fx.root, 'checkout', '-q', '-');
  return devSha(fx);
}

/** Seed the repo's genie.db with one ready task per group (groups listed in order). */
function seedTasks(fx: Fixture, wish: string, groups: string[]): void {
  const db = openDb({ cwd: fx.root });
  for (const group of groups) {
    createTask(db, { title: `task ${group}`, wish, group });
  }
  db.close();
}

function metaRow(fx: Fixture, key: string): string | null {
  const db = new Database(resolveDbPath(fx.root), { readonly: true });
  try {
    const row = db.query('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | null;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

function dbBytes(fx: Fixture): Buffer {
  return readFileSync(resolveDbPath(fx.root));
}

function genieDirEntries(fx: Fixture): string[] {
  const dir = join(fx.root, '.genie');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

const DEV_SHA_PATTERN = /^[0-9a-f]{40}$/;

// ============================================================================
// Read-only open semantics
// ============================================================================

describe('read-only open', () => {
  test('with a pending non-empty WAL, the readonly open still sees the uncheckpointed rows', () => {
    const fx = makeFixture();
    seedTasks(fx, 'probe', []);
    const dbPath = resolveDbPath(fx.root);
    const writer = new Database(dbPath, { create: true });
    writer.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('probe', 'uncheckpointed');
    // Writer stays OPEN — the frame sits in the -wal, not the main file.
    const handle = openReadonlyHandle(dbPath);
    expect(handle).not.toBeNull();
    try {
      const row = handle?.query('SELECT value FROM meta WHERE key = ?').get('probe') as { value: string };
      expect(row.value).toBe('uncheckpointed');
    } finally {
      handle?.close();
      writer.close();
    }
  });
});

// ============================================================================
// Wishless form — integration branch + SHA, zero state
// ============================================================================

describe('wishless context', () => {
  test('resolves a local dev branch to its full commit SHA with zero DB writes', async () => {
    const fx = makeFixture();
    const result = await cli(fx.root);
    const payload = payloadOf(result);
    expect(payload).toEqual({ version: 1, branch: 'dev', base: devSha(fx), tasks: [] });
    expect(DEV_SHA_PATTERN.test(str(payload.base))).toBe(true);
    expect(existsSync(join(fx.root, '.genie', 'genie.db'))).toBe(false);
    expect(genieDirEntries(fx)).toEqual([]);
  });

  test('--plan prints the identical payload and still writes nothing', async () => {
    const fx = makeFixture();
    const plain = await cli(fx.root);
    const planned = await cli(fx.root, '--plan');
    expect(planned.stdout).toBe(plain.stdout);
    expect(planned.code).toBe(0);
    expect(genieDirEntries(fx)).toEqual([]);
  });

  test('falls back to the remote default branch when there is no dev', async () => {
    const fx = makeFixture({ integration: 'none' });
    addOriginDefault(fx, 'main');
    const result = await cli(fx.root);
    const payload = payloadOf(result);
    // The payload names the LOGICAL local branch (`main`), never the
    // remote-tracking name (`origin/main`) a consumer might pass to
    // `git worktree add -b` and silently create `refs/heads/origin/main`.
    expect(str(payload.branch)).toBe('main');
    expect(str(payload.base)).toBe(git(fx.root, 'rev-parse', 'refs/remotes/origin/HEAD^{commit}'));
    expect(genieDirEntries(fx)).toEqual([]);
  });

  test('fails closed with a machine-readable reason when no integration branch resolves', async () => {
    const fx = makeFixture({ integration: 'none' });
    const result = await cli(fx.root);
    expect(failureOf(result).error).toBe('no-integration-branch');
  });

  test('refuses --group and --re-resolve without --wish', async () => {
    const fx = makeFixture();
    expect(failureOf(await cli(fx.root, '--group', 'g')).error).toBe('group-requires-wish');
    expect(failureOf(await cli(fx.root, '--re-resolve')).error).toBe('re-resolve-requires-wish');
  });
});

// ============================================================================
// Wish-scoped form — recorded base state
// ============================================================================

describe('wish context', () => {
  test('first non-plan resolution resolves, records, and returns the composed payload', async () => {
    const fx = makeFixture();
    seedTasks(fx, 'demo', ['alpha']);
    const result = await cli(fx.root, '--wish', 'demo', '--group', 'alpha');
    const payload = payloadOf(result);
    expect(payload).toEqual({
      version: 1,
      wish: 'demo',
      group: 'alpha',
      branch: 'wish/demo-alpha',
      base: devSha(fx),
      tasks: [{ id: expect.any(String), title: 'task alpha' }],
    });
    // The wave pin was recorded: wish branch + pinned SHA + timestamp.
    const record = JSON.parse(metaRow(fx, 'wish_base:demo') ?? 'null') as {
      branch: string;
      base: string;
      recordedAt: number;
    };
    expect(record.branch).toBe('wish/demo');
    expect(str(record.base)).toBe(devSha(fx));
    expect(typeof record.recordedAt).toBe('number');
  });

  test('second call returns the recorded base even after the integration branch moves', async () => {
    const fx = makeFixture();
    seedTasks(fx, 'demo', ['alpha']);
    const first = payloadOf(await cli(fx.root, '--wish', 'demo', '--group', 'alpha'));
    advanceDev(fx);
    const second = payloadOf(await cli(fx.root, '--wish', 'demo', '--group', 'alpha'));
    expect(str(second.base)).toBe(str(first.base));
    expect(str(second.base)).not.toBe(devSha(fx));
    const record = JSON.parse(metaRow(fx, 'wish_base:demo') ?? 'null') as { base: string };
    expect(str(record.base)).toBe(str(first.base));
  });

  test('--re-resolve refreshes the recorded base from the integration branch', async () => {
    const fx = makeFixture();
    seedTasks(fx, 'demo', ['alpha']);
    const first = payloadOf(await cli(fx.root, '--wish', 'demo', '--group', 'alpha'));
    const advanced = advanceDev(fx);
    const refreshed = payloadOf(await cli(fx.root, '--wish', 'demo', '--group', 'alpha', '--re-resolve'));
    expect(str(refreshed.base)).toBe(advanced);
    expect(str(refreshed.base)).not.toBe(str(first.base));
    expect((JSON.parse(metaRow(fx, 'wish_base:demo') ?? 'null') as { base: string }).base).toBe(advanced);
  });

  test('--plan never writes the wave pin, not even when no base is recorded', async () => {
    const fx = makeFixture();
    seedTasks(fx, 'demo', ['alpha']);
    // Strip SQLite's own sidecars BEFORE the snapshot: bun's darwin writer
    // leaves a 32KB -shm and a 0-byte -wal behind when it closes, so a
    // snapshot taken right after seeding would already contain them and the
    // darwin strict pin below could never discriminate the immutable open
    // from the plain-readonly fallback. The writer closed cleanly, so the
    // -wal holds no frames worth keeping — removing it loses nothing.
    for (const sidecar of ['genie.db-shm', 'genie.db-wal']) {
      rmSync(join(fx.root, '.genie', sidecar), { force: true });
    }
    const bytesBefore = dbBytes(fx);
    const entriesBefore = genieDirEntries(fx);
    expect(entriesBefore).toEqual(['genie.db']);
    const payload = payloadOf(await cli(fx.root, '--wish', 'demo', '--group', 'alpha', '--plan'));
    // Directory evidence is taken BEFORE any further DB open: a later probe
    // would itself create (or fail to create) sidecars, masking what --plan
    // did. Note the row check below uses the production openReadonlyHandle —
    // a plain readonly open cannot open a stripped WAL db on darwin at all.
    const added = genieDirEntries(fx).filter((name) => !entriesBefore.includes(name));
    expect(str(payload.base)).toBe(devSha(fx));
    const planHandle = openReadonlyHandle(resolveDbPath(fx.root));
    try {
      expect(planHandle?.query('SELECT value FROM meta WHERE key = ?').get('wish_base:demo')).toBeNull();
    } finally {
      planHandle?.close();
    }
    expect(dbBytes(fx).equals(bytesBefore)).toBe(true);
    // Cross-platform bound: anything --plan added must be exactly the
    // genie.db-shm/-wal pair (the documented plain-readonly fallback on
    // SQLite builds that reject the immutable URI form) — never any other
    // file of any name.
    expect(added.every((name) => name === 'genie.db-shm' || name === 'genie.db-wal')).toBe(true);
    // Where the immutable open is honored (observed on darwin builds), pin the
    // strict contract: NO new file of any name appears — this is what
    // discriminates immutable from the fallback.
    if (process.platform === 'darwin') expect(added).toEqual([]);
  });

  test('--plan returns the recorded base (what spawn would consume) without re-resolving', async () => {
    const fx = makeFixture();
    seedTasks(fx, 'demo', ['alpha']);
    payloadOf(await cli(fx.root, '--wish', 'demo', '--group', 'alpha'));
    advanceDev(fx);
    const planned = payloadOf(await cli(fx.root, '--wish', 'demo', '--group', 'alpha', '--plan'));
    expect(str(planned.base)).not.toBe(devSha(fx));
  });

  test('--plan --re-resolve previews the refreshed base but writes nothing', async () => {
    const fx = makeFixture();
    seedTasks(fx, 'demo', ['alpha']);
    payloadOf(await cli(fx.root, '--wish', 'demo', '--group', 'alpha'));
    const advanced = advanceDev(fx);
    const before = dbBytes(fx);
    const planned = payloadOf(await cli(fx.root, '--wish', 'demo', '--group', 'alpha', '--plan', '--re-resolve'));
    expect(str(planned.base)).toBe(advanced);
    expect(dbBytes(fx).equals(before)).toBe(true);
    expect((JSON.parse(metaRow(fx, 'wish_base:demo') ?? 'null') as { base: string }).base).not.toBe(advanced);
  });

  test('--plan on a repo with no genie.db still returns branch+base (empty tasks) and creates nothing', async () => {
    const fx = makeFixture();
    const payload = payloadOf(await cli(fx.root, '--wish', 'demo', '--group', 'alpha', '--plan'));
    expect(payload).toEqual({
      version: 1,
      wish: 'demo',
      branch: 'wish/demo-alpha',
      base: devSha(fx),
      tasks: [],
      group: 'alpha',
    });
    expect(genieDirEntries(fx)).toEqual([]);
    expect(existsSync(join(fx.root, '.genie', 'genie.db'))).toBe(false);
  });

  test('group-less form returns the recorded wish branch and every ready task', async () => {
    const fx = makeFixture();
    seedTasks(fx, 'demo', ['alpha', 'beta']);
    const payload = payloadOf(await cli(fx.root, '--wish', 'demo'));
    expect(payload.group).toBeUndefined();
    expect(str(payload.branch)).toBe('wish/demo');
    expect(payload.tasks).toEqual([
      { id: expect.any(String), title: 'task alpha' },
      { id: expect.any(String), title: 'task beta' },
    ]);
  });

  test('--group filters the ready tasks to that group only', async () => {
    const fx = makeFixture();
    seedTasks(fx, 'demo', ['alpha', 'beta']);
    const payload = payloadOf(await cli(fx.root, '--wish', 'demo', '--group', 'beta'));
    expect(str(payload.branch)).toBe('wish/demo-beta');
    expect(payload.tasks).toEqual([{ id: expect.any(String), title: 'task beta' }]);
  });

  test('a wish with no ready tasks still resolves+records the base and exits 0 with empty tasks', async () => {
    const fx = makeFixture();
    const payload = payloadOf(await cli(fx.root, '--wish', 'demo', '--group', 'alpha'));
    expect(payload).toEqual({
      version: 1,
      wish: 'demo',
      branch: 'wish/demo-alpha',
      base: devSha(fx),
      tasks: [],
      group: 'alpha',
    });
    expect(metaRow(fx, 'wish_base:demo')).not.toBeNull();
  });

  test('a claimed (in_progress) group still gets its base: empty tasks, exit 0 — resume works', async () => {
    const fx = makeFixture();
    seedTasks(fx, 'demo', ['alpha']);
    const db = openDb({ cwd: fx.root });
    const task = listTasks(db, { wish: 'demo', status: 'ready' })[0];
    claimTask(db, task.id, 'worker');
    db.close();
    const payload = payloadOf(await cli(fx.root, '--wish', 'demo', '--group', 'alpha'));
    expect(payload.tasks).toEqual([]);
    expect(str(payload.base)).toBe(devSha(fx));
    expect(str(payload.branch)).toBe('wish/demo-alpha');
  });

  test('fails closed with machine-readable reasons for every degradation', async () => {
    const fx = makeFixture({ integration: 'none' });
    seedTasks(fx, 'demo', ['alpha']);
    expect(failureOf(await cli(fx.root, '--wish', 'demo', '--group', 'alpha')).error).toBe('no-integration-branch');

    // A recorded base whose object is gone refuses, and --re-resolve heals.
    const bogus = '1111111111111111111111111111111111111111';
    const db = openDb({ cwd: fx.root });
    db.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      'wish_base:demo',
      JSON.stringify({ branch: 'wish/demo', base: bogus, recordedAt: 1 }),
    );
    db.close();
    const missing = failureOf(await cli(fx.root, '--wish', 'demo', '--group', 'alpha'));
    expect(missing.error).toBe('recorded-base-missing');
    expect(missing.reason).toContain('--re-resolve');

    // A malformed record refuses too — never silently re-resolved.
    const db2 = openDb({ cwd: fx.root });
    db2.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('wish_base:demo', '{not json');
    db2.close();
    expect(failureOf(await cli(fx.root, '--wish', 'demo', '--group', 'alpha')).error).toBe('corrupt-base-record');
  });

  test('rejects injection payloads with a machine-readable reason', async () => {
    const fx = makeFixture();
    seedTasks(fx, 'demo', ['alpha']);
    for (const slug of ['a;b', 'a"b', 'a b', 'a$(x)', 'a`b`', 'a|b', 'a\nb']) {
      const result = await cli(fx.root, '--wish', slug, '--group', 'alpha');
      expect(failureOf(result).error).toBe('invalid-wish-slug');
    }
    expect(failureOf(await cli(fx.root, '--wish', 'demo', '--group', 'a;b')).error).toBe('invalid-group-name');
    // A `-`-prefixed value is consumed by the argument parser as the option's
    // value, then rejected by the charset gate — never resolved, never recorded.
    expect(failureOf(await cli(fx.root, '--wish', '--foo', '--group', 'alpha')).error).toBe('invalid-wish-slug');
  });

  test('rejects everything git check-ref-format rejects in the composed ref', async () => {
    const fx = makeFixture();
    seedTasks(fx, 'demo', ['alpha']);
    for (const slug of ['a..b', '.hidden', 'trailing.', 'padlock.LOCK', 'padlock.lock']) {
      const result = await cli(fx.root, '--wish', slug, '--group', 'alpha');
      expect(failureOf(result).error).toBe('invalid-wish-slug');
    }
    for (const group of ['a..b', '.hidden', 'trailing.', 'padlock.lock']) {
      const result = await cli(fx.root, '--wish', 'demo', '--group', group);
      expect(failureOf(result).error).toBe('invalid-group-name');
    }
    // None of the rejected names left a wave-pin record behind.
    expect(metaRow(fx, 'wish_base:.hidden')).toBeNull();
    expect(metaRow(fx, 'wish_base:a..b')).toBeNull();
  });

  test('rejects a `-`-prefixed slug with a machine-readable reason and records nothing', () => {
    const fx = makeFixture();
    seedTasks(fx, 'demo', ['alpha']);
    const errors: string[] = [];
    const code = contextCommand(
      { wish: '-x', group: 'alpha' },
      { cwd: fx.root, write: () => {}, writeErr: (line) => errors.push(line) },
    );
    expect(code).toBe(1);
    expect((JSON.parse(errors[0]) as { error: string }).error).toBe('invalid-wish-slug');
    expect(metaRow(fx, 'wish_base:-x')).toBeNull();
  });

  test('payload is shell-consumable: one line, JSON-escaped titles, no raw refs', async () => {
    const fx = makeFixture();
    const db = openDb({ cwd: fx.root });
    createTask(db, { title: 'quote " semi; dollar $(touch pwned) newline\nline', wish: 'demo', group: 'alpha' });
    db.close();
    const result = await cli(fx.root, '--wish', 'demo', '--group', 'alpha');
    const payload = payloadOf(result);
    const tasks = payload.tasks as Array<{ id: string; title: string }>;
    expect(tasks[0].title).toBe('quote " semi; dollar $(touch pwned) newline\nline');
    expect(existsSync(join(fx.root, 'pwned'))).toBe(false);
    expect(DEV_SHA_PATTERN.test(str(payload.base))).toBe(true);
    expect(typeof payload.branch).toBe('string');
  });
});

// ============================================================================
// Shared base-resolution policy (extracted from doctor)
// ============================================================================

describe('shared integration policy', () => {
  test('base-state is the single policy point doctor and context share', () => {
    const fx = makeFixture();
    const shared = resolveIntegration(fx.root);
    expect(shared).toEqual({ name: 'dev', ref: 'refs/heads/dev' });
    expect(resolveIntegrationBranch(fx.root)).toBe(shared?.name ?? null);
  });

  test('a git failure resolves to null specifically — never a throw, never a guess', () => {
    // An empty directory is not a repository: every probe fails and the
    // policy must say "nothing resolvable" instead of throwing or inventing
    // a branch.
    const bare = mkdtempSync(join(tmpdir(), 'genie-context-nogit-'));
    scratchRoots.push(bare);
    expect(resolveIntegration(bare)).toBeNull();
    expect(peelCommit(bare, 'refs/heads/dev')).toBeNull();
    expect(resolveIntegrationBranch(bare)).toBeNull();
  });
});

// ============================================================================
// Stat sanity used only to keep the fixture helper honest
// ============================================================================

test('fixture helper leaves the temp tree as expected', () => {
  const fx = makeFixture();
  expect(existsSync(join(fx.root, '.git'))).toBe(true);
  expect(statSync(join(fx.root, 'README.md')).isFile()).toBe(true);
});
