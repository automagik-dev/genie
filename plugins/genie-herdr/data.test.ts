// The Tasks board's pure rules (plugins/genie-herdr/data.js), driven the way main.js drives them.
// The shell strings data.js exports (PROBE_SCRIPT, BIN_SCRIPT, REALPATH_SCRIPT) run here under the
// same `sh -c <script> sh ...args` argv main.js hands to Herdr's exec.
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as D from './data.js';

const MIN = 60_000;
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function tmp(): string {
  const r = mkdtempSync(join(tmpdir(), 'genie-herdr-'));
  roots.push(r);
  return r;
}
/** A main checkout: a folder holding `.genie/genie.db`. */
function project(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, '.genie'), { recursive: true });
  writeFileSync(join(dir, '.genie', 'genie.db'), '');
  return dir;
}
function sh(script: string, args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(['sh', '-c', script, 'sh', ...args], { env: { ...process.env, ...env } });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}
/** The cursor file name, computed independently of PROBE_SCRIPT's `shasum` (review r1 MEDIUM-2). */
function cursorPath(genieHome: string, dir: string): string {
  const digest = createHash('sha256').update(realpathSync(dir)).digest('hex');
  return join(genieHome, 'cache', 'forge', `${digest}.cursor.json`);
}
function writeCursor(genieHome: string, dir: string, body: string): void {
  mkdirSync(join(genieHome, 'cache', 'forge'), { recursive: true });
  writeFileSync(cursorPath(genieHome, dir), body);
}

