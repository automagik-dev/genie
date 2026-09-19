/**
 * genie task — CLI-level tests. Each case invokes the real `genie.ts` entry
 * as a user would (subprocess), against a throwaway git-repo fixture, and
 * asserts exit code AND stderr, not just stdout.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORCA_REFUSAL_MESSAGE } from '../lib/orchestration-mode.js';
import { CURRENT_SCHEMA_VERSION, openDb, resolveDbPath } from '../lib/v5/genie-db.js';
import { serializeSnapshot } from '../lib/v5/roadmap-sync.js';
import {
  DEFAULT_LIFECYCLE_LANES,
  type StateExport,
  appendStage,
  appendTaskEvent,
  createBoard,
  createTask,
  getTask,
  getTaskCard,
  getTaskEvents,
  getTaskLane,
  listTasks,
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

/**
 * Like cli() but with a fully controlled identity env: strips every GENIE_AGENT_*
 * var from the inherited environment, then applies `env` overrides. Required to
 * exercise the default no-env flow (claimed_by 'cli' → author 'cli') and to
 * simulate a claimed-by-other refusal without ambient CI env leaking in.
 */
async function cliIdentity(cwd: string, env: Record<string, string>, ...args: string[]): Promise<CliResult> {
  const base: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', GENIE_TEST_SKIP_PGSERVE: '1' };
  for (const key of Object.keys(base)) {
    if (key.startsWith('GENIE_AGENT_')) delete base[key];
  }
  const proc = Bun.spawn(['bun', GENIE, 'task', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...base, ...env },
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

  test('creates a task with a declared assignment and persists both halves', async () => {
    const r = await cli(repo, 'create', '--title', 'routed', '--agent', 'claude', '--why', 'owns the parser');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/Created task t_\w+ "routed" \(ready\)\./);
    const id = /Created task (t_\w+)/.exec(r.stdout)?.[1] as string;

    const db = openDb({ cwd: repo });
    const task = getTask(db, id);
    db.close();
    expect(task?.assignedAgent).toBe('claude');
    expect(task?.assignedReason).toBe('owns the parser');

    const status = await cli(repo, 'status', id);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('Assigned to: claude — owns the parser');
  });

  test('rejects a non-roster agent, naming the allowed roster in stderr', async () => {
    const r = await cli(repo, 'create', '--title', 'rogue', '--agent', 'kimi', '--why', 'wants in');
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Unknown agent "kimi"');
    expect(r.stderr).toContain('not in the roster');
    expect(r.stderr).toContain('claude, codex, pi, hermes, prime');
  });

  test('rejects a half-written assignment either way round (Decision 3 pair invariant)', async () => {
    const agentOnly = await cli(repo, 'create', '--title', 'half', '--agent', 'claude');
    expect(agentOnly.code).toBe(1);
    expect(agentOnly.stdout).toBe('');
    expect(agentOnly.stderr).toContain('Assignment requires both halves');

    const whyOnly = await cli(repo, 'create', '--title', 'half', '--why', 'no agent');
    expect(whyOnly.code).toBe(1);
    expect(whyOnly.stdout).toBe('');
    expect(whyOnly.stderr).toContain('Assignment requires both halves');

    // Nothing was written by the rejected attempts.
    const db = openDb({ cwd: repo });
    expect(listTasks(db)).toEqual([]);
    db.close();
  });
});

