/**
 * genie task — CLI-level tests. Each case invokes the real `genie.ts` entry
 * as a user would (subprocess), against a throwaway git-repo fixture, and
 * asserts exit code AND stderr, not just stdout.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resolveDbPath } from '../lib/v5/genie-db.js';
import {
  DEFAULT_LIFECYCLE_LANES,
  type StateExport,
  appendStage,
  appendTaskEvent,
  createBoard,
  createTask,
  createWishGroups,
  getTask,
  getTaskCard,
  getTaskEvents,
  getTaskLane,
} from '../lib/v5/task-state.js';

const GENIE = join(import.meta.dir, '..', 'genie.ts');

let repo: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function cli(cwd: string, ...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(['bun', GENIE, 'task', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', GENIE_TEST_SKIP_PGSERVE: '1' },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'genie-v5-task-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'commit', '--allow-empty', '-m', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('task create', () => {
  test('creates a ready task and reports its id', async () => {
    const r = await cli(repo, 'create', '--title', 'ship it');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/Created task t_\w+ "ship it" \(ready\)\./);
  });

  test('rejects an empty title with a clear stderr and exit 1', async () => {
    const r = await cli(repo, 'create', '--title', '   ');
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--title is required');
  });

  test('rejects --group without --wish', async () => {
    const r = await cli(repo, 'create', '--title', 't', '--group', 'g1');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--group requires --wish');
  });

  test('rejects a missing board reference with a typed error and exit 1', async () => {
    const r = await cli(repo, 'create', '--title', 't', '--board', 'ghost');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Board not found: ghost');
  });

  test('attaches to an existing board by id', async () => {
    const db = openDb({ cwd: repo });
    const board = createBoard(db, 'sprint-1');
    db.close();
    const r = await cli(repo, 'create', '--title', 'on board', '--board', board.id);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
  });
});

describe('task list', () => {
  test('reports "No tasks found." on an empty repo', async () => {
    const r = await cli(repo, 'list');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No tasks found.');
  });

  test('rejects an invalid --status', async () => {
    const r = await cli(repo, 'list', '--status', 'nope');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Invalid --status "nope"');
  });

  test('--json emits an array filtered by wish', async () => {
    await cli(repo, 'create', '--title', 'a', '--wish', 'demo');
    await cli(repo, 'create', '--title', 'b');
    const r = await cli(repo, 'list', '--wish', 'demo', '--json');
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<{ title: string; wish: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('a');
    expect(rows[0].wish).toBe('demo');
  });
});

describe('task status / done / checkout', () => {
  async function seedTask(title: string): Promise<string> {
    const db = openDb({ cwd: repo });
    const task = createTask(db, { title });
    db.close();
    return task.id;
  }

  test('status shows detail; unknown id fails with exit 1', async () => {
    const id = await seedTask('inspect me');
    const ok = await cli(repo, 'status', id);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain(id);
    expect(ok.stdout).toContain('inspect me');

    const bad = await cli(repo, 'status', 't_missing');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('Task not found: t_missing');
  });

  test('checkout claims a ready task; a second claim conflicts with exit 1', async () => {
    const id = await seedTask('claim me');
    const first = await cli(repo, 'checkout', id, '--worker', 'w1');
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('in_progress');

    const second = await cli(repo, 'checkout', id, '--worker', 'w2');
    expect(second.code).toBe(1);
    expect(second.stderr).toContain('not claimable');
  });

  test('done marks a task done; unknown id fails with exit 1', async () => {
    const id = await seedTask('finish me');
    const ok = await cli(repo, 'done', id);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('marked done');

    const bad = await cli(repo, 'done', 't_missing');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('Task not found: t_missing');
  });
});

describe('task move', () => {
  async function seedLaneCard(): Promise<string> {
    const db = openDb({ cwd: repo });
    const board = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const task = createTask(db, { title: 'lane card', boardId: board.id, lane: 'Idea' });
    db.close();
    return task.id;
  }

  test('moves a card to a valid lane and appends a move event', async () => {
    const id = await seedLaneCard();
    const r = await cli(repo, 'move', id, '--to', 'Brainstorm');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Idea → Brainstorm');

    const db = openDb({ cwd: repo });
    expect(getTaskLane(db, id)).toBe('Brainstorm');
    const events = getTaskEvents(db, id);
    db.close();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('move');
    expect(events[0].note).toBe('Idea→Brainstorm');
  });

  test('an undefined lane fails with exit 1 and lists the valid lanes', async () => {
    const id = await seedLaneCard();
    const r = await cli(repo, 'move', id, '--to', 'Nope');
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Unknown lane "Nope"');
    expect(r.stderr).toContain('Idea, Brainstorm, Wish, Work, Review, Done');

    // The failed move left the card and its timeline untouched.
    const db = openDb({ cwd: repo });
    expect(getTaskLane(db, id)).toBe('Idea');
    expect(getTaskEvents(db, id)).toHaveLength(0);
    db.close();
  });

  test('moving a card that is not on a board fails with exit 1', async () => {
    const db = openDb({ cwd: repo });
    const task = createTask(db, { title: 'boardless' });
    db.close();
    const r = await cli(repo, 'move', task.id, '--to', 'Idea');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not on a board');
  });
});

describe('subdirectory resolution (carried-over fix)', () => {
  test('invocation from a repo subdirectory hits the repo-root shared DB', async () => {
    const sub = join(repo, 'src', 'deep');
    await mkdir(sub, { recursive: true });

    const created = await cli(sub, 'create', '--title', 'from a subdir');
    expect(created.code).toBe(0);

    // The task must be visible from the repo root — same shared DB, no stray file.
    const listed = await cli(repo, 'list');
    expect(listed.stdout).toContain('from a subdir');

    // And the DB must live at the repo root, not under src/deep.
    const db = openDb({ path: resolveDbPath(repo) });
    const rootCount = (db.query('SELECT count(*) AS n FROM tasks').get() as { n: number }).n;
    db.close();
    expect(rootCount).toBe(1);

    const stray = Bun.file(join(sub, '.genie', 'genie.db'));
    expect(await stray.exists()).toBe(false);
  });
});

describe('task export round-trip', () => {
  test('emits complete state across all 6 tables as JSON', async () => {
    // Seed every table through the state module (the contract), then export.
    const db = openDb({ cwd: repo });
    const board = createBoard(db, 'main-board');
    const a = createTask(db, { title: 'root', boardId: board.id, wish: 'demo', group: 'g1' });
    const b = createTask(db, { title: 'dependent', dependsOn: [a.id] }); // → task_dependencies
    appendStage(db, a.id, 'planned', 'kickoff'); // → stage_log
    createWishGroups(db, 'demo', [{ name: 'g1' }, { name: 'g2', dependsOn: ['g1'] }]); // → wish_groups + meta
    db.close();

    const r = await cli(repo, 'export');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');

    const state = JSON.parse(r.stdout) as StateExport;
    // All 6 tables represented.
    expect(state.schemaVersion).toBe(1);
    expect(state.boards.map((x) => x.name)).toContain('main-board');
    expect(state.tasks.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(state.task_dependencies).toEqual([{ task_id: b.id, depends_on_id: a.id }]);
    expect(state.stage_log.map((x) => x.stage)).toContain('planned');
    expect(state.wish_groups.map((x) => x.name).sort()).toEqual(['g1', 'g2']);
    expect(state.meta.some((m) => m.key === 'wish_sig:demo')).toBe(true);

    // The wish/group columns survive the round-trip on the seeded task.
    const rootRow = state.tasks.find((x) => x.id === a.id);
    expect(rootRow?.wish).toBe('demo');
    expect(rootRow?.group_name).toBe('g1');
  });
});

describe('task import', () => {
  /** Seed a representative slice of every table into `repo`'s db. */
  function seedState(): { rootId: string; depId: string } {
    const db = openDb({ cwd: repo });
    const board = createBoard(db, 'main-board');
    const a = createTask(db, { title: 'root', boardId: board.id, wish: 'demo', group: 'g1' });
    const b = createTask(db, { title: 'dependent', dependsOn: [a.id] });
    appendStage(db, a.id, 'planned', 'kickoff');
    appendTaskEvent(db, a.id, { kind: 'comment', note: 'hello', author: 'tester', authorKind: 'human' });
    createWishGroups(db, 'demo', [{ name: 'g1' }, { name: 'g2', dependsOn: ['g1'] }]);
    db.close();
    return { rootId: a.id, depId: b.id };
  }

  /** A second throwaway git repo simulating the other machine's fresh clone. */
  function makeCloneRepo(): string {
    const clone = mkdtempSync(join(tmpdir(), 'genie-v5-import-'));
    git(clone, 'init', '-b', 'main');
    git(clone, 'commit', '--allow-empty', '-m', 'init');
    return clone;
  }

  test('export --write then import on a fresh repo is a lossless round-trip', async () => {
    seedState();
    const w = await cli(repo, 'export', '--write');
    expect(w.code).toBe(0);
    expect(w.stderr).toBe('');
    const snapshotPath = join(repo, '.genie', 'roadmap.json');
    expect(w.stdout).toContain(snapshotPath);

    const clone = makeCloneRepo();
    try {
      await mkdir(join(clone, '.genie'), { recursive: true });
      const snapshot = readFileSync(snapshotPath, 'utf-8');
      writeFileSync(join(clone, '.genie', 'roadmap.json'), snapshot);

      const r = await cli(clone, 'import');
      expect(r.code).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toMatch(/Imported 2 tasks, 1 boards, 1 dependencies/);

      // Byte-identical state: re-exporting the clone reproduces the snapshot.
      const reExport = await cli(clone, 'export');
      expect(reExport.code).toBe(0);
      expect(JSON.parse(reExport.stdout)).toEqual(JSON.parse(snapshot));
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  test('refuses a database that already holds state, and --replace overwrites it', async () => {
    seedState();
    const w = await cli(repo, 'export', '--write');
    expect(w.code).toBe(0);

    // Same repo, same db: state exists, plain import must refuse.
    const refused = await cli(repo, 'import');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('--replace');

    // Diverge the local db, then restore the snapshot wholesale.
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'local-only drift' });
    db.close();
    const replaced = await cli(repo, 'import', '--replace');
    expect(replaced.code).toBe(0);
    expect(replaced.stdout).toMatch(/Imported 2 tasks/);
    const after = openDb({ cwd: repo });
    const titles = (after.query('SELECT title FROM tasks ORDER BY title').all() as Array<{ title: string }>).map(
      (t) => t.title,
    );
    after.close();
    expect(titles).toEqual(['dependent', 'root']);
  });

  test('missing snapshot and schemaVersion mismatch both fail with clear stderr', async () => {
    const missing = await cli(repo, 'import');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('Snapshot not found');
    expect(missing.stderr).toContain('export --write');

    await mkdir(join(repo, '.genie'), { recursive: true });
    const empty: StateExport = {
      schemaVersion: 999,
      meta: [],
      boards: [],
      tasks: [],
      task_dependencies: [],
      stage_log: [],
      task_events: [],
      wish_groups: [],
      hire_roster: [],
    };
    writeFileSync(join(repo, '.genie', 'roadmap.json'), JSON.stringify(empty));
    const mismatch = await cli(repo, 'import');
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain('schemaVersion 999');
  });
});