const P = '/work/repo';
const NOW = Date.parse('2026-11-04T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
function row(over: Record<string, unknown>) {
  return {
    task: 'gh-1',
    task_key: String(over.task ?? over.url ?? 'gh-1'),
    state: 'created',
    lane: 'Working',
    title: 'a task',
    lead: 'b-lead',
    forge: 'github',
    url: null,
    branch: null,
    updated_at: '2026-11-04T10:00:00Z',
    created_at: '2026-11-04T09:00:00Z',
    opened_at: null,
    merged_at: null,
    closed_at: null,
    worktree: null,
    project: P,
    ...over,
  };
}
const ok = (stdout: string, code = 0) => ({ ok: code === 0, code, stdout, stderr: '', error: null });

describe('T2 discovery', () => {
  test('local space folders only, deduped; an empty folder is the home', () => {
    const spaces = [
      { folder: '/a', machine: null },
      { folder: '/b', machine: 'g9' },
      { folder: '/a', machine: null },
      { folder: '', machine: null },
    ];
    expect(D.localFolders(spaces, '/home/me')).toEqual(['/a', '/home/me']);
  });

  test('a folder reached through a symlink is one project; worktrees and plain folders are not projects', () => {
    const root = tmp();
    const main = project(root, 'repo');
    symlinkSync(main, join(root, 'repo-link'));
    mkdirSync(join(root, 'wt', '.genie'), { recursive: true }); // a worktree: .genie/ but no genie.db
    mkdirSync(join(root, 'plain'));
    const out = sh(
      D.PROBE_SCRIPT,
      [main, join(root, 'repo-link'), join(root, 'wt'), join(root, 'plain'), join(root, 'gone')],
      {
        GENIE_HOME: join(root, 'home'),
      },
    );
    const { projects } = D.parseProbe(out.stdout);
    expect(projects).toEqual([realpathSync(main)]);
  });

  test('a project whose list exits 2 is hidden; one whose list failed otherwise stays', () => {
    let lists = {};
    lists = { ...lists, '/x': D.applyList(undefined, ok('[]'), NOW) };
    lists = { ...lists, '/y': D.applyList(undefined, ok('', 2), NOW) };
    lists = { ...lists, '/z': D.applyList(undefined, ok('', 1), NOW) };
    expect(D.shownProjects(['/x', '/y', '/z'], lists)).toEqual(['/x', '/z']);
  });
});

describe('T3 lanes and card', () => {
  const rows = [
    row({ task: 'gh-1', lane: 'Working', title: 'one' }),
    row({ task: 'gh-2', lane: 'Review', url: 'https://github.com/o/r/pull/2' }),
    row({ task: 'gh-3', lane: 'Merged' }),
    row({ task: 'gh-4', lane: 'Closed' }),
    row({ task: null, lane: 'Review', url: 'https://github.com/o/r/pull/9', title: 'no task id' }),
  ];

  test('rows land in Working, Review, Merged and Closed by lane', () => {
    const lanes = D.lanesOf(P, rows, null, NOW);
    expect(lanes.map((l) => l.key)).toEqual(['Working', 'Review', 'Merged', 'Closed']);
    const ids = Object.fromEntries(lanes.map((l) => [l.key, l.cards.map((c) => c.id)]));
    expect(ids).toEqual({ Working: ['gh-1'], Review: ['gh-2', 'untracked'], Merged: ['gh-3'], Closed: ['gh-4'] });
  });

  test('a null task renders "untracked" with its url', () => {
    const card = D.lanesOf(P, rows, null, NOW)[1].cards.find((c) => c.untracked);
    expect(card.id).toBe('untracked');
    expect(card.url).toBe('https://github.com/o/r/pull/9');
  });

  test('the card carries title, id, lead, lane, cost, time and ETA, and no action', () => {
    const card = D.lanesOf(P, rows, null, NOW)[0].cards[0];
    expect(card).toMatchObject({ id: 'gh-1', title: 'one', lead: 'b-lead', lane: 'Working' });
    for (const k of ['cost', 'time', 'eta']) expect(typeof card[k]).toBe('string');
    for (const k of Object.keys(card)) expect(k).not.toMatch(/^(action|actions|buttons|on[A-Z].*)$/);
    expect(Object.values(card).some((v) => typeof v === 'function')).toBe(false);
  });

  test('newest updated_at first, at most 12 cards a lane, with the total kept', () => {
    const many = Array.from({ length: 14 }, (_, i) => row({ task: `gh-${i}`, updated_at: iso(NOW - (14 - i) * MIN) }));
    const working = D.lanesOf(P, many, null, NOW)[0];
    expect(working.cards).toHaveLength(12);
    expect(working.total).toBe(14);
    expect(working.cards[0].id).toBe('gh-13');
  });
});

describe('T4 cost, time and ETA', () => {
  const rows = [
    row({ task: 'gh-1', lane: 'Working' }),
    row({ task: 'gh-2', lane: 'Working' }),
    row({ task: 'gh-3', lane: 'Merged' }),
    row({ task: null, lane: 'Review', url: 'https://github.com/o/r/pull/9' }),
    row({ task: 'gh-4', lane: 'Closed' }),
  ];
  const feed = (over = {}) => ({
    space: {
      projects: {
        [P]: {
          tasks: [
            {
              key: 'k1',
              task: 'gh-1',
              url: null,
              branch: 'b1',
              usd: 1.5,
              work_min: 30,
              lead_min: null,
              started_at: iso(NOW - 90 * MIN),
              state: 'working',
              bots: [{ bot: 'b-lead', usd: 1.5, work_min: 30 }],
            },
            {
              key: 'k2',
              task: 'gh-2',
              url: null,
              branch: 'b2',
              usd: null,
              work_min: null,
              lead_min: null,
              started_at: null,
              state: 'working',
              bots: [],
            },
            {
              key: 'k3',
              task: 'gh-3',
              url: null,
              branch: 'b3',
              usd: 0,
              work_min: 0,
              lead_min: 60,
              started_at: null,
              state: 'merged',
              bots: [],
            },
            {
              key: 'k9',
              task: null,
              url: 'https://github.com/o/r/pull/9',
              branch: 'b9',
              usd: 2,
              work_min: 5,
              lead_min: null,
              started_at: iso(NOW - 300 * MIN),
              state: 'open',
              bots: [],
            },
            { key: 'kx', task: 'gh-old1', usd: 3, lead_min: 120, state: 'merged', bots: [] },
            { key: 'ky', task: 'gh-old2', usd: 3, lead_min: 240, state: 'merged', bots: [] },
          ],
        },
      },
    },
    ...over,
  });
  const stdout = (doc: unknown) => `${JSON.stringify(doc)}\n`;
  const cards = (doc: unknown) => {
    const rowsOf = D.feedRows(D.docFeed(ok(stdout(doc))), P);
    return Object.fromEntries(
      D.lanesOf(P, rows, rowsOf, NOW).flatMap((l) => l.cards.map((c) => [c.id === 'untracked' ? c.url : c.id, c])),
    );
  };

  test('null renders "–", a measured 0 renders $0.00 and 0m', () => {
    expect(D.fmtUsd(null)).toBe('–');
    expect(D.fmtUsd(0)).toBe('$0.00');
    expect(D.fmtUsd(1.234)).toBe('$1.23');
    expect(D.fmtMin(null)).toBe('–');
    expect(D.fmtMin(0)).toBe('0m');
    expect(D.fmtMin(90)).toBe('1.5h');
  });

  test('joins by (project, task), or by url for a null task', () => {
    const c = cards(feed());
    expect(c['gh-1'].cost).toBe('$1.50');
    expect(c['gh-3'].cost).toBe('$0.00');
    expect(c['https://github.com/o/r/pull/9'].cost).toBe('$2.00');
    expect(c['gh-1'].bots).toEqual([{ bot: 'b-lead', usd: 1.5, work_min: 30 }]);
  });

  test('merged shows lead_min; Working shows now - started_at, live; a null started_at shows "–"', () => {
    const c = cards(feed());
    expect(c['gh-3'].time).toBe('1.0h');
    expect(c['gh-1'].time).toBe('1.5h');
    expect(c['gh-2'].time).toBe('–');
    expect(c['gh-2'].eta).toBe('–');
  });

  test('ETA: past 60, 120, 240 with 90 elapsed gives ~1.5h left; 300 elapsed is over', () => {
    const history = D.historyOf([{ lead_min: 240 }, { lead_min: 60 }, { lead_min: null }, { lead_min: 120 }]);
    expect(history).toEqual([60, 120, 240]);
    expect(D.etaText(D.estimateOf(90, history))).toBe('~1.5h');
    expect(D.etaText(D.estimateOf(300, history))).toBe('over');
    const c = cards(feed());
    expect(c['gh-1'].eta).toBe('~1.5h');
    expect(c['gh-1'].merges).toBe(3);
    expect(c['https://github.com/o/r/pull/9'].eta).toBe('over');
  });

  test('a missing task, the live 0.3.0 doc, doc get exiting 1, 2 or 3, a launch failure or invalid JSON leave every number "–"', () => {
    expect(cards(feed())['gh-4']).toMatchObject({ cost: '–', time: '–', eta: '–' });
    const live030 = {
      meter_version: '0.3.0',
      schema_version: 2,
      projects: [{ repo: P, tasks: 5 }],
      tasks: [{ repo: P, branch: 'b1', usd: 9 }],
    };
    const outcomes = [
      ok(stdout(live030)),
      ok(stdout(feed()), 1),
      ok(stdout(feed()), 2),
      ok(stdout(feed()), 3),
      { ok: false, code: null, stdout: '', stderr: '', error: 'spawn automagik-herdr ENOENT' },
      ok('{"space":'),
      ok(`${JSON.stringify(feed())}\n${JSON.stringify(feed())}\n`),
    ];
    for (const outcome of outcomes) {
      const lanes = D.lanesOf(P, rows, D.feedRows(D.docFeed(outcome), P), NOW);
      expect(lanes.map((l) => l.cards.length)).toEqual([2, 1, 1, 1]);
      for (const card of lanes.flatMap((l) => l.cards))
        expect([card.cost, card.time, card.eta]).toEqual(['–', '–', '–']);
    }
  });
});

describe('T5 badge', () => {
  const LINK = '/links/repo';
  const board = {
    [P]: [
      row({ task: 'gh-1', lane: 'Working', branch: 'feat/gh-1' }),
      row({ task: 'gh-2', lane: 'Review' }),
      row({ task: 'gh-3', lane: 'Review' }),
      row({ task: 'gh-5', lane: 'Working', branch: 'feat/gh-5' }),
      row({ task: 'gh-6', lane: 'Working', worktree: '/work/repo.worktrees/gh-6' }),
      row({ task: 'gh-7', lane: 'Merged' }),
    ],
  };
  const realpaths = new Map([[LINK, P]]);
  const noWorkers = new Map();
  const labelled = (address: string, task: string, status = 'blocked') => ({
    address,
    state: 'live',
    status,
    labels: { task, 'task.project': LINK, 'task.lead': 'b-lead', branch: `feat/${task}` },
  });
  const workersText = [
    JSON.stringify({ event: 'start', kind: 'worker', terminal: 't5', task: 'gh-99', project: P }),
    JSON.stringify({ event: 'session', terminal: 't5', session: 's' }),
    JSON.stringify({ event: 'start', kind: 'worker', terminal: 't5', task: 'feat/gh-5', branch: null, project: LINK }),
    JSON.stringify({ event: 'start', kind: 'bot', terminal: 't6', task: 'gh-1', project: P }),
    JSON.stringify({
      event: 'start',
      kind: 'worker',
      terminal: 't6',
      task: null,
      branch: null,
      worktree: '/work/repo.worktrees/gh-6',
      project: P,
    }),
    'not json',
  ].join('\n');

  test('2 Review cards plus 1 Working card with a blocked worker gives 3', () => {
    expect(D.waitingCount(board, [labelled('t1', 'gh-1')], { realpaths, workers: noWorkers })).toBe(3);
  });

  test('a labelled terminal matches through task/task.project (a symlink) without reading workers.jsonl', () => {
    const untouchable = {
      get() {
        throw new Error('workers.jsonl read for a labelled terminal');
      },
    };
    expect(D.waitingCount(board, [labelled('t1', 'gh-1')], { realpaths, workers: untouchable })).toBe(3);
  });

  test("the task.project label's realpath comes from REALPATH_SCRIPT, symlinks resolved", () => {
    const root = tmp();
    const main = project(root, 'repo');
    symlinkSync(main, join(root, 'link'));
    const map = D.parseRealpaths(sh(D.REALPATH_SCRIPT, [join(root, 'link'), join(root, 'gone')]).stdout);
    expect(map.get(join(root, 'link'))).toBe(realpathSync(main));
    expect(map.has(join(root, 'gone'))).toBe(false);
  });

  test('unlabelled terminals: the branch-as-task and the worktree fallbacks each match', () => {
    const workers = D.parseWorkers(workersText);
    const t = (address: string) => ({ address, state: 'live', status: 'blocked', labels: {} });
    expect(D.waitingCount(board, [t('t5')], { realpaths, workers })).toBe(3);
    expect(D.waitingCount(board, [t('t6')], { realpaths, workers })).toBe(3);
    expect(D.waitingCount(board, [t('t5'), t('t6')], { realpaths, workers })).toBe(4);
  });

  test('a card counts once; a blocked terminal with no card, or a non-blocked one, adds nothing', () => {
    const terms = [
      labelled('t1', 'gh-1'),
      labelled('t2', 'gh-1'),
      labelled('t3', 'gh-2'),
      labelled('t4', 'gh-404'),
      labelled('t8', 'gh-5', 'working'),
      { address: 't9', status: 'blocked', labels: {} },
    ];
    expect(D.waitingCount(board, terms, { realpaths, workers: D.parseWorkers(workersText) })).toBe(3);
  });

  test('no waiting card gives null; an unchanged count makes no setShared call', () => {
    const quiet = { [P]: [row({ task: 'gh-1', lane: 'Working' })] };
    expect(D.waitingCount(quiet, [], { realpaths, workers: noWorkers })).toBeNull();
    const calls: unknown[][] = [];
    let value: unknown;
    const io = {
      shared: () => value,
      setShared: (k: string, v: unknown) => {
        calls.push([k, v]);
        value = v;
      },
    };
    expect(D.publishWaiting(null, io)).toBe(false);
    expect(D.publishWaiting(3, io)).toBe(true);
    expect(D.publishWaiting(3, io)).toBe(false);
    expect(D.publishWaiting(null, io)).toBe(true);
    expect(calls).toEqual([
      [D.WAITING_KEY, 3],
      [D.WAITING_KEY, null],
    ]);
    expect(D.WAITING_KEY).toBe('genie.tasks.waiting');
  });

  test("the terminal icon joins the card's live worker, task.lead first", () => {
    const terms = [
      { ...labelled('t1', 'gh-1', 'working'), labels: { ...labelled('t1', 'gh-1').labels, 'worker.of': 'b-other' } },
      { ...labelled('t2', 'gh-1', 'idle'), labels: { ...labelled('t2', 'gh-1').labels, 'worker.of': 'b-lead' } },
      { address: 't3', state: 'dead', status: null, labels: labelled('t3', 'gh-5').labels },
    ];
    const card = (task: string) => D.lanesOf(P, board[P], null, NOW)[0].cards.find((c) => c.id === task);
    expect(D.terminalFor(card('gh-1'), terms, { realpaths, workers: noWorkers })).toBe('t2');
    expect(D.terminalFor(card('gh-5'), terms, { realpaths, workers: noWorkers })).toBeNull();
    const fallback = D.parseWorkers(
      `${JSON.stringify({ event: 'start', kind: 'worker', terminal: 't6', botId: 'b-lead', lead: 'b-lead', worktree: '/work/repo.worktrees/gh-6', project: P })}\n`,
    );
    expect(
      D.terminalFor(card('gh-6'), [{ address: 't6', state: 'live', status: 'idle', labels: {} }], {
        realpaths,
        workers: fallback,
      }),
    ).toBe('t6');
  });

  test('a labelled terminal with no lead identity is not the lead; the explicit lead wins though listed second', () => {
    const base = labelled('t0', 'gh-1', 'working').labels;
    const noLead = { task: base.task, 'task.project': base['task.project'] }; // neither worker.of nor task.lead
    const terms = [
      { address: 't-unknown', state: 'live', status: 'working', labels: noLead },
      { address: 't-empty', state: 'live', status: 'working', labels: { ...noLead, 'task.lead': '', 'worker.of': '' } },
      { address: 't-lead', state: 'live', status: 'idle', labels: { ...base, 'worker.of': 'b-lead' } },
    ];
    const card = D.lanesOf(P, board[P], null, NOW)[0].cards.find((c) => c.id === 'gh-1');
    expect(D.terminalFor(card, terms, { realpaths, workers: noWorkers })).toBe('t-lead');
    expect(D.terminalFor(card, terms.slice(0, 2), { realpaths, workers: noWorkers })).toBe('t-unknown');
  });

  test("an unlabelled worker is the lead when its botId is the card's lead, even with no lead on its start row", () => {
    const start = (terminal: string, botId: string) =>
      JSON.stringify({
        event: 'start',
        kind: 'worker',
        terminal,
        botId,
        worktree: '/work/repo.worktrees/gh-6',
        project: P,
      });
    const workers = D.parseWorkers(`${start('t-other', 'b-other')}\n${start('t-lead', 'b-lead')}\n`);
    const terms = ['t-other', 't-lead'].map((address) => ({ address, state: 'live', status: 'idle', labels: {} }));
    const card = D.lanesOf(P, board[P], null, NOW)[0].cards.find((c) => c.id === 'gh-6');
    expect(card.lead).toBe('b-lead');
    expect(D.terminalFor(card, terms, { realpaths, workers })).toBe('t-lead');
    // A card with no lead falls back to the start row's own lead.
    const leadless = { ...card, lead: null };
    const rows = D.parseWorkers(
      `${JSON.stringify({ event: 'start', kind: 'worker', terminal: 't-other', botId: 'b-other', lead: 'b-x', worktree: '/work/repo.worktrees/gh-6', project: P })}\n${JSON.stringify({ event: 'start', kind: 'worker', terminal: 't-lead', botId: 'b-x', lead: 'b-x', worktree: '/work/repo.worktrees/gh-6', project: P })}\n`,
    );
    expect(D.terminalFor(leadless, terms, { realpaths, workers: rows })).toBe('t-lead');
  });
});

describe('T6 degradation', () => {
  test("no binary gives one line naming 'genie update' and the path", () => {
    const line = D.missingBinaryLine('/h/.genie/plugins/genie-rs/bin/genie-rs');
    expect(line).toBe("genie-rs not found: run 'genie update' (/h/.genie/plugins/genie-rs/bin/genie-rs)");
    expect(line).not.toContain('\n');
  });

  test('BIN_SCRIPT resolves GENIE_RS_BIN, then <GENIE_HOME>/plugins/genie-rs/bin/genie-rs; a rejection is missing', async () => {
    const root = tmp();
    const bin = join(root, 'home', 'plugins', 'genie-rs', 'bin', 'genie-rs');
    mkdirSync(join(bin, '..'), { recursive: true });
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    const outcome = (env: Record<string, string>) => {
      const r = sh(D.BIN_SCRIPT, [], { GENIE_RS_BIN: '', ...env });
      return D.parseBin({ ok: r.code === 0, code: r.code, stdout: r.stdout, stderr: r.stderr, error: null });
    };
    expect(outcome({ GENIE_HOME: join(root, 'home') })).toEqual({ found: true, path: bin });
    expect(outcome({ GENIE_HOME: join(root, 'nohome') })).toEqual({
      found: false,
      path: join(root, 'nohome', 'plugins', 'genie-rs', 'bin', 'genie-rs'),
    });
    expect(outcome({ GENIE_HOME: join(root, 'home'), GENIE_RS_BIN: join(root, 'missing') })).toEqual({
      found: false,
      path: join(root, 'missing'),
    });
    // A file that cannot be executed is not a binary.
    const plain = join(root, 'plain-genie-rs');
    writeFileSync(plain, '#!/bin/sh\n');
    chmodSync(plain, 0o644);
    expect(outcome({ GENIE_RS_BIN: plain })).toEqual({ found: false, path: plain });
    const rejected = await D.settle(Promise.reject(new Error('spawn sh ENOENT')));
    expect(rejected.ok).toBe(false);
    expect(D.parseBin(rejected).found).toBe(false);
  });

  test('a failed forge-sync (non-zero exit or rejection) still lists the project and shows the note', async () => {
    const projects = ['/a', '/b'];
    let plan = D.planTick(D.initialState(), { now: 0, projects, focused: null, neverSynced: new Set(), results: {} });
    expect(plan.sync).toEqual(['/a', '/b']);
    const exit1 = await D.settle(Promise.resolve({ code: 1, stdout: '', stderr: 'gh: offline' }));
    const rejected = await D.settle(Promise.reject(new Error('timed out')));
    const results = { '/a': D.syncOk(exit1), '/b': D.syncOk(rejected) };
    expect(results).toEqual({ '/a': false, '/b': false });
    plan = D.planTick(plan.state, { now: MIN, projects, focused: null, neverSynced: new Set(), results });
    expect(plan.list).toEqual(projects);
    expect(plan.sync).toEqual([]);
    expect(D.forgeNote(plan.state, '/a')).toBe('forge not synced');
    expect(D.forgeNote(plan.state, '/b')).toBe('forge not synced');
    expect(D.forgeNote(D.initialState(), '/a')).toBeNull();
  });

  test('a failed list keeps the last good list with its age', async () => {
    const good = D.applyList(undefined, ok(JSON.stringify([row({ task: 'gh-1' })])), NOW);
    expect(good).toMatchObject({ hidden: false, stale: false, at: NOW });
    const failures = [
      ok('', 1),
      ok('not json'),
      ok('{"an":"object"}'),
      await D.settle(Promise.reject(new Error('timed out'))),
    ];
    for (const outcome of failures) {
      const kept = D.applyList(good, outcome, NOW + 5 * MIN);
      expect(kept.rows).toEqual(good.rows);
      expect(kept).toMatchObject({ stale: true, at: NOW, hidden: false });
      expect(D.listAge(kept, NOW + 5 * MIN)).toBe('5m');
    }
    expect(D.applyList(undefined, ok('', 1), NOW)).toMatchObject({ rows: [], stale: true, at: null });
  });

  test('an older list without the row-1 fields yields nulls', () => {
    const old = {
      task: 'gh-1',
      task_key: 'gh-1',
      state: 'opened',
      lane: 'Review',
      title: 't',
      lead: null,
      forge: 'github',
      url: 'u',
      branch: 'b',
      updated_at: '2026-11-01T00:00:00Z',
    };
    const [r] = D.applyList(undefined, ok(JSON.stringify([old])), NOW).rows;
    expect(r).toMatchObject({
      created_at: null,
      opened_at: null,
      merged_at: null,
      closed_at: null,
      worktree: null,
      project: null,
    });
    expect(D.lanesOf(P, [r], null, NOW)[1].cards[0].id).toBe('gh-1');
  });
});

describe('refresh (data.js `refresh`, the host injected)', () => {
  const BIN = '/opt/genie/bin/genie-rs';
  const REPO = '/work/repo';
  type Reply = { code: number; stdout?: string } | Error;
  /** A fake host. `bin` answers `genie-rs` runs; BIN_SCRIPT finds BIN while `binThere()`. */
  function host({
    bin,
    binThere = () => true,
    terminals = [] as unknown[],
    workersText = '',
  }: { bin: (args: string[]) => Reply; binThere?: () => boolean; terminals?: unknown[]; workersText?: string }) {
    const calls: string[][] = [];
    const answer = (r: Reply) =>
      r instanceof Error ? Promise.reject(r) : Promise.resolve({ stdout: '', stderr: '', ...r });
    const io = {
      exec: (cmd: string, args: string[] = []) => {
        calls.push([cmd, ...args]);
        if (cmd === 'sh' && args[1] === D.BIN_SCRIPT) return answer({ code: binThere() ? 0 : 1, stdout: `${BIN}\n` });
        if (cmd === 'sh' && args[1] === D.REALPATH_SCRIPT) return answer({ code: 0, stdout: '' });
        if (cmd === 'tail') return answer({ code: 0, stdout: workersText });
        if (cmd === 'automagik-herdr') return answer({ code: 3 });
        if (cmd === BIN) return answer(bin(args));
        return answer(new Error(`unexpected exec ${cmd}`));
      },
      probe: (folders: string[]) => {
        calls.push(['probe', ...folders]);
        return Promise.resolve({ code: 0, stdout: `synced\t${REPO}\n`, stderr: '' });
      },
      spaces: () => [{ folder: REPO, machine: null }],
      home: () => '/home/me',
      terminals: () => terminals,
      focusedFolder: () => null,
      workersFile: '/app/automagik-herdr/workers.jsonl',
      now: () => NOW,
      notify: () => {},
      published: [] as unknown[],
      publish: () => {},
    };
    return { io, calls };
  }
  const listJson = JSON.stringify([row({ task: 'gh-1', lane: 'Review' }), row({ task: 'gh-2', lane: 'Working' })]);
  const enoent = () => Object.assign(new Error(`spawn ${BIN} ENOENT`), { code: 'ENOENT' });
  const runs = (calls: string[][], verb: string) => calls.filter((c) => c[0] === BIN && c[1] === verb).length;
  const binScripts = (calls: string[][]) => calls.filter((c) => c[0] === 'sh' && c[2] === D.BIN_SCRIPT).length;

  test('discovery finds the binary but launching it rejects: the missing-binary line, then a re-resolve', async () => {
    const m = D.newModel();
    const { io, calls } = host({ bin: () => enoent() });
    await D.refresh(m, io);
    expect(m.bin).toEqual({ found: false, path: BIN });
    expect(D.missingBinaryLine(m.bin.path)).toBe(`genie-rs not found: run 'genie update' (${BIN})`);
    expect(runs(calls, 'forge-sync')).toBe(0);
    expect(m.lists[REPO]).toBeUndefined();
    await D.refresh(m, io);
    expect(binScripts(calls)).toBeGreaterThanOrEqual(2); // resolved again on the later refresh
  });

  test('the binary disappears after a good refresh: the missing-binary line, whatever the rejection says', async () => {
    let there = true;
    let gone = false;
    const m = D.newModel();
    const { io } = host({
      bin: (args) => (gone ? new Error('boom') : args[0] === 'list' ? { code: 0, stdout: listJson } : { code: 0 }),
      binThere: () => there,
    });
    await D.refresh(m, io);
    expect(m.bin).toEqual({ found: true, path: BIN });
    expect(m.lists[REPO].rows).toHaveLength(2);
    there = false;
    gone = true;
    await D.refresh(m, io);
    expect(m.bin).toEqual({ found: false, path: BIN });
    expect(m.lists[REPO].rows).toHaveLength(2); // the last good list is kept for when it returns
    there = true;
    gone = false;
    await D.refresh(m, io);
    expect(m.bin).toEqual({ found: true, path: BIN });
  });

  test('a timeout or a non-zero exit keeps the binary: a stale list and the forge backoff', async () => {
    for (const mode of ['timeout', 'exit'] as const) {
      let fail = false;
      const m = D.newModel();
      const { io } = host({
        bin: (args) => {
          if (fail && mode === 'timeout') return new Error('the command took longer than 30 s');
          if (fail) return { code: 1 };
          return args[0] === 'list' ? { code: 0, stdout: listJson } : { code: 0 };
        },
      });
      await D.refresh(m, io);
      fail = true;
      await D.refresh(m, io);
      expect(m.bin).toEqual({ found: true, path: BIN });
      expect(m.lists[REPO]).toMatchObject({ stale: true });
      expect(m.lists[REPO].rows).toHaveLength(2);
      expect(m.results).toEqual({ [REPO]: false });
    }
  });

  test('workers.jsonl is not read while every relevant terminal carries the task labels', async () => {
    const terminals = [
      {
        address: 't1',
        state: 'live',
        status: 'blocked',
        labels: { task: 'gh-2', 'task.project': REPO, 'worker.of': 'b', 'task.lead': 'b' },
      },
      { address: 't9', state: 'live', status: 'working', labels: {} }, // a shell: neither blocked nor a worker
    ];
    const m = D.newModel();
    const { io, calls } = host({
      bin: (args) => (args[0] === 'list' ? { code: 0, stdout: listJson } : { code: 0 }),
      terminals,
    });
    const exec = io.exec;
    io.exec = (cmd: string, args: string[] = []) => {
      if (cmd === 'tail') throw new Error('workers.jsonl read with every worker labelled');
      return exec(cmd, args);
    };
    await D.refresh(m, io);
    expect(calls.some((c) => c[0] === 'tail')).toBe(false);
    expect(D.waitingOf(m, terminals)).toBe(2);
  });

  test('an unlabelled blocked worker reads the workers.jsonl tail and joins through it', async () => {
    const terminals = [{ address: 't5', state: 'live', status: 'blocked', labels: { 'worker.of': 'b' } }];
    const workersText = `${JSON.stringify({ event: 'start', kind: 'worker', terminal: 't5', task: 'gh-2', project: REPO })}\n`;
    const m = D.newModel();
    const { io, calls } = host({
      bin: (args) => (args[0] === 'list' ? { code: 0, stdout: listJson } : { code: 0 }),
      terminals,
      workersText,
    });
    await D.refresh(m, io);
    expect(calls.filter((c) => c[0] === 'tail')).toEqual([
      ['tail', '-n', '2000', '/app/automagik-herdr/workers.jsonl'],
    ]);
    expect(D.waitingOf(m, terminals)).toBe(2);
  });
});

describe('T7 forge budget', () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `/p/${String(i).padStart(3, '0')}`);
  type Sim = {
    projects: (m: number) => string[];
    focused: string | null;
    never?: (m: number) => Set<string>;
    fails?: (p: string, m: number) => boolean;
    minutes: number;
  };
  function simulate({ projects, focused, never = () => new Set(), fails = () => false, minutes }: Sim) {
    let state = D.initialState();
    let results: Record<string, boolean> = {};
    const plans = [];
    for (let m = 0; m < minutes; m += 1) {
      const plan = D.planTick(state, { now: m * MIN, projects: projects(m), focused, neverSynced: never(m), results });
      plans.push(plan);
      state = plan.state;
      results = Object.fromEntries(plan.sync.map((p: string) => [p, !fails(p, m)]));
    }
    return plans;
  }
  /** The longest run of minutes a project waited (from `from`, or between two syncs) over the run. */
  function longestWait(plans: { sync: string[] }[], p: string, from = 0): number {
    let last = from - 1;
    let worst = 0;
    for (let m = from; m < plans.length; m += 1) {
      if (plans[m].sync.includes(p)) {
        worst = Math.max(worst, m - last);
        last = m;
      }
    }
    return Math.max(worst, plans.length - last);
  }

  test('cap: no minute plans more than 10, the focused project first; every tick lists all 128', () => {
    const all = names(128);
    const plans = simulate({ projects: () => all, focused: all[40], minutes: 60 });
    for (const plan of plans) {
      expect(plan.sync.length).toBeLessThanOrEqual(10);
      expect(plan.sync[0]).toBe(all[40]);
      expect(new Set(plan.sync).size).toBe(plan.sync.length);
      expect(plan.list).toEqual(all);
    }
  });

  test('rotation: every synced project is reached within ceil(127/9) = 15 minutes', () => {
    const all = names(128);
    const plans = simulate({ projects: () => all, focused: all[0], minutes: 60 });
    for (const p of all) expect(longestWait(plans, p)).toBeLessThanOrEqual(15);
  });

  test('never-synced: at most one a minute, all 20 reached within 20 minutes', () => {
    const all = names(128);
    const never = new Set(all.filter((_, i) => i % 6 === 1).slice(0, 20));
    expect(never.size).toBe(20);
    const plans = simulate({ projects: () => all, focused: all[0], never: () => never, minutes: 20 });
    for (const plan of plans) expect(plan.sync.filter((p: string) => never.has(p)).length).toBeLessThanOrEqual(1);
    const reached = new Set(plans.flatMap((plan) => plan.sync.filter((p: string) => never.has(p))));
    expect(reached).toEqual(never);
  });

  test('a never-synced focused project goes first and is that minute’s one never-synced project', () => {
    const all = names(128);
    const never = new Set(all.slice(0, 20));
    const plans = simulate({ projects: () => all, focused: all[0], never: () => never, minutes: 30 });
    for (const plan of plans) {
      expect(plan.sync[0]).toBe(all[0]);
      expect(plan.sync.filter((p: string) => never.has(p))).toEqual([all[0]]);
    }
  });

  test('backoff: three failures skip 1, 2 and 4 minutes, never more than 60; a success resets it', () => {
    const all = names(4);
    const failUntil = 300;
    const plans = simulate({
      projects: () => all,
      focused: all[0],
      fails: (p, m) => p === all[0] && m < failUntil,
      minutes: 320,
    });
    const at = plans.flatMap((plan, m) => (plan.sync.includes(all[0]) ? [m] : []));
    const skipped = at.slice(1).map((m, i) => m - at[i] - 1);
    expect(skipped.slice(0, 3)).toEqual([1, 2, 4]);
    expect(Math.max(...skipped)).toBe(60);
    const firstSuccess = at.find((m) => m >= failUntil) as number;
    expect(at.filter((m) => m > firstSuccess).slice(0, 3)).toEqual([
      firstSuccess + 1,
      firstSuccess + 2,
      firstSuccess + 3,
    ]);
    // The other projects are not held back by it.
    for (const p of all.slice(1)) expect(longestWait(plans, p)).toBe(1);
  });

  test('cut first pass: PROBE_SCRIPT classifies missing and "since":null as never-synced until since is a number', () => {
    const root = tmp();
    const home = join(root, 'genie-home');
    const missing = project(root, 'missing');
    const cut = project(root, 'cut');
    const done = project(root, 'done');
    const repointed = project(root, 'repointed');
    writeCursor(home, cut, '{"origin":"git@github.com:o/r.git","since":null,"seen":{"u@1":true}}');
    writeCursor(home, done, '{"origin":"git@github.com:o/r.git","since":1762250000,"seen":{}}');
    writeCursor(home, repointed, '{"origin":"git@github.com:old/r.git","since":1762250000,"seen":{}}');
    const folders = [missing, cut, done, repointed];
    const probe = () => D.parseProbe(sh(D.PROBE_SCRIPT, folders, { GENIE_HOME: home }).stdout);

    let found = probe();
    const real = folders.map((f) => realpathSync(f));
    expect([...found.projects].sort()).toEqual([...real].sort());
    expect(found.neverSynced).toEqual(new Set([real[0], real[1]]));

    // Cut passes: the cursor keeps "since":null, so the project stays in the one-a-minute lane.
    let state = D.initialState();
    for (let m = 0; m < 4; m += 1) {
      found = probe();
      const plan = D.planTick(state, { now: m * MIN, ...found, focused: null, results: {} });
      expect(plan.sync.filter((p: string) => found.neverSynced.has(p)).length).toBe(1);
      expect(plan.sync).toEqual(expect.arrayContaining([real[2], real[3]]));
      state = plan.state;
    }
    // A completed pass writes a number: the next probe moves it to the synced lane.
    writeCursor(home, cut, '{"origin":"git@github.com:o/r.git","since":1762260000,"seen":{}}');
    found = probe();
    expect(found.neverSynced).toEqual(new Set([real[0]]));
    const plan = D.planTick(state, { now: 4 * MIN, ...found, focused: null, results: {} });
    expect(plan.sync).toEqual(expect.arrayContaining([real[0], real[1], real[2], real[3]]));
  });

  test('no overlap: a tick fired while the last one is pending is skipped, never queued', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const tick = D.skipWhileBusy(() => {
      calls += 1;
      return new Promise<void>((r) => {
        release = r;
      });
    });
    tick();
    tick();
    tick();
    expect(calls).toBe(1);
    release();
    await Bun.sleep(0);
    tick();
    expect(calls).toBe(2);
    release();
    await Bun.sleep(0);
    const failing = D.skipWhileBusy(() => {
      calls += 1;
      return Promise.reject(new Error('boom'));
    });
    failing();
    await Bun.sleep(0);
    failing();
    expect(calls).toBe(4);
  });

  test('re-probe: dropping and adding projects mid-rotation keeps the pointer within the bound', () => {
    const first = names(128);
    let dropped: string[] = [];
    let after: string[] = [];
    const projects = (m: number) => (m < 7 ? first : after);
    let state = D.initialState();
    const plans = [];
    for (let m = 0; m < 40; m += 1) {
      if (m === 7) {
        const pointer = plans[6].sync.at(-1) as string;
        dropped = [pointer, ...first.filter((p) => p !== pointer && p !== first[0]).slice(0, 9)];
        after = [...first.filter((p) => !dropped.includes(p)), '/p/new-a', '/p/055x', '/p/zzz'].sort();
      }
      const plan = D.planTick(state, {
        now: m * MIN,
        projects: projects(m),
        focused: first[0],
        neverSynced: new Set(),
        results: {},
      });
      plans.push(plan);
      state = plan.state;
    }
    for (const p of after) expect(longestWait(plans, p, 7)).toBeLessThanOrEqual(15);
    for (const p of dropped) expect(plans.slice(7).some((plan) => plan.sync.includes(p))).toBe(false);
  });

  test('at most 8 spawns in flight at once', async () => {
    let live = 0;
    let peak = 0;
    const out = await D.mapLimit(names(30), 8, async (p: string) => {
      live += 1;
      peak = Math.max(peak, live);
      await Bun.sleep(1);
      live -= 1;
      return p.length;
    });
    expect(peak).toBe(8);
    expect(out).toHaveLength(30);
  });
});

describe('the mod', () => {
  test('main.js runs the imported PROBE_SCRIPT, never a second copy of the loop', () => {
    const main = readFileSync(join(import.meta.dir, 'main.js'), 'utf8');
    expect(main).toContain("exec('sh', ['-c', PROBE_SCRIPT, 'sh', ...folders])");
    expect(main).not.toContain('shasum');
    expect(main).not.toContain('pwd -P');
    expect(readFileSync(join(import.meta.dir, 'data.js'), 'utf8')).not.toMatch(/^import /m);
  });

  test('mod.json: place none, a 1x1 popup, and the one Tasks footer entry with the badge', () => {
    const mod = JSON.parse(readFileSync(join(import.meta.dir, 'mod.json'), 'utf8'));
    expect(mod.place).toBe('none');
    expect(mod.overlay).toMatchObject({ kind: 'popup', width: 1, height: 1 });
    expect(mod.automagik.footer).toEqual([
      {
        id: 'tasks',
        label: 'Tasks',
        icon: 'mods/genie-herdr/tasks.svg',
        command: 'mod.open',
        args: { name: 'genie-herdr' },
        badge: 'genie.tasks.waiting',
      },
    ]);
  });
});