describe('task link', () => {
  test('links an existing card without creating the absent wish, preserving other state and appending one authored wish event', async () => {
    const db = openDb({ cwd: repo });
    const board = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const task = createTask(db, { title: 'existing card', boardId: board.id, lane: 'Idea' });
    db.query(
      `UPDATE tasks
       SET status = 'in_progress', claimed_by = 'worker-1', claimed_at = 1000,
           agent_kind = 'codex', heartbeat_at = 2000,
           blocked_by = 'operator', blocked_reason = 'hold'
       WHERE id = ?`,
    ).run(task.id);
    appendTaskEvent(db, task.id, {
      kind: 'comment',
      note: 'exact timeline bytes: → ç',
      author: 'operator',
      authorKind: 'human',
    });
    const beforeRow = db.query('SELECT * FROM tasks WHERE id = ?').get(task.id) as Record<string, unknown>;
    const beforeEvents = JSON.stringify(getTaskEvents(db, task.id));
    db.close();

    const r = await cliIdentity(
      repo,
      { GENIE_AGENT_NAME: 'linker', GENIE_AGENT_KIND: 'codex' },
      'link',
      task.id,
      '--wish',
      'absent-wish',
      '--group',
      'group-2',
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(`Linked task ${task.id} to wish absent-wish#group-2.\n`);
    expect(existsSync(join(repo, '.genie', 'wishes', 'absent-wish', 'WISH.md'))).toBe(false);

    const linkedDb = openDb({ cwd: repo });
    const afterRow = linkedDb.query('SELECT * FROM tasks WHERE id = ?').get(task.id) as Record<string, unknown>;
    expect(afterRow.wish).toBe('absent-wish');
    expect(afterRow.group_name).toBe('group-2');
    for (const key of Object.keys(beforeRow)) {
      if (key === 'wish' || key === 'group_name' || key === 'updated_at') continue;
      expect(afterRow[key]).toEqual(beforeRow[key]);
    }
    const afterEvents = getTaskEvents(linkedDb, task.id);
    expect(JSON.stringify(afterEvents.slice(0, -1))).toBe(beforeEvents);
    const linkEvent = afterEvents[afterEvents.length - 1];
    expect(linkEvent.kind).toBe('wish');
    expect(linkEvent.note).toBe('(none)→absent-wish#group-2');
    expect(linkEvent.author).toBe('linker');
    expect(linkEvent.authorKind).toBe('codex');
    linkedDb.close();
  });

  test('repeating an identical link is a true no-op', async () => {
    const db = openDb({ cwd: repo });
    const task = createTask(db, { title: 'idempotent link' });
    db.close();

    const first = await cli(repo, 'link', task.id, '--wish', 'same-wish', '--group', 'same-group');
    expect(first.code).toBe(0);
    expect(first.stderr).toBe('');

    const sentinelDb = openDb({ cwd: repo });
    sentinelDb.query('UPDATE tasks SET updated_at = 1234 WHERE id = ?').run(task.id);
    const beforeEvents = JSON.stringify(getTaskEvents(sentinelDb, task.id));
    sentinelDb.close();

    const repeated = await cli(repo, 'link', task.id, '--wish', 'same-wish', '--group', 'same-group');
    expect(repeated.code).toBe(0);
    expect(repeated.stderr).toBe('');
    expect(repeated.stdout).toBe(`Linked task ${task.id} to wish same-wish#same-group.\n`);

    const linkedDb = openDb({ cwd: repo });
    expect(getTask(linkedDb, task.id)?.updatedAt).toBe(1_234);
    expect(JSON.stringify(getTaskEvents(linkedDb, task.id))).toBe(beforeEvents);
    linkedDb.close();
  });

  test('omitting --group clears a prior group association', async () => {
    const db = openDb({ cwd: repo });
    const task = createTask(db, { title: 'relink me', wish: 'old-wish', group: 'old-group' });
    db.close();

    const r = await cli(repo, 'link', task.id, '--wish', 'new-wish');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');

    const linkedDb = openDb({ cwd: repo });
    expect(getTask(linkedDb, task.id)?.wish).toBe('new-wish');
    expect(getTask(linkedDb, task.id)?.group).toBeNull();
    linkedDb.close();
  });

  test('rejects a missing task and invalid wish/group arguments', async () => {
    const missing = await cli(repo, 'link', 't_missing', '--wish', 'demo');
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('Task not found: t_missing');

    const noWish = await cli(repo, 'link', 't_missing');
    expect(noWish.code).toBe(1);
    expect(noWish.stdout).toBe('');
    expect(noWish.stderr).toContain("required option '--wish <slug>' not specified");

    const emptyWish = await cli(repo, 'link', 't_missing', '--wish', '   ');
    expect(emptyWish.code).toBe(1);
    expect(emptyWish.stdout).toBe('');
    expect(emptyWish.stderr).toContain('--wish is required and must not be empty');

    const emptyGroup = await cli(repo, 'link', 't_missing', '--wish', 'demo', '--group', '   ');
    expect(emptyGroup.code).toBe(1);
    expect(emptyGroup.stdout).toBe('');
    expect(emptyGroup.stderr).toContain('--group must not be empty');
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

  test('--json stays on the frozen pre-assignment shape even for an assigned card', async () => {
    await cli(repo, 'create', '--title', 'routed', '--agent', 'codex', '--why', 'dissent on parser');
    const r = await cli(repo, 'list', '--json');
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual([
      'boardId',
      'claimedAt',
      'claimedBy',
      'createdAt',
      'group',
      'id',
      'status',
      'title',
      'updatedAt',
      'wish',
    ]);
    for (const leaked of ['assignedAgent', 'assignedReason']) {
      expect(leaked in rows[0]).toBe(false);
    }
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

  /**
   * Regression (dogfood r5 Z7): `task status` printed Status/Board/Created/
   * Updated and the timeline but no lane at all, so the only way to learn where
   * a card sat was `genie board --json` or reading its move events. The lane it
   * prints is the placement the board RENDERS: an unplaced card on a
   * lane-defining board falls into the first lane, exactly as groupByLane does.
   */
  test('status shows the lane the card sits in, matching the board render', async () => {
    const db = openDb({ cwd: repo });
    const board = createBoard(db, 'dogfood', DEFAULT_LIFECYCLE_LANES);
    const placed = createTask(db, { title: 'placed card', boardId: board.id });
    const unplaced = createTask(db, { title: 'unplaced card', boardId: board.id });
    const loose = createTask(db, { title: 'loose card' });
    db.close();

    const moved = await cli(repo, 'move', placed.id, '--to', 'Review');
    expect(moved.stderr).toBe('');
    expect(moved.code).toBe(0);

    const onLane = await cli(repo, 'status', placed.id);
    expect(onLane.code).toBe(0);
    expect(onLane.stdout).toContain('Lane:       Review');

    // The board is the oracle: status must name the lane the JSON reports.
    const boardJson = Bun.spawnSync(['bun', GENIE, 'board', '--board', 'dogfood', '--json'], {
      cwd: repo,
      env: { ...process.env, NO_COLOR: '1' },
    });
    const lanes = JSON.parse(boardJson.stdout.toString()).lanes as Array<{
      name: string;
      cards: Array<{ id: string }>;
    }>;
    const renderedLane = lanes.find((lane) => lane.cards.some((card) => card.id === placed.id))?.name;
    expect(renderedLane).toBe('Review');

    // Never moved: the board renders it in the first lane, and so does status.
    const first = DEFAULT_LIFECYCLE_LANES[0].name;
    const neverMoved = await cli(repo, 'status', unplaced.id);
    expect(neverMoved.code).toBe(0);
    expect(neverMoved.stdout).toContain(`Lane:       ${first} (default`);
    expect(lanes.find((lane) => lane.cards.some((card) => card.id === unplaced.id))?.name).toBe(first);

    // A card on no board has no lane to report, and gains no empty line.
    const noBoard = await cli(repo, 'status', loose.id);
    expect(noBoard.code).toBe(0);
    expect(noBoard.stdout).not.toContain('Lane:');
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

  test('default CLI flow: no-env checkout claims as cli and no-env done completes it', async () => {
    const id = await seedTask('cli default flow');
    const claimed = await cliIdentity(repo, {}, 'checkout', id);
    expect(claimed.code).toBe(0);
    expect(claimed.stdout).toContain('in_progress');

    // The unified resolver floors at 'cli' with no env — the claim records that
    // identity, and the no-env done completes it.
    const db = openDb({ cwd: repo });
    const card = getTaskCard(db, id);
    db.close();
    expect(card?.claimedBy).toBe('cli');

    const done = await cliIdentity(repo, {}, 'done', id);
    expect(done.code).toBe(0);
    expect(done.stdout).toContain('marked done');
  });

  test('done by a different identity than the claimant succeeds (orchestrator flow)', async () => {
    const id = await seedTask('worker claim, orchestrator completion');
    const claimed = await cliIdentity(repo, { GENIE_AGENT_NAME: 'w1' }, 'checkout', id);
    expect(claimed.code).toBe(0);

    // The documented two-actor flow: the worker claims via checkout, the
    // orchestrator (a different identity) marks reviewed work done.
    const done = await cliIdentity(repo, { GENIE_AGENT_NAME: 'orchestrator' }, 'done', id);
    expect(done.code).toBe(0);
    expect(done.stdout).toContain('marked done');

    const db = openDb({ cwd: repo });
    const card = getTaskCard(db, id);
    db.close();
    expect(card?.status).toBe('done');
  });
});

describe('task set-wish', () => {
  async function seedTask(title: string, wish?: string, group?: string): Promise<string> {
    const db = openDb({ cwd: repo });
    const task = createTask(db, { title, wish, group });
    db.close();
    return task.id;
  }

  test('attaches a wish, preserving id/createdAt while advancing updatedAt', async () => {
    const id = await seedTask('wishless');
    const before = openDb({ cwd: repo });
    const created = getTask(before, id);
    before.close();

    const r = await cli(repo, 'set-wish', id, '--wish', 'remotty-board-asks', '--group', 'task-wish-verb');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('(none) → remotty-board-asks#task-wish-verb');

    const db = openDb({ cwd: repo });
    const after = getTask(db, id);
    const events = getTaskEvents(db, id);
    db.close();
    expect(after?.id).toBe(id);
    expect(after?.createdAt).toBe(created?.createdAt as number);
    expect(after?.wish).toBe('remotty-board-asks');
    expect(after?.group).toBe('task-wish-verb');
    expect(after?.updatedAt).toBeGreaterThan(created?.updatedAt as number);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('wish');
    expect(events[0].note).toBe('(none)→remotty-board-asks#task-wish-verb');
  });

  test('the wish event is visible in task status, and list --wish finds the card', async () => {
    const id = await seedTask('findable');
    await cli(repo, 'set-wish', id, '--wish', 'demo');

    const status = await cli(repo, 'status', id);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('Timeline:');
    expect(status.stdout).toContain('wish by');
    expect(status.stdout).toContain('(none)→demo');

    const list = await cli(repo, 'list', '--wish', 'demo');
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(id);
  });

  test('--clear removes the wish and the group together', async () => {
    const id = await seedTask('attached', 'demo', 'g1');
    const r = await cli(repo, 'set-wish', id, '--clear');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('demo#g1 → (none)');

    const db = openDb({ cwd: repo });
    const after = getTask(db, id);
    db.close();
    expect(after?.wish).toBeNull();
    expect(after?.group).toBeNull();
  });

  test('--clear on an already-wishless card is a silent no-op', async () => {
    const id = await seedTask('never attached');
    const before = openDb({ cwd: repo });
    const created = getTask(before, id);
    before.close();

    const r = await cli(repo, 'set-wish', id, '--clear');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');

    const db = openDb({ cwd: repo });
    const after = getTask(db, id);
    const events = getTaskEvents(db, id);
    db.close();
    expect(after?.wish).toBeNull();
    expect(after?.updatedAt).toBe(created?.updatedAt as number);
    expect(events).toHaveLength(0);

    const status = await cli(repo, 'status', id);
    expect(status.stdout).not.toContain('(none)→(none)');
  });

  test('a claimed card keeps its claim across the identity change', async () => {
    const id = await seedTask('claimed');
    await cli(repo, 'checkout', id, '--worker', 'w1');
    const r = await cli(repo, 'set-wish', id, '--wish', 'demo');
    expect(r.code).toBe(0);

    const db = openDb({ cwd: repo });
    const after = getTask(db, id);
    db.close();
    expect(after?.status).toBe('in_progress');
    expect(after?.claimedBy).toBe('w1');
  });

  test('--group without --wish fails with the same message as create', async () => {
    const id = await seedTask('guarded');
    const r = await cli(repo, 'set-wish', id, '--group', 'g1');
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--group requires --wish.');
  });

  test('neither --wish nor --clear fails; --clear with --wish is refused', async () => {
    const id = await seedTask('ambiguous');
    const bare = await cli(repo, 'set-wish', id);
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain('--wish <slug> or --clear is required.');

    const both = await cli(repo, 'set-wish', id, '--clear', '--wish', 'demo');
    expect(both.code).toBe(1);
    expect(both.stderr).toContain('--clear cannot be combined with --wish.');
  });

  test('an unknown id fails with exit 1 and a typed error', async () => {
    const r = await cli(repo, 'set-wish', 't_nope', '--wish', 'demo');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Task not found: t_nope');
  });

  test('the attached identity survives export --write / import / sync', async () => {
    const id = await seedTask('travels');
    await cli(repo, 'set-wish', id, '--wish', 'demo', '--group', 'g1');

    const w = await cli(repo, 'export', '--write');
    expect(w.code).toBe(0);
    const snapshotPath = join(repo, '.genie', 'roadmap.json');
    const snapshot = readFileSync(snapshotPath, 'utf-8');
    const state = JSON.parse(snapshot) as StateExport;
    expect(state.tasks.find((t) => t.id === id)?.wish).toBe('demo');
    expect(state.tasks.find((t) => t.id === id)?.group_name).toBe('g1');

    // A fresh clone materializes the same identity from the committed snapshot.
    const clone = mkdtempSync(join(tmpdir(), 'genie-v5-setwish-'));
    try {
      git(clone, 'init', '-b', 'main');
      git(clone, 'commit', '--allow-empty', '-m', 'init');
      await mkdir(join(clone, '.genie'), { recursive: true });
      writeFileSync(join(clone, '.genie', 'roadmap.json'), snapshot);

      const imported = await cli(clone, 'import');
      expect(imported.code).toBe(0);
      const db = openDb({ cwd: clone });
      const restored = getTask(db, id);
      const events = getTaskEvents(db, id);
      db.close();
      expect(restored?.wish).toBe('demo');
      expect(restored?.group).toBe('g1');
      expect(events.map((e) => e.kind)).toEqual(['wish']);

      // sync sees the pair as already reconciled — no divergence from the change.
      const synced = await cli(clone, 'sync');
      expect(synced.code).toBe(0);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});

describe('task assign', () => {
  async function seedTask(title: string, dependsOn?: string[]): Promise<string> {
    const db = openDb({ cwd: repo });
    const task = createTask(db, { title, dependsOn });
    db.close();
    return task.id;
  }

  test('declares an assignment, appends one assign event, and shows it in status', async () => {
    const id = await seedTask('route me');
    const r = await cli(repo, 'assign', id, '--agent', 'codex', '--why', 'dissent on the parser');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(`Assigned task ${id} to codex: dissent on the parser.\n`);

    const db = openDb({ cwd: repo });
    const task = getTask(db, id);
    const events = getTaskEvents(db, id);
    db.close();
    expect(task?.assignedAgent).toBe('codex');
    expect(task?.assignedReason).toBe('dissent on the parser');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('assign');
    expect(events[0].note).toBe('assigned to codex: dissent on the parser');

    const status = await cli(repo, 'status', id);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('Assigned to: codex — dissent on the parser');
    expect(status.stdout).toContain('Timeline:');
    expect(status.stdout).toContain('assign by');
    expect(status.stdout).toContain('assigned to codex: dissent on the parser');
  });

  test('overwrites a prior assignment, keeping both notes on the timeline', async () => {
    const id = await seedTask('reassign me');
    const first = await cli(repo, 'assign', id, '--agent', 'codex', '--why', 'first opinion');
    expect(first.code).toBe(0);

    const r = await cli(repo, 'assign', id, '--agent', 'hermes', '--why', 'second opinion');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`Assigned task ${id} to hermes: second opinion.\n`);

    const db = openDb({ cwd: repo });
    const task = getTask(db, id);
    const events = getTaskEvents(db, id);
    db.close();
    expect(task?.assignedAgent).toBe('hermes');
    expect(task?.assignedReason).toBe('second opinion');
    expect(events.map((e) => e.kind)).toEqual(['assign', 'assign']);
    expect(events.map((e) => e.note)).toEqual([
      'assigned to codex: first opinion',
      'assigned to hermes: second opinion',
    ]);
  });

  test('re-assigning the exact stored pair is a silent no-op (set-wish precedent)', async () => {
    const id = await seedTask('idempotent assign');
    await cli(repo, 'assign', id, '--agent', 'pi', '--why', 'cost arbitrage');

    const sentinelDb = openDb({ cwd: repo });
    sentinelDb.query('UPDATE tasks SET updated_at = 1234 WHERE id = ?').run(id);
    const beforeEvents = JSON.stringify(getTaskEvents(sentinelDb, id));
    sentinelDb.close();

    const r = await cli(repo, 'assign', id, '--agent', 'pi', '--why', 'cost arbitrage');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');

    const db = openDb({ cwd: repo });
    expect(getTask(db, id)?.updatedAt).toBe(1_234);
    expect(JSON.stringify(getTaskEvents(db, id))).toBe(beforeEvents);
    db.close();
  });

  test('--clear removes both halves and appends a clear event naming the prior pair', async () => {
    const id = await seedTask('unroute me');
    await cli(repo, 'assign', id, '--agent', 'codex', '--why', 'dissent on parser');

    const r = await cli(repo, 'assign', id, '--clear');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(`Cleared assignment on task ${id}.\n`);

    const db = openDb({ cwd: repo });
    const task = getTask(db, id);
    const events = getTaskEvents(db, id);
    db.close();
    expect(task?.assignedAgent).toBeNull();
    expect(task?.assignedReason).toBeNull();
    expect(events.map((e) => e.kind)).toEqual(['assign', 'clear']);
    expect(events[1].note).toBe('assignment cleared (was codex: dissent on parser)');

    const status = await cli(repo, 'status', id);
    expect(status.code).toBe(0);
    expect(status.stdout).not.toContain('Assigned to:');
    expect(status.stdout).toContain('clear by');
    expect(status.stdout).toContain('assignment cleared (was codex: dissent on parser)');
  });

  test('--clear on an already-unassigned card is a silent no-op', async () => {
    const id = await seedTask('never assigned');
    const before = openDb({ cwd: repo });
    const created = getTask(before, id);
    before.close();

    const r = await cli(repo, 'assign', id, '--clear');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');

    const db = openDb({ cwd: repo });
    const after = getTask(db, id);
    const events = getTaskEvents(db, id);
    db.close();
    expect(after?.assignedAgent).toBeNull();
    expect(after?.updatedAt).toBe(created?.updatedAt as number);
    expect(events).toHaveLength(0);
  });

  test('--clear combined with --agent or --why is refused', async () => {
    const id = await seedTask('ambiguous assign');
    const withAgent = await cli(repo, 'assign', id, '--clear', '--agent', 'claude');
    expect(withAgent.code).toBe(1);
    expect(withAgent.stdout).toBe('');
    expect(withAgent.stderr).toContain('--clear cannot be combined with --agent or --why.');

    const withWhy = await cli(repo, 'assign', id, '--clear', '--why', 'x');
    expect(withWhy.code).toBe(1);
    expect(withWhy.stderr).toContain('--clear cannot be combined with --agent or --why.');
  });

  test('works at any card status — claimed, done, and blocked (declaration only)', async () => {
    const claimed = await seedTask('claimed card');
    expect((await cli(repo, 'checkout', claimed, '--worker', 'w1')).code).toBe(0);
    const claimedAssign = await cli(repo, 'assign', claimed, '--agent', 'claude', '--why', 'takes over the claim');
    expect(claimedAssign.code).toBe(0);
    const claimedDb = openDb({ cwd: repo });
    expect(getTask(claimedDb, claimed)?.assignedAgent).toBe('claude');
    expect(getTask(claimedDb, claimed)?.status).toBe('in_progress');
    expect(getTask(claimedDb, claimed)?.claimedBy).toBe('w1');
    claimedDb.close();

    const done = await seedTask('done card');
    expect((await cli(repo, 'done', done)).code).toBe(0);
    const doneAssign = await cli(repo, 'assign', done, '--agent', 'prime', '--why', 'verify the merge');
    expect(doneAssign.code).toBe(0);
    const doneDb = openDb({ cwd: repo });
    expect(getTask(doneDb, done)?.assignedAgent).toBe('prime');
    expect(getTask(doneDb, done)?.status).toBe('done');
    doneDb.close();

    const upstream = await seedTask('upstream blocker');
    const blocked = await seedTask('blocked card', [upstream]);
    const blockedDb = openDb({ cwd: repo });
    expect(getTask(blockedDb, blocked)?.status).toBe('blocked');
    blockedDb.close();
    const blockedAssign = await cli(repo, 'assign', blocked, '--agent', 'hermes', '--why', 'own the waiting');
    expect(blockedAssign.code).toBe(0);
    const blockedAfter = openDb({ cwd: repo });
    expect(getTask(blockedAfter, blocked)?.assignedAgent).toBe('hermes');
    expect(getTask(blockedAfter, blocked)?.status).toBe('blocked');
    blockedAfter.close();
  });

  test('rejects a non-roster agent, naming the allowed roster in stderr', async () => {
    const id = await seedTask('rogue assign');
    const r = await cli(repo, 'assign', id, '--agent', 'gpt6', '--why', 'wants in');
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Unknown agent "gpt6"');
    expect(r.stderr).toContain('not in the roster');
    expect(r.stderr).toContain('claude, codex, pi, hermes, prime');

    // The failed attempt wrote nothing.
    const db = openDb({ cwd: repo });
    expect(getTask(db, id)?.assignedAgent).toBeNull();
    db.close();
  });

  test('rejects --agent without --why, --why alone, and neither (Decision 3 pair invariant)', async () => {
    const id = await seedTask('half assign');
    const agentOnly = await cli(repo, 'assign', id, '--agent', 'claude');
    expect(agentOnly.code).toBe(1);
    expect(agentOnly.stdout).toBe('');
    expect(agentOnly.stderr).toContain('Assignment requires both halves');

    const whyOnly = await cli(repo, 'assign', id, '--why', 'no agent');
    expect(whyOnly.code).toBe(1);
    expect(whyOnly.stdout).toBe('');
    expect(whyOnly.stderr).toContain('Assignment requires both halves');

    const neither = await cli(repo, 'assign', id);
    expect(neither.code).toBe(1);
    expect(neither.stdout).toBe('');
    expect(neither.stderr).toContain('Assignment requires both halves');

    const db = openDb({ cwd: repo });
    expect(getTask(db, id)?.assignedAgent).toBeNull();
    expect(getTaskEvents(db, id)).toEqual([]);
    db.close();
  });

  test('an unknown id fails with exit 1 and a typed error', async () => {
    const r = await cli(repo, 'assign', 't_nope', '--agent', 'claude', '--why', 'x');
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Task not found: t_nope');
  });
});

describe('task delete', () => {
  async function seedTask(title: string, dependsOn?: string[]): Promise<string> {
    const db = openDb({ cwd: repo });
    const task = createTask(db, { title, dependsOn });
    db.close();
    return task.id;
  }

  test('deletes a leaf card; status on it then fails with not-found', async () => {
    const upstream = await seedTask('upstream');
    const id = await seedTask('mistake', [upstream]);

    const r = await cli(repo, 'delete', id);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain(`Deleted task ${id} "mistake"`);
    expect(r.stdout).toContain('1 dependency edge');
    expect(r.stdout).toContain('genie task sync');

    const gone = await cli(repo, 'status', id);
    expect(gone.code).toBe(1);
    expect(gone.stderr).toContain(`Task not found: ${id}`);

    // The card it depended on survives, and the board no longer lists the card.
    const list = await cli(repo, 'list');
    expect(list.stdout).not.toContain(id);
    expect(list.stdout).toContain('upstream');
  });

  test('a card with dependents is refused by name, and nothing changes', async () => {
    const target = await seedTask('depended-on');
    const dependent = await seedTask('downstream', [target]);

    const r = await cli(repo, 'delete', target);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(`Cannot delete task ${target}`);
    expect(r.stderr).toContain(dependent);
    expect(r.stderr).toContain('1 task depends on it');

    // Both cards, and the edge between them, are untouched.
    const still = await cli(repo, 'status', target);
    expect(still.code).toBe(0);
    const downstream = await cli(repo, 'status', dependent);
    expect(downstream.code).toBe(0);
    expect(downstream.stdout).toContain('Depends on:');
    expect(downstream.stdout).toContain(target);
  });

  test('an unknown id fails with exit 1 and a typed error', async () => {
    const r = await cli(repo, 'delete', 't_missing');
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Task not found: t_missing');
  });

  test('the timeline goes with the card: a recreated card starts clean', async () => {
    const id = await seedTask('typo');
    await cli(repo, 'comment', id, 'wrong wish');
    const db = openDb({ cwd: repo });
    expect(getTaskEvents(db, id)).toHaveLength(1);
    db.close();

    expect((await cli(repo, 'delete', id)).code).toBe(0);
    const after = openDb({ cwd: repo });
    const orphanEvents = after.query('SELECT COUNT(*) AS n FROM task_events').get() as { n: number };
    const orphanDeps = after.query('SELECT COUNT(*) AS n FROM task_dependencies').get() as { n: number };
    after.close();
    expect(orphanEvents.n).toBe(0);
    expect(orphanDeps.n).toBe(0);
  });

  test('help documents the hard delete, the refusal, and the import caveats', async () => {
    const listing = await cli(repo, '--help');
    expect(listing.code).toBe(0);
    expect(listing.stdout).toContain('delete');

    const detail = await cli(repo, 'delete', '--help');
    expect(detail.code).toBe(0);
    expect(detail.stdout).toContain('no archive and no undo');
    expect(detail.stdout).toContain('Refused while another card depends on this one');
    expect(detail.stdout).toContain('task import --replace');
    expect(detail.stdout).toContain('Deleting the LAST card');
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
    // Newlines and tabs are text and survive verbatim, matching the board contract.
    expect((await cli(repo, 'comment', id, 'line one\nline\ttwo')).code).toBe(0);
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
    db.close();

    const r = await cli(repo, 'export');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');

    const state = JSON.parse(r.stdout) as StateExport;
    // All 6 tables represented.
    expect(state.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(state.boards.map((x) => x.name)).toContain('main-board');
    expect(state.tasks.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(state.task_dependencies).toEqual([{ task_id: b.id, depends_on_id: a.id }]);
    expect(state.stage_log.map((x) => x.stage)).toContain('planned');
    // Wish-group machinery is production-dead: export keeps the field, empty.
    expect(state.wish_groups).toEqual([]);
    expect(state.meta.some((m) => m.key.startsWith('wish_sig:'))).toBe(false);

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
    };
    writeFileSync(join(repo, '.genie', 'roadmap.json'), JSON.stringify(empty));
    const mismatch = await cli(repo, 'import');
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain('schemaVersion 999');
  });

  /**
   * Regression (dogfood r2 minors 12/13): a non-scalar used to reach bun:sqlite
   * as `Binding expected string, TypedArray, boolean, number, bigint or null`
   * with no locator, and a string in an INTEGER column imported with exit 0.
   */
  describe('malformed column values', () => {
    /** Export the seeded state, mutate one cell, and re-import with --replace. */
    async function importWithMutation(mutate: (snapshot: StateExport) => void): Promise<CliResult> {
      const snapshotPath = join(repo, '.genie', 'roadmap.json');
      const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as StateExport;
      mutate(snapshot);
      writeFileSync(snapshotPath, JSON.stringify(snapshot));
      return cli(repo, 'import', '--replace');
    }

    beforeEach(async () => {
      seedState();
      expect((await cli(repo, 'export', '--write')).code).toBe(0);
    });

    test('a non-scalar in a TEXT column names the file, table, row and column', async () => {
      const r = await importWithMutation((s) => {
        (s.tasks[0] as unknown as Record<string, unknown>).title = { x: 1 };
      });
      expect(r.code).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain(join(repo, '.genie', 'roadmap.json'));
      expect(r.stderr).toContain('Snapshot table "tasks" row 0');
      expect(r.stderr).toContain('column "title" expects a string, got an object');
      expect(r.stderr).toContain('database was left unchanged');
      expect(r.stderr).not.toContain('Binding expected');
    });

    test('a non-numeric value in an INTEGER column is refused, not silently stored', async () => {
      const r = await importWithMutation((s) => {
        (s.tasks[0] as unknown as Record<string, unknown>).created_at = 'abc';
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('column "created_at" expects an integer, got the string "abc"');

      // Nothing partial landed: the pre-import rows are untouched.
      const db = openDb({ cwd: repo });
      const rows = db.query('SELECT title, typeof(created_at) AS t FROM tasks ORDER BY title').all() as Array<{
        title: string;
        t: string;
      }>;
      db.close();
      expect(rows.map((row) => row.title)).toEqual(['dependent', 'root']);
      expect(rows.every((row) => row.t === 'integer')).toBe(true);
    });

    test('an array in boards.lanes is refused and no partial import lands', async () => {
      const r = await importWithMutation((s) => {
        (s.boards[0] as unknown as Record<string, unknown>).lanes = ['Idea', 'Done'];
        s.tasks = [];
        s.task_dependencies = [];
        s.stage_log = [];
        s.task_events = [];
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('column "lanes" expects a string, got an array');
      // --replace wipes inside the transaction: a rejected snapshot must leave
      // every pre-import row in place.
      const db = openDb({ cwd: repo });
      const counts = db.query('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
      db.close();
      expect(counts.n).toBe(2);
    });
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

  /**
   * Dogfood r7 W2: in a directory that was never `genie init`-ed, sync opened
   * (and thereby CREATED) an empty genie.db, found no snapshot and no state,
   * and printed `Board and snapshot are in sync (none).` with exit 0 — a clean
   * bill indistinguishable from a genuinely reconciled workspace.
   */
  test('a directory with no .genie workspace is refused, never reported in sync', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'genie-v5-noworkspace-'));
    try {
      git(bare, 'init', '-b', 'main');
      git(bare, 'commit', '--allow-empty', '-m', 'init');

      const r = await cli(bare, 'sync');
      expect(r.code).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
      expect(r.stderr).toContain('no Genie workspace');
      expect(r.stderr).toContain('genie init');
      // The refusal must not create the workspace whose absence it reports.
      expect(existsSync(join(bare, '.genie'))).toBe(false);

      // An initialized workspace still reconciles quietly, exit 0.
      await mkdir(join(bare, '.genie'), { recursive: true });
      const initialized = await cli(bare, 'sync');
      expect(initialized.code).toBe(0);
      expect(initialized.stderr).toBe('');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test('fresh clone: one `task sync` materializes the board from the snapshot', async () => {
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

      // No genie.db exists in the clone yet: sync must bootstrap it.
      const synced = await cli(clone, 'sync');
      expect(synced.code).toBe(0);
      expect(synced.stdout).toContain('Board refreshed');
      const r = await cli(clone, 'list');
      expect(r.code).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toContain('canonical card');
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  test('explicit relative canonical path behaves like the default on both export and import', async () => {
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'card' });
    db.close();

    // Every export path emits the same publishable snapshot, whatever the
    // destination spelling, and a backup written off-canonical round-trips.
    const backup = await cli(repo, 'export', '--write', 'backup.json');
    expect(backup.code).toBe(0);
    const backupState = JSON.parse(readFileSync(join(repo, 'backup.json'), 'utf-8')) as StateExport;
    expect(backupState.tasks).toHaveLength(1);

    const restored = await cli(repo, 'import', 'backup.json', '--replace');
    expect(restored.code).toBe(0);

    // The canonical path spelled explicitly (relative) still counts as canonical.
    const w = await cli(repo, 'export', '--write', '.genie/roadmap.json');
    expect(w.code).toBe(0);
    expect((JSON.parse(snapshotOf(repo)) as StateExport).tasks).toHaveLength(1);

    const r = await cli(repo, 'import', '.genie/roadmap.json', '--replace');
    expect(r.code).toBe(0);

    // The explicit spelling also recorded the sync baseline: no divergence.
    const settled = await cli(repo, 'sync');
    expect(settled.code).toBe(0);
  });

  test('imported snapshots with reordered object keys remain in sync', async () => {
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'canonical card' });
    db.close();

    const published = await cli(repo, 'export', '--write');
    expect(published.stderr).toBe('');
    expect(published.code).toBe(0);
    const snapshotPath = join(repo, '.genie', 'roadmap.json');
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as unknown;
    const reorderKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorderKeys);
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .reverse()
            .map(([key, child]) => [key, reorderKeys(child)]),
        );
      }
      return value;
    };
    writeFileSync(snapshotPath, `${JSON.stringify(reorderKeys(snapshot), null, 2)}\n`);

    const imported = await cli(repo, 'import', '--replace');
    expect(imported.code).toBe(0);
    expect(imported.stderr).toBe('');
    const settled = await cli(repo, 'sync');
    expect(settled.code).toBe(0);
    // Still `none` — the reordering is not a change. Sync does normalize the
    // bytes on its way past, which is why the line is not the bare default.
    expect(settled.stdout).toContain('in sync');
    expect(settled.stderr).toBe('');
    const settledBytes = readFileSync(snapshotPath, 'utf-8');
    expect(settledBytes).toBe(serializeSnapshot(JSON.parse(settledBytes)));
  });

  test.each(['content', 'array order'])('sync detects changed %s after a canonical baseline', async (change) => {
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'first card' });
    createTask(db, { title: 'second card' });
    db.close();
    const published = await cli(repo, 'export', '--write');
    expect(published.code).toBe(0);
    expect(published.stderr).toBe('');

    const snapshotPath = join(repo, '.genie', 'roadmap.json');
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as StateExport;
    if (change === 'content') snapshot.tasks[0].title = 'changed card';
    else snapshot.tasks.reverse();
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

    const synced = await cli(repo, 'sync');
    expect(synced.code).toBe(0);
    expect(synced.stderr).toBe('');
    expect(synced.stdout).toContain('Board refreshed');
    const imported = openDb({ cwd: repo });
    try {
      expect(getTask(imported, snapshot.tasks[0].id)?.title).toBe(snapshot.tasks[0].title);
    } finally {
      imported.close();
    }
  });

  test('a subdirectory spelling of roadmap.json is written, but is not the canonical baseline', async () => {
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'card' });
    db.close();
    await mkdir(join(repo, 'src', '.genie'), { recursive: true });

    // Same relative spelling, different cwd: it resolves to src/.genie/roadmap.json,
    // NOT the canonical repo-root file.
    const w = await cli(join(repo, 'src'), 'export', '--write', '.genie/roadmap.json');
    expect(w.code).toBe(0);
    expect(w.stderr).toBe('');
    const written = readFileSync(join(repo, 'src', '.genie', 'roadmap.json'), 'utf-8');
    expect((JSON.parse(written) as StateExport).tasks).toHaveLength(1);

    // And it did not stamp the sync baseline: the canonical file is still
    // unpublished, so sync publishes it instead of reporting an in-sync pair.
    const synced = await cli(repo, 'sync');
    expect(synced.code).toBe(0);
    expect(synced.stdout).toContain('Published board snapshot');
    expect((JSON.parse(snapshotOf(repo)) as StateExport).tasks).toHaveLength(1);
  });

  test('a deleted card is republished away by the EXISTING export branch and stays gone', async () => {
    // Two cards so the db keeps operational state after the delete: the deletion
    // then lands squarely on the `dbChanged && !fileChanged` export branch.
    const keep = await cli(repo, 'create', '--title', 'keeper');
    expect(keep.code).toBe(0);
    const doomed = await cli(repo, 'create', '--title', 'created by mistake');
    expect(doomed.code).toBe(0);
    const doomedId = (doomed.stdout.match(/Created task (t_\w+)/) as RegExpMatchArray)[1];

    const published = await cli(repo, 'sync');
    expect(published.code).toBe(0);
    expect(snapshotOf(repo)).toContain('created by mistake');

    // Delete, then the ordinary sync (the same one the git hooks run) republishes
    // roadmap.json without the row — no reconcile logic is involved.
    const removed = await cli(repo, 'delete', doomedId);
    expect(removed.code).toBe(0);
    const exported = await cli(repo, 'sync');
    expect(exported.code).toBe(0);
    expect(exported.stdout).toContain('refreshed from the local database');

    const snap = JSON.parse(snapshotOf(repo)) as StateExport;
    expect(snap.tasks.map((t) => t.title)).toEqual(['keeper']);
    expect(snap.tasks.some((t) => t.id === doomedId)).toBe(false);
    expect(snap.task_events.some((e) => e.task_id === doomedId)).toBe(false);

    // A later sync is a no-op and does NOT resurrect the card: the baseline now
    // describes the post-delete pair, so neither side reads as changed.
    const again = await cli(repo, 'sync');
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('in sync (none)');
    expect(snapshotOf(repo)).not.toContain('created by mistake');
    const listed = await cli(repo, 'list');
    expect(listed.stdout).not.toContain(doomedId);
    expect(listed.stdout).toContain('keeper');
  });

  // This round-trip intentionally runs 13 real CLI subprocesses. Their startup
  // cost exceeds Bun's default 5s under the full suite; keep a bounded 20s gate.
  test('pulled snapshot imports on sync; local mutation exports; divergence is refused then resolvable', async () => {
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
      await cli(clone, 'sync'); // materialize + baseline

      // Simulated pull: F2 arrives while B's db is untouched → sync imports
      // (post-merge/post-rewrite run this after real pulls).
      writeFileSync(join(clone, '.genie', 'roadmap.json'), f2);
      const pulled = await cli(clone, 'sync');
      expect(pulled.code).toBe(0);
      expect(pulled.stdout).toContain('Board refreshed');
      const listed2 = await cli(clone, 'list');
      expect(listed2.stdout).toContain('second card');

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
      // The refusal is a warning on stderr (the git hooks run `task sync
      // || true`, so the exit code alone reaches nobody) and names both
      // resolving commands.
      expect(diverged.stderr).toContain('Nothing was overwritten');
      expect(diverged.stderr).toContain('genie task import --replace');
      expect(diverged.stderr).toContain('genie task export --write');
      expect(diverged.stdout).not.toContain('Nothing was overwritten');
      expect(snapshotOf(clone)).toBe(f2); // snapshot untouched
      const listed = await cli(clone, 'list');
      expect(listed.stdout).toContain('b-diverging card'); // local state kept

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
  }, 20_000);
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

  test('comment and report take --worker so each speaker is attributed, never collapsed to cli', async () => {
    const id = await seed('attributed');
    expect((await cli(repo, 'comment', id, '--worker', 'orchestrator', 'dispatching G1')).code).toBe(0);
    expect((await cli(repo, 'checkout', id, '--worker', 'eng-A')).code).toBe(0);
    expect(
      (await cliEnv(repo, { GENIE_AGENT_NAME: 'eng-A', CLAUDECODE: '1' }, 'report', id, 'done: 12 tests pass')).code,
    ).toBe(0);
    expect((await cli(repo, 'comment', id, '--', 'review: SHIP — 0 gaps')).code).toBe(0);
    const db = openDb({ cwd: repo });
    const events = getTaskEvents(db, id);
    db.close();
    expect(events.map((e) => [e.kind, e.author])).toEqual([
      ['comment', 'orchestrator'],
      ['claim', 'cli'],
      ['report', 'eng-A'],
      ['comment', 'cli'],
    ]);
    expect(events[3].note).toBe('review: SHIP — 0 gaps');
  });

  test('report is a trust signal: refused unless the author is the current claimant', async () => {
    const id = await seed('guarded');
    const unclaimed = await cli(repo, 'report', id, '--worker', 'eng-A', 'done');
    expect(unclaimed.code).toBe(1);
    expect(unclaimed.stderr).toContain('is not claimed');
    expect((await cli(repo, 'checkout', id, '--worker', 'eng-A')).code).toBe(0);
    const impostor = await cli(repo, 'report', id, '--worker', 'eng-B', 'done');
    expect(impostor.code).toBe(1);
    expect(impostor.stderr).toContain('claimed by eng-A, not eng-B');
    expect((await cli(repo, 'report', id, '--worker', 'eng-A', 'done: verified')).code).toBe(0);
    const db = openDb({ cwd: repo });
    expect(getTaskEvents(db, id).filter((e) => e.kind === 'report')).toHaveLength(1);
    db.close();
  });

  /**
   * Dogfood r7 W1: `task report --help` promised "one per claim-to-handoff
   * span" while the CLI accepted every repeat, so a card's timeline could hold
   * several partial handoffs with nothing saying which one was THE report.
   */
  test('one report per claim-to-handoff span; a new checkout opens the next span', async () => {
    const id = await seed('one-per-span');
    expect((await cli(repo, 'checkout', id, '--worker', 'eng-A')).code).toBe(0);
    expect((await cli(repo, 'report', id, '--worker', 'eng-A', 'handoff: 12 tests pass')).code).toBe(0);

    const second = await cli(repo, 'report', id, '--worker', 'eng-A', 'handoff: actually 13');
    expect(second.code).toBe(1);
    expect(second.stderr.trim().split('\n')).toHaveLength(1);
    expect(second.stderr).toContain('already reported');
    expect(second.stderr).toContain('claim-to-handoff span');
    // The refusal names the verb that IS unbounded, so the worker is not stuck.
    expect(second.stderr).toContain(`genie task comment ${id}`);
    expect((await cli(repo, 'comment', id, 'actually 13')).code).toBe(0);

    const before = openDb({ cwd: repo });
    expect(getTaskEvents(before, id).filter((e) => e.kind === 'report')).toHaveLength(1);
    before.close();

    // Handoff, then a fresh claim: the next span carries its own report.
    expect((await cli(repo, 'release', id)).code).toBe(0);
    expect((await cli(repo, 'checkout', id, '--worker', 'eng-A')).code).toBe(0);
    expect((await cli(repo, 'report', id, '--worker', 'eng-A', 'handoff: 13 tests pass')).code).toBe(0);
    const after = openDb({ cwd: repo });
    expect(getTaskEvents(after, id).filter((e) => e.kind === 'report')).toHaveLength(2);
    after.close();
  });

  test('the report help text states the span rule the CLI enforces', async () => {
    const help = await cli(repo, 'report', '--help');
    expect(help.code).toBe(0);
    // Commander hard-wraps the description, so compare on collapsed whitespace.
    expect(help.stdout.replace(/\s+/g, ' ')).toContain('one per claim-to-handoff span');
  });

  test('comment and report reject control characters and notes over 4000 bytes', async () => {
    const id = await seed('bounded');
    // ESC survives argv (NUL cannot); it is a C0 control the note bound refuses.
    const control = await cli(repo, 'comment', id, 'bad\u001bline');
    expect(control.code).toBe(1);
    expect(control.stderr).toContain('control characters');
    expect((await cli(repo, 'checkout', id, '--worker', 'cli')).code).toBe(0);
    const long = await cli(repo, 'report', id, 'x'.repeat(4001));
    expect(long.code).toBe(1);
    expect(long.stderr).toContain('at most 4000 bytes');
    const db = openDb({ cwd: repo });
    expect(getTaskEvents(db, id).filter((e) => e.kind !== 'claim')).toHaveLength(0);
    db.close();
    // Newlines and tabs are text and survive verbatim, matching the board contract.
    expect((await cli(repo, 'comment', id, 'line one\nline\ttwo')).code).toBe(0);
  });

  test('report appends a report event tagged with the runtime kind', async () => {
    const id = await seed('meeseeks');
    expect((await cli(repo, 'checkout', id, '--worker', 'eng-B')).code).toBe(0);
    const r = await cliEnv(repo, { GENIE_AGENT_NAME: 'eng-B', CLAUDECODE: '1' }, 'report', id, 'implemented + tested');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('claude-code');

    const db = openDb({ cwd: repo });
    const events = getTaskEvents(db, id);
    db.close();
    const report = events.find((e) => e.kind === 'report');
    expect(report?.note).toBe('implemented + tested');
    expect(report?.author).toBe('eng-B');
    expect(report?.authorKind).toBe('claude-code');
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

  test('heartbeat records a liveness pulse on a claimed card', async () => {
    const id = await seed('pulse');
    const claim = await cli(repo, 'checkout', id, '--worker', 'w1');
    expect(claim.code).toBe(0);
    const before = Date.now();
    const r = await cli(repo, 'heartbeat', id);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    const db = openDb({ cwd: repo });
    const card = getTaskCard(db, id);
    db.close();
    expect(card?.heartbeatAt).toBeGreaterThanOrEqual(before);
  });

  /**
   * Regression (dogfood r2 minor 15): `heartbeat` on a never-claimed card
   * exited 0 and stamped `heartbeat_at` on a `ready` card with `claimed_by`
   * NULL — liveness for a worker that does not exist.
   */
  test('heartbeat on an unclaimed card is refused with a typed error and exit 1', async () => {
    const id = await seed('never claimed');
    const r = await cli(repo, 'heartbeat', id);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('not claimed');
    expect(r.stderr).toContain(`genie task checkout ${id} --worker`);
    expect(r.stderr).not.toContain('at <anonymous>');
    const db = openDb({ cwd: repo });
    const card = getTaskCard(db, id);
    db.close();
    expect(card?.heartbeatAt).toBeNull();
    expect(card?.claimedBy).toBeNull();
  });

  test('heartbeat on a released card is refused again', async () => {
    const id = await seed('released');
    expect((await cli(repo, 'checkout', id, '--worker', 'w1')).code).toBe(0);
    expect((await cli(repo, 'heartbeat', id)).code).toBe(0);
    expect((await cli(repo, 'release', id)).code).toBe(0);
    const r = await cli(repo, 'heartbeat', id);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not claimed');
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

  test('block without --hold records a work block; status renders the kind', async () => {
    const id = await seed('work block');
    const r = await cli(repo, 'block', id, '--reason', 'awaiting a decision');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('work');

    const st = await cli(repo, 'status', id);
    expect(st.code).toBe(0);
    expect(st.stdout).toContain('Blocked by:');
    expect(st.stdout).toContain('(work)');
    expect(st.stdout).toContain('awaiting a decision');

    const db = openDb({ cwd: repo });
    expect(getTaskCard(db, id)?.enforcedBlock).toEqual({ reason: 'awaiting a decision', kind: 'work' });
    db.close();
  });

  test('block --hold records a hold, renders it on status, and still refuses checkout', async () => {
    const id = await seed('held card');
    const r = await cli(repo, 'block', id, '--reason', 'parked until Q3', '--hold');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('hold');

    const st = await cli(repo, 'status', id);
    expect(st.stdout).toContain('(hold)');

    // A hold refuses checkout exactly like a work block — same exit code, same reason.
    const co = await cli(repo, 'checkout', id, '--worker', 'w1');
    expect(co.code).toBe(1);
    expect(co.stdout).toBe('');
    expect(co.stderr).toContain('parked until Q3');

    const db = openDb({ cwd: repo });
    expect(getTaskCard(db, id)?.enforcedBlock).toEqual({ reason: 'parked until Q3', kind: 'hold' });
    expect(getTask(db, id)?.status).toBe('ready'); // the block never moved the lifecycle status
    db.close();
  });

  test('unblock clears the kind along with the block', async () => {
    const id = await seed('kind cleared');
    await cli(repo, 'block', id, '--reason', 'parked', '--hold');
    expect((await cli(repo, 'unblock', id)).code).toBe(0);

    const db = openDb({ cwd: repo });
    expect(getTaskCard(db, id)?.enforcedBlock).toBeNull();
    db.close();
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

/**
 * M6 — a card deleted by a concurrent worktree while a timeline verb is
 * appending must fail with the typed, attributable not-found error, never with
 * the raw `FOREIGN KEY constraint failed` the unprotected insert produced
 * (13/20 iterations on the dogfood host). Real subprocesses, real SQLite
 * contention, `Promise.allSettled` — no mocked race.
 */
describe('timeline verbs under a concurrent delete', () => {
  const ITERATIONS = 12;

  async function raceVerb(verb: 'comment' | 'report'): Promise<void> {
    const db = openDb({ cwd: repo });
    const ids = Array.from({ length: ITERATIONS }, (_, i) => createTask(db, { title: `race ${i}` }).id);
    db.close();

    // `report` is gated on the current claimant, so each card is claimed as the
    // default worker first; the race then pits the report against the delete.
    if (verb === 'report')
      for (const id of ids) expect((await cli(repo, 'checkout', id, '--worker', 'cli')).code).toBe(0);
    const rounds = ids.map((id) => Promise.allSettled([cli(repo, verb, id, 'note'), cli(repo, 'delete', id)]));
    const settled = await Promise.all(rounds);

    for (const [appended] of settled) {
      expect(appended.status).toBe('fulfilled');
      const result = (appended as PromiseFulfilledResult<CliResult>).value;
      expect(result.stderr).not.toContain('FOREIGN KEY');
      if (result.code === 0) continue;
      // The only legitimate loss is "the card is gone", and it must say so.
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/Task not found: t_\w+/);
    }
  }

  test('comment never leaks a raw FOREIGN KEY failure', async () => {
    await raceVerb('comment');
  });

  test('report never leaks a raw FOREIGN KEY failure', async () => {
    await raceVerb('report');
  });
});

/**
 * m8 — liveness is derived purely from `heartbeat_at`, and a null heartbeat
 * classifies as `stale`. A claim that seeds no heartbeat therefore renders the
 * card dead the instant a worker picks it up.
 */
describe('task checkout liveness seeding', () => {
  test('a freshly claimed card carries heartbeat_at = claimed_at and reads live', async () => {
    const db = openDb({ cwd: repo });
    const task = createTask(db, { title: 'claim me' });
    db.close();

    const r = await cli(repo, 'checkout', task.id, '--worker', 'zz');
    expect(r.code).toBe(0);

    const after = openDb({ cwd: repo });
    const row = after.query('SELECT claimed_at, heartbeat_at FROM tasks WHERE id = ?').get(task.id) as {
      claimed_at: number | null;
      heartbeat_at: number | null;
    };
    after.close();
    expect(row.heartbeat_at).not.toBeNull();
    expect(row.heartbeat_at).toBe(row.claimed_at as number);
  });
});

/**
 * m11 — the committed `.genie/roadmap.json` is the canonical board, so an
 * import → export round-trip of it must reproduce it byte for byte and a
 * one-card change must diff as one card. Otherwise every clone's first sync
 * rewrites the whole 2k-line file (1922 insertions / 1902 deletions on the
 * dogfood host, whose committed file predated the canonical serializer).
 */
/** Does every line of `before` still appear in `after`, in order? A pure insertion. */
function isSubsequence(before: string[], after: string[]): boolean {
  let cursor = 0;
  for (const line of before) {
    cursor = after.indexOf(line, cursor);
    if (cursor === -1) return false;
    cursor += 1;
  }
  return true;
}

/** Re-emit a parsed snapshot with every object's keys reversed: same content, non-canonical bytes. */
function reverseKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeyOrder);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>).reverse();
  return Object.fromEntries(entries.map(([key, inner]) => [key, reverseKeyOrder(inner)]));
}

describe('committed roadmap.json round-trip', () => {
  const COMMITTED = join(import.meta.dir, '..', '..', '.genie', 'roadmap.json');

  test('this repo’s own snapshot is already canonical bytes', () => {
    const text = readFileSync(COMMITTED, 'utf-8');
    expect(serializeSnapshot(JSON.parse(text))).toBe(text);
  });

  test('import then export reproduces it byte for byte, and one card diffs as one card', async () => {
    const text = readFileSync(COMMITTED, 'utf-8');
    await mkdir(join(repo, '.genie'), { recursive: true });
    writeFileSync(join(repo, '.genie', 'roadmap.json'), text);

    const imported = await cli(repo, 'import');
    expect(imported.code).toBe(0);
    const exported = await cli(repo, 'export', '--write');
    expect(exported.code).toBe(0);
    expect(readFileSync(join(repo, '.genie', 'roadmap.json'), 'utf-8')).toBe(text);

    const created = await cli(repo, 'create', '--title', 'one more card');
    expect(created.code).toBe(0);
    const republished = await cli(repo, 'export', '--write');
    expect(republished.code).toBe(0);

    const before = text.split('\n');
    const after = readFileSync(join(repo, '.genie', 'roadmap.json'), 'utf-8').split('\n');
    // A pure insertion: every original line survives, in order.
    expect(isSubsequence(before, after)).toBe(true);
    expect(after.length - before.length).toBeLessThan(40);
  });

  /**
   * The residual half of m11, at the CLI boundary the git hooks actually use.
   * `import → export` being byte-stable only helps a snapshot that is ALREADY
   * canonical; a branch whose roadmap.json predates the canonical serializer
   * (origin/main's own file, top-level `schemaVersion, meta, boards, tasks, …`
   * and every row in physical column order) still had its reordering ride along
   * with the next content change — the 1922/1902 diff the dogfood hop reported.
   * `task sync` now lands the reordering alone, and says so.
   */
  test('a legacy-ordered snapshot is reordered by its own sync, not by the next card', async () => {
    const canonical = readFileSync(COMMITTED, 'utf-8');
    await mkdir(join(repo, '.genie'), { recursive: true });
    const roadmap = join(repo, '.genie', 'roadmap.json');
    // The same content an older genie would have committed: reversed key order.
    writeFileSync(roadmap, `${JSON.stringify(reverseKeyOrder(JSON.parse(canonical)), null, 2)}\n`);
    expect(readFileSync(roadmap, 'utf-8')).not.toBe(canonical);

    // Sync #1: the reordering, alone. It carries no board change and says so.
    const first = await cli(repo, 'sync');
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('canonical key order');
    expect(first.stdout).toContain('no board content changed');
    expect(readFileSync(roadmap, 'utf-8')).toBe(canonical);

    // Sync #2: one new card, and the file diffs by that card alone.
    expect((await cli(repo, 'create', '--title', 'one more card')).code).toBe(0);
    const second = await cli(repo, 'sync');
    expect(second.code).toBe(0);
    const before = canonical.split('\n');
    const after = readFileSync(roadmap, 'utf-8').split('\n');
    expect(isSubsequence(before, after)).toBe(true);
    expect(after.length - before.length).toBeLessThan(40);
  });
});

/**
 * M7 — `GENIE_HOME` defaults to `$HOME/.genie`, which is also a valid spelling
 * of a per-repo `.genie/`. A per-repo verb run with cwd = that home resolved the
 * GLOBAL database and initialized the per-repo schema inside the machine-scope
 * queue. The two databases have independent `PRAGMA user_version`; they must
 * never merge.
 */
describe('per-repo verbs refuse the global database', () => {
  test('a cwd whose .genie IS GENIE_HOME errors clearly and writes no per-repo schema', async () => {
    const home = mkdtempSync(join(tmpdir(), 'genie-home-collision-'));
    try {
      const genieHome = join(home, '.genie');
      // Seed the global database through its own command, exactly as a host does.
      const seeded = await cliEnv(home, { GENIE_HOME: genieHome }, 'list');
      expect(seeded.code).toBe(1);
      expect(seeded.stderr).toContain('Refusing to open the machine-scope database');
      expect(seeded.stderr).toContain('GENIE_HOME/genie.db');
      expect(seeded.stderr).not.toContain('at <anonymous>');
      // Nothing was created where the global database lives.
      expect(existsSync(join(genieHome, 'genie.db'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Orca lifecycle authority — `task sync` is the one carve-out from the gate
// ============================================================================

describe('orca lifecycle authority', () => {
  /** A throwaway GENIE_HOME whose config hands lifecycle authority to Orca. */
  function orcaHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'genie-task-orca-home-'));
    homes.push(home);
    writeFileSync(join(home, 'config.json'), '{"orchestration":{"mode":"orca"}}');
    return home;
  }

  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  test('`task sync` exits 0 in silence in an initialized orca repo', async () => {
    // The fixture HAS a `.genie` workspace and a real card in it, so the only
    // thing that can make this silent is the orca check itself — a standalone
    // run over the same tree prints its reconcile line (asserted below).
    // `.husky/pre-commit` runs `task sync` on every commit: one line here is a
    // warning on every single commit that the operator cannot act on.
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'a card the orca run must not mention' });
    db.close();
    expect(existsSync(join(repo, '.genie'))).toBe(true);

    const r = await cliEnv(repo, { GENIE_HOME: orcaHome() }, 'sync');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  test('every other task subverb is refused with exit 2 and the one fixed line', async () => {
    const home = orcaHome();
    for (const args of [['list'], ['create', '--title', 'nope'], ['export'], ['status', 't_x']]) {
      const r = await cliEnv(repo, { GENIE_HOME: home }, ...args);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe(`${ORCA_REFUSAL_MESSAGE}\n`);
    }
  });

  test('standalone is untouched — `task sync` still reports the reconcile result', async () => {
    const standalone = mkdtempSync(join(tmpdir(), 'genie-task-standalone-home-'));
    homes.push(standalone);
    writeFileSync(join(standalone, 'config.json'), '{"orchestration":{"mode":"standalone"}}');
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'a card standalone still reconciles' });
    db.close();

    const r = await cliEnv(repo, { GENIE_HOME: standalone }, 'sync');
    expect(r.code).toBe(0);
    expect(r.stdout).not.toBe('');
  });
});
