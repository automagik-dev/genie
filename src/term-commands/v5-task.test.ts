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
import { openDb, resolveDbPath } from '../lib/v5/genie-db.js';
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
  hireAgent,
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
    expect(status.stdout).toContain('Assigned to:claude — owns the parser');
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
    expect(status.stdout).toContain('Assigned to:codex — dissent on the parser');
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
    expect(state.schemaVersion).toBe(1);
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

  test('snapshot excludes hire_roster; canonical import preserves local hires', async () => {
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'card' });
    hireAgent(db, { wish: 'w', agentAdapterId: 'claude', worktree: '/tmp/wt' });
    db.close();

    const w = await cli(repo, 'export', '--write');
    expect(w.code).toBe(0);
    const snap = JSON.parse(snapshotOf(repo)) as StateExport;
    expect(snap.hire_roster).toEqual([]);
    expect(snap.tasks).toHaveLength(1);

    const r = await cli(repo, 'import', '--replace');
    expect(r.code).toBe(0);
    const db2 = openDb({ cwd: repo });
    const hires = db2.query('SELECT wish, worktree FROM hire_roster').all() as Array<{
      wish: string;
      worktree: string;
    }>;
    db2.close();
    expect(hires).toEqual([{ wish: 'w', worktree: '/tmp/wt' }]);
  });

  test('a hire before the first sync does not wedge a fresh clone into diverged', async () => {
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

      // Local hire BEFORE any baseline sync: hires are machine-local and never
      // travel, so they must not count as unpublished board state — the board
      // still materializes instead of reporting divergence.
      const cloneDb = openDb({ cwd: clone });
      hireAgent(cloneDb, { wish: 'w', agentAdapterId: 'claude', worktree: '/tmp/wt' });
      cloneDb.close();

      const synced = await cli(clone, 'sync');
      expect(synced.code).toBe(0);
      expect(synced.stdout).toContain('Board refreshed');
      const r = await cli(clone, 'list');
      expect(r.stdout).toContain('canonical card');
      // And the local hire survived the canonical import untouched.
      const db2 = openDb({ cwd: clone });
      const hires = db2.query('SELECT wish, worktree FROM hire_roster').all() as Array<{
        wish: string;
        worktree: string;
      }>;
      db2.close();
      expect(hires).toEqual([{ wish: 'w', worktree: '/tmp/wt' }]);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  test('explicit relative canonical path behaves like the default; custom-file exports stay lossless', async () => {
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'card' });
    hireAgent(db, { wish: 'w', agentAdapterId: 'claude', worktree: '/tmp/wt' });
    db.close();

    // Custom-file --write carries the COMPLETE state (hire_roster included), so
    // a backup.json → import --replace round-trip cannot silently drop hires.
    const backup = await cli(repo, 'export', '--write', 'backup.json');
    expect(backup.code).toBe(0);
    const backupState = JSON.parse(readFileSync(join(repo, 'backup.json'), 'utf-8')) as StateExport;
    expect(backupState.hire_roster).toHaveLength(1);

    // The canonical path spelled explicitly (relative) still emits the roadmap
    // slice and still counts as canonical on import: local hires preserved.
    const w = await cli(repo, 'export', '--write', '.genie/roadmap.json');
    expect(w.code).toBe(0);
    const snap = JSON.parse(snapshotOf(repo)) as StateExport;
    expect(snap.hire_roster).toEqual([]);

    const r = await cli(repo, 'import', '.genie/roadmap.json', '--replace');
    expect(r.code).toBe(0);
    const db2 = openDb({ cwd: repo });
    const hires = db2.query('SELECT wish, worktree FROM hire_roster').all() as Array<{
      wish: string;
      worktree: string;
    }>;
    db2.close();
    expect(hires).toEqual([{ wish: 'w', worktree: '/tmp/wt' }]);

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
    const settled = await cli(repo, 'sync');
    expect(settled.code).toBe(0);
    expect(settled.stdout).toContain('in sync (none)');
  });

  test('a subdirectory spelling of roadmap.json is roadmap-sliced, and is not the canonical baseline', async () => {
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'card' });
    hireAgent(db, { wish: 'w', agentAdapterId: 'claude', worktree: '/tmp/machine-local-wt' });
    db.close();
    await mkdir(join(repo, 'src', '.genie'), { recursive: true });

    // Same relative spelling, different cwd: it resolves to src/.genie/roadmap.json,
    // NOT the canonical repo-root file. It is still a git-trackable file named
    // roadmap.json, so the machine-local hire_roster must not travel in it.
    const w = await cli(join(repo, 'src'), 'export', '--write', '.genie/roadmap.json');
    expect(w.code).toBe(0);
    expect(w.stderr).toBe('');
    const written = readFileSync(join(repo, 'src', '.genie', 'roadmap.json'), 'utf-8');
    expect(written).not.toContain('/tmp/machine-local-wt');
    expect((JSON.parse(written) as StateExport).hire_roster).toEqual([]);

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
      expect(diverged.stdout).toContain('Nothing was overwritten');
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
