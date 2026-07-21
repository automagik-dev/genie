/**
 * genie board — CLI-level tests. The board is derived purely by query with
 * NO stored view state, so these assert that status transitions are reflected
 * on the next render with nothing persisted. Exit codes AND stderr are checked.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/v5/genie-db.js';
import {
  DEFAULT_LIFECYCLE_LANES,
  LIVENESS_RUNNING_MS,
  LIVENESS_STALE_MS,
  appendTaskEvent,
  blockTask,
  claimTask,
  completeTask,
  createBoard,
  createTask,
  moveTask,
  recordHeartbeat,
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

async function board(cwd: string, ...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(['bun', GENIE, 'board', ...args], {
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
  repo = mkdtempSync(join(tmpdir(), 'genie-v5-board-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'commit', '--allow-empty', '-m', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('board render', () => {
  test('renders the three laneless columns on an empty repo (blocked is a badge, never a column)', async () => {
    const r = await board(repo);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    for (const label of ['Ready', 'In Progress', 'Done']) {
      expect(r.stdout).toContain(label);
    }
    // Blocked is never a column header on the human render.
    expect(r.stdout).not.toContain('── Blocked');
    // Counts line reflects an empty board.
    expect(r.stdout).toContain('Ready: 0');
    expect(r.stdout).toContain('Done: 0');
  });

  test('places a fresh task in the Ready column', async () => {
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'do the thing' });
    db.close();

    const r = await board(repo);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Ready: 1');
    expect(r.stdout).toContain('do the thing');
  });

  test('reflects status changes with no stored view state', async () => {
    const db = openDb({ cwd: repo });
    const t = createTask(db, { title: 'moving task' });

    // Ready → in_progress via claim.
    claimTask(db, t.id, 'w1');
    db.close();
    let r = await board(repo);
    expect(r.stdout).toContain('In Progress: 1');
    expect(r.stdout).toContain('Ready: 0');
    expect(r.stdout).toContain('@w1');

    // in_progress → done via complete. Same board command, no persisted view.
    const db2 = openDb({ cwd: repo });
    completeTask(db2, t.id);
    db2.close();
    r = await board(repo);
    expect(r.stdout).toContain('Done: 1');
    expect(r.stdout).toContain('In Progress: 0');
  });

  test('--json emits columns keyed by status', async () => {
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'ready-1' });
    db.close();

    const r = await board(repo, '--json');
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      scope: string;
      columns: Record<string, Array<{ title: string }>>;
    };
    expect(payload.columns.ready).toHaveLength(1);
    expect(payload.columns.ready[0].title).toBe('ready-1');
    expect(payload.columns.blocked).toHaveLength(0);
  });
});

describe('board scoping', () => {
  test('--board filters to one board and reports its name in scope', async () => {
    const db = openDb({ cwd: repo });
    const b1 = createBoard(db, 'alpha');
    createBoard(db, 'beta');
    createTask(db, { title: 'alpha-task', boardId: b1.id });
    createTask(db, { title: 'loose-task' });
    db.close();

    const r = await board(repo, '--board', 'alpha');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('board "alpha"');
    expect(r.stdout).toContain('alpha-task');
    expect(r.stdout).not.toContain('loose-task');
  });

  test('--board with an unknown reference fails with exit 1 and clear stderr', async () => {
    const r = await board(repo, '--board', 'ghost');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Board not found: ghost');
  });
});

describe('board create', () => {
  test('defaults to the 6 lifecycle lanes', async () => {
    const r = await board(repo, 'create', 'roadmap');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('6 lanes');
    expect(r.stdout).toContain('Idea, Brainstorm, Wish, Work, Review, Done');

    const db = openDb({ cwd: repo });
    const row = db.query('SELECT lanes FROM boards WHERE name = ?').get('roadmap') as { lanes: string };
    db.close();
    expect(JSON.parse(row.lanes).map((l: { name: string }) => l.name)).toEqual([
      'Idea',
      'Brainstorm',
      'Wish',
      'Work',
      'Review',
      'Done',
    ]);
  });

  test('--lanes "A,B,C" creates name-only lanes', async () => {
    const r = await board(repo, 'create', 'custom', '--lanes', 'A, B ,C');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('3 lanes');
    expect(r.stdout).toContain('A, B, C');
  });

  test('a duplicate board name fails with exit 1 and a clean message', async () => {
    const first = await board(repo, 'create', 'dup');
    expect(first.code).toBe(0);
    const second = await board(repo, 'create', 'dup');
    expect(second.code).toBe(1);
    expect(second.stdout).toBe('');
    expect(second.stderr).toContain('already exists');
  });
});

describe('board list', () => {
  test('reports lane count and card count per board', async () => {
    const db = openDb({ cwd: repo });
    const road = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    createBoard(db, 'plain');
    createTask(db, { title: 'c1', boardId: road.id });
    db.close();

    const r = await board(repo, 'list');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('roadmap');
    expect(r.stdout).toContain('plain');
    expect(r.stdout).toContain('2 boards');

    const j = await board(repo, 'list', '--json');
    const rows = JSON.parse(j.stdout) as Array<{ name: string; laneCount: number; cardCount: number }>;
    const road2 = rows.find((x) => x.name === 'roadmap');
    expect(road2?.laneCount).toBe(6);
    expect(road2?.cardCount).toBe(1);
    expect(rows.find((x) => x.name === 'plain')?.laneCount).toBe(0);
  });

  test('reports "No boards found." on an empty repo', async () => {
    const r = await board(repo, 'list');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No boards found.');
  });
});

describe('lane-grouped render', () => {
  test('groups by lane and prints action hints; a moved card lands in its lane', async () => {
    const db = openDb({ cwd: repo });
    const road = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const t = createTask(db, { title: 'lane card', boardId: road.id, lane: 'Idea' });
    moveTask(db, t.id, 'Brainstorm', { author: 'felipe', authorKind: 'human' });
    db.close();

    const r = await board(repo, '--board', 'roadmap');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    // Lane-header action hints render (substring, not eyeball).
    expect(r.stdout).toContain('Idea → /brainstorm');
    expect(r.stdout).toContain('Brainstorm → /wish');
    expect(r.stdout).toContain('Wish → /work');
    expect(r.stdout).toContain('Work → /review');
    // Review/Done carry no advancing action → no arrow hint on their headers.
    expect(r.stdout).toMatch(/── Review \(\d+ cards?\) ──/);
    expect(r.stdout).toMatch(/── Done \(\d+ cards?\) ──/);
    // The card moved into Brainstorm; that lane header reports one card.
    expect(r.stdout).toContain('Brainstorm → /wish (1 card)');
    expect(r.stdout).toContain('lane card');
  });

  test('a NULL-lane card lands in the first lane (Idea)', async () => {
    const db = openDb({ cwd: repo });
    const road = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    createTask(db, { title: 'unplaced card', boardId: road.id }); // lane NULL
    db.close();

    const r = await board(repo, '--board', 'roadmap');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Idea → /brainstorm (1 card)');
  });

  test('--json for a lane board groups additively by lane', async () => {
    const db = openDb({ cwd: repo });
    const road = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    createTask(db, { title: 'idea card', boardId: road.id, lane: 'Idea' });
    db.close();

    const r = await board(repo, '--board', 'roadmap', '--json');
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      scope: string;
      lanes: Array<{ name: string; action: string | null; cards: Array<{ title: string; lane: string | null }> }>;
    };
    const idea = payload.lanes.find((l) => l.name === 'Idea');
    expect(idea?.action).toBe('/brainstorm');
    expect(idea?.cards[0].title).toBe('idea card');
    expect(payload.lanes.map((l) => l.name)).toEqual(['Idea', 'Brainstorm', 'Wish', 'Work', 'Review', 'Done']);
  });
});

// A laneless board (no lanes column) must keep the EXACT four-status render and
// the status-keyed --json shape — adding lane support must not perturb it.
describe('laneless board render is unchanged', () => {
  test('a board without lanes renders the three status columns (no Blocked column)', async () => {
    const db = openDb({ cwd: repo });
    const plain = createBoard(db, 'plain');
    createTask(db, { title: 'plain task', boardId: plain.id });
    db.close();

    const r = await board(repo, '--board', 'plain');
    expect(r.code).toBe(0);
    for (const label of ['Ready', 'In Progress', 'Done']) {
      expect(r.stdout).toContain(label);
    }
    expect(r.stdout).not.toContain('── Blocked');
    expect(r.stdout).not.toContain('/brainstorm');
  });

  test('--json for a laneless board keeps the status-keyed shape with no lane field', async () => {
    const db = openDb({ cwd: repo });
    const plain = createBoard(db, 'plain');
    createTask(db, { title: 'plain task', boardId: plain.id });
    db.close();

    const r = await board(repo, '--board', 'plain', '--json');
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as { columns: Record<string, Array<Record<string, unknown>>> };
    expect(Object.keys(payload.columns).sort()).toEqual(['blocked', 'done', 'in_progress', 'ready']);
    // The frozen TaskRow shape never gains a `lane` key NOR any runtime field on
    // the laneless path — the byte-freeze survives the runtime layer (Decision 7).
    const card = payload.columns.ready[0];
    for (const leaked of ['lane', 'agentKind', 'heartbeatAt', 'blockedBy', 'blockedReason']) {
      expect(leaked in card).toBe(false);
    }
    // The exact frozen key set, sorted — a byte-level guard against additions.
    expect(Object.keys(card).sort()).toEqual([
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
  });
});

// Every visual state is asserted by substring against a fixture with injected
// heartbeat_at / blocked_by / events — no criterion is eyeball-accepted. The
// board computes `now` at render time; seeded ages use minute-scale margins so
// the ~100ms subprocess delay never flips a threshold (deterministic, no sleep).
describe('deterministic runtime badges (laneless render)', () => {
  /** Claim a fresh card and seed its heartbeat to an absolute timestamp. */
  function seedClaimed(title: string, heartbeatAt: number | null): string {
    const db = openDb({ cwd: repo });
    const t = createTask(db, { title });
    claimTask(db, t.id, 'w1');
    if (heartbeatAt != null) recordHeartbeat(db, t.id, heartbeatAt);
    db.close();
    return t.id;
  }

  test('a fresh heartbeat renders ▶ running on a claimed card', async () => {
    seedClaimed('running card', Date.now());
    const r = await board(repo);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('▶');
    expect(r.stdout).not.toContain('☠');
  });

  test('a heartbeat past the running window but under stale renders ⏸ idle', async () => {
    seedClaimed('idle card', Date.now() - (LIVENESS_RUNNING_MS + 60_000));
    const r = await board(repo);
    expect(r.stdout).toContain('⏸');
  });

  test('a stale heartbeat renders ☠ (the zombie in_progress lie, killed)', async () => {
    seedClaimed('stale card', Date.now() - (LIVENESS_STALE_MS + 60_000));
    const r = await board(repo);
    expect(r.stdout).toContain('☠');
  });

  test('a claimed card that never pulsed renders ☠', async () => {
    seedClaimed('never pulsed', null);
    const r = await board(repo);
    expect(r.stdout).toContain('☠');
  });

  test('an unclaimed card carries no liveness glyph', async () => {
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'unclaimed' });
    db.close();
    const r = await board(repo);
    expect(r.stdout).not.toContain('▶');
    expect(r.stdout).not.toContain('⏸');
    expect(r.stdout).not.toContain('☠');
  });

  test('a deps-blocked card renders ⛔ deps inside the Ready column (render-derived)', async () => {
    const db = openDb({ cwd: repo });
    const a = createTask(db, { title: 'dep' });
    createTask(db, { title: 'downstream', dependsOn: [a.id] }); // status blocked
    db.close();
    const r = await board(repo);
    expect(r.stdout).toContain('⛔ deps');
    // Folds into Ready — Blocked is a badge, never a column.
    const readyIdx = r.stdout.indexOf('── Ready');
    const inProgIdx = r.stdout.indexOf('── In Progress');
    const badgeIdx = r.stdout.indexOf('⛔ deps');
    expect(badgeIdx).toBeGreaterThan(readyIdx);
    expect(badgeIdx).toBeLessThan(inProgIdx);
  });

  test('an agent-blocked card renders ⛔ with the agent provenance + reason', async () => {
    const db = openDb({ cwd: repo });
    const t = createTask(db, { title: 'agent blocked' });
    blockTask(db, t.id, 'awaiting design', { author: 'eng-B', authorKind: 'claude-code' });
    db.close();
    const r = await board(repo);
    expect(r.stdout).toContain('⛔ eng-B: awaiting design');
  });

  test('a human-blocked card renders ⛔ with the human provenance + reason', async () => {
    const db = openDb({ cwd: repo });
    const t = createTask(db, { title: 'human blocked' });
    blockTask(db, t.id, 'hold for release', { author: 'felipe', authorKind: 'human' });
    db.close();
    const r = await board(repo);
    expect(r.stdout).toContain('⛔ felipe: hold for release');
  });

  test('comment events render a 💬 count badge', async () => {
    const db = openDb({ cwd: repo });
    const t = createTask(db, { title: 'chatty' });
    appendTaskEvent(db, t.id, { kind: 'comment', note: 'one' });
    appendTaskEvent(db, t.id, { kind: 'comment', note: 'two' });
    appendTaskEvent(db, t.id, { kind: 'move', note: 'x' }); // not a comment
    db.close();
    const r = await board(repo);
    expect(r.stdout).toContain('💬 2');
  });

  test('the three columns render and Blocked is never a column header', async () => {
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'r' });
    db.close();
    const r = await board(repo);
    expect(r.stdout).toContain('── Ready');
    expect(r.stdout).toContain('── In Progress');
    expect(r.stdout).toContain('── Done');
    expect(r.stdout).not.toContain('── Blocked');
  });
});