describe('roadmap.json canonical sync', () => {
  function snapshotOf(dir: string): string {
    return readFileSync(join(dir, '.genie', 'roadmap.json'), 'utf-8');
  }

  async function plantSnapshot(dir: string, snapshot: string): Promise<void> {
    await mkdir(join(dir, '.genie'), { recursive: true });
    writeFileSync(join(dir, '.genie', 'roadmap.json'), snapshot);
  }

  test('fresh clone: any task command materializes the board from the snapshot', async () => {
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'canonical card' });
    db.close();
    const published = await cli(repo, 'sync');
    expect(published.code).toBe(0);
    expect(published.stdout).toContain('Published board snapshot');

    const clone = mkdtempSync(join(tmpdir(), 'genie-v5-sync-'));
    try {
      git(clone, 'init', '-b', 'main');
      git(clone, 'commit', '--allow-empty', '-m', 'init');
      await plantSnapshot(clone, snapshotOf(repo));

      // No genie.db exists in the clone yet: `task list` must auto-import.
      const r = await cli(clone, 'list');
      expect(r.code).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toContain('canonical card');
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  test('pulled snapshot auto-imports; local mutation auto-exports; divergence is refused then resolvable', async () => {
    // Machine A (repo): publish F1, then F2 with one more card.
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'first card' });
    db.close();
    await cli(repo, 'sync');
    const f1 = snapshotOf(repo);
    const db2 = openDb({ cwd: repo });
    createTask(db2, { title: 'second card' });
    db2.close();
    await cli(repo, 'sync');
    const f2 = snapshotOf(repo);

    // Machine B (clone): start from F1.
    const clone = mkdtempSync(join(tmpdir(), 'genie-v5-sync-'));
    try {
      git(clone, 'init', '-b', 'main');
      git(clone, 'commit', '--allow-empty', '-m', 'init');
      await plantSnapshot(clone, f1);
      await cli(clone, 'list'); // materialize + baseline

      // Simulated pull: F2 arrives while B's db is untouched → auto-import.
      writeFileSync(join(clone, '.genie', 'roadmap.json'), f2);
      const pulled = await cli(clone, 'list');
      expect(pulled.stderr).toBe('');
      expect(pulled.stdout).toContain('second card');

      // Local mutation on B → db ahead → sync exports.
      const created = await cli(clone, 'create', '--title', 'b-only card');
      expect(created.code).toBe(0);
      const exported = await cli(clone, 'sync');
      expect(exported.code).toBe(0);
      expect(snapshotOf(clone)).toContain('b-only card');

      // Divergence: local db mutates AND a foreign snapshot lands → refuse both ways.
      await cli(clone, 'create', '--title', 'b-diverging card');
      writeFileSync(join(clone, '.genie', 'roadmap.json'), f2);
      const diverged = await cli(clone, 'sync');
      expect(diverged.code).toBe(1);
      expect(diverged.stdout).toContain('Nothing was overwritten');
      expect(snapshotOf(clone)).toBe(f2); // snapshot untouched
      const listed = await cli(clone, 'list');
      expect(listed.stderr).toContain('warn:'); // ordinary commands warn…
      expect(listed.stdout).toContain('b-diverging card'); // …and keep local state

      // Resolution: take the snapshot wholesale.
      const resolved = await cli(clone, 'import', '--replace');
      expect(resolved.code).toBe(0);
      const settled = await cli(clone, 'sync');
      expect(settled.code).toBe(0);
      const after = await cli(clone, 'list');
      expect(after.stderr).toBe('');
      expect(after.stdout).not.toContain('b-diverging card');
      expect(after.stdout).toContain('second card');
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});

// Same subprocess invocation as `cli`, but with extra env vars layered on — used
// to prove runtime identity flows from the environment into the stored event.
async function cliEnv(cwd: string, env: Record<string, string>, ...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(['bun', GENIE, 'task', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', GENIE_TEST_SKIP_PGSERVE: '1', ...env },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

describe('timeline verbs', () => {
  async function seed(title: string): Promise<string> {
    const db = openDb({ cwd: repo });
    const task = createTask(db, { title });
    db.close();
    return task.id;
  }

  test('comment appends an authored comment event', async () => {
    const id = await seed('chatty');
    const r = await cli(repo, 'comment', id, 'looks good to me');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');

    const db = openDb({ cwd: repo });
    const events = getTaskEvents(db, id);
    db.close();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('comment');
    expect(events[0].note).toBe('looks good to me');
  });

  test('comment on an unknown id fails with exit 1', async () => {
    const r = await cli(repo, 'comment', 't_nope', 'x');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Task not found: t_nope');
  });

  test('report appends a report event tagged with the runtime kind', async () => {
    const id = await seed('meeseeks');
    const r = await cliEnv(repo, { GENIE_AGENT_NAME: 'eng-B', CLAUDECODE: '1' }, 'report', id, 'implemented + tested');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('claude-code');

    const db = openDb({ cwd: repo });
    const events = getTaskEvents(db, id);
    db.close();
    expect(events[0].kind).toBe('report');
    expect(events[0].note).toBe('implemented + tested');
    expect(events[0].author).toBe('eng-B');
    expect(events[0].authorKind).toBe('claude-code');
  });

  test('author + runtime kind flow from env into the stored event (CLI boundary)', async () => {
    const id = await seed('provenance');
    // Codex runtime marker + agent identity → stored verbatim on the event.
    // Clear any inherited Claude Code markers so the Codex signal is what resolves.
    await cliEnv(
      repo,
      { GENIE_AGENT_NAME: 'codex-worker', CODEX_THREAD_ID: 'thr_123', CLAUDECODE: '', CLAUDE_CODE: '' },
      'comment',
      id,
      'from codex',
    );
    const db = openDb({ cwd: repo });
    const ev = getTaskEvents(db, id)[0];
    db.close();
    expect(ev.author).toBe('codex-worker');
    expect(ev.authorKind).toBe('codex');
  });

  test('GENIE_AGENT_KIND overrides inferred runtime', async () => {
    const id = await seed('override');
    await cliEnv(repo, { GENIE_AGENT_NAME: 'x', CLAUDECODE: '1', GENIE_AGENT_KIND: 'hermes' }, 'comment', id, 'hi');
    const db = openDb({ cwd: repo });
    const ev = getTaskEvents(db, id)[0];
    db.close();
    expect(ev.authorKind).toBe('hermes');
  });

  test('heartbeat records a liveness pulse', async () => {
    const id = await seed('pulse');
    const before = Date.now();
    const r = await cli(repo, 'heartbeat', id);
    expect(r.code).toBe(0);
    const db = openDb({ cwd: repo });
    const card = getTaskCard(db, id);
    db.close();
    expect(card?.heartbeatAt).toBeGreaterThanOrEqual(before);
  });
});

describe('enforced blocks — the carved checkout exception', () => {
  async function seed(title: string): Promise<string> {
    const db = openDb({ cwd: repo });
    const task = createTask(db, { title });
    db.close();
    return task.id;
  }

  test('block then checkout refuses with exit 1 and the reason on stderr', async () => {
    const id = await seed('blocked card');
    const blocked = await cli(repo, 'block', id, '--reason', 'awaiting design review');
    expect(blocked.code).toBe(0);

    const co = await cli(repo, 'checkout', id, '--worker', 'w1');
    expect(co.code).toBe(1);
    expect(co.stdout).toBe('');
    expect(co.stderr).toContain('awaiting design review');
    expect(co.stderr).toContain('blocked');

    // The refusal never claimed the card.
    const db = openDb({ cwd: repo });
    expect(getTask(db, id)?.claimedBy).toBeNull();
    db.close();
  });

  test('block requires --reason', async () => {
    const id = await seed('needs reason');
    const r = await cli(repo, 'block', id);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--reason');
  });

  test('unblock restores checkout', async () => {
    const id = await seed('unblock me');
    await cli(repo, 'block', id, '--reason', 'hold');
    const un = await cli(repo, 'unblock', id);
    expect(un.code).toBe(0);
    const co = await cli(repo, 'checkout', id, '--worker', 'w1');
    expect(co.code).toBe(0);
    expect(co.stdout).toContain('in_progress');
  });

  test('release returns a claimed card to ready', async () => {
    const id = await seed('release me');
    await cli(repo, 'checkout', id, '--worker', 'w1');
    const rel = await cli(repo, 'release', id);
    expect(rel.code).toBe(0);
    expect(rel.stdout).toContain('ready');

    const db = openDb({ cwd: repo });
    expect(getTask(db, id)?.status).toBe('ready');
    expect(getTaskEvents(db, id).some((e) => e.kind === 'release')).toBe(true);
    db.close();
  });
});

describe('checkout reassignment briefing + status timeline', () => {
  test('a checkout of a card with prior events prints the timeline briefing', async () => {
    const db = openDb({ cwd: repo });
    const task = createTask(db, { title: 'reassigned' });
    appendTaskEvent(db, task.id, {
      kind: 'comment',
      note: 'first runtime was here',
      author: 'eng-A',
      authorKind: 'codex',
    });
    db.close();

    const r = await cli(repo, 'checkout', task.id, '--worker', 'eng-B');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('reassignment briefing');
    expect(r.stdout).toContain('first runtime was here');
    expect(r.stdout).toContain('eng-A');
  });

  test('a checkout of a pristine card prints NO briefing', async () => {
    const db = openDb({ cwd: repo });
    const task = createTask(db, { title: 'pristine' });
    db.close();
    const r = await cli(repo, 'checkout', task.id, '--worker', 'w1');
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('reassignment briefing');
  });

  test('task status renders a Timeline section with authored events', async () => {
    const db = openDb({ cwd: repo });
    const task = createTask(db, { title: 'timelined' });
    appendTaskEvent(db, task.id, { kind: 'comment', note: 'a note', author: 'felipe', authorKind: 'human' });
    db.close();

    const r = await cli(repo, 'status', task.id);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Timeline:');
    expect(r.stdout).toContain('comment by felipe');
    expect(r.stdout).toContain('a note');
  });
});
