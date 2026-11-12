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
  readdirSync,
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
const tokensOf = (total: number) => ({
  input: total,
  cache_read: 0,
  cache_write_5m: 0,
  cache_write_1h: 0,
  output: 0,
  reasoning: 0,
  unsplit: 0,
  total,
});
const costOf = (state: string, usd: number | null) => ({
  state,
  usd,
  usd_reported: null,
  usd_estimated: usd,
  tokens_priced: usd != null ? 100 : 0,
  tokens_reported: 0,
  tokens_unpriced: state === 'partial' || state === 'unpriced' ? 50 : 0,
  unpriced_models: state === 'partial' || state === 'unpriced' ? ['custom-m'] : [],
  unpriced_models_omitted: 0,
});
const actorOf = (bot = 'b-lead') => ({
  bot,
  kind: 'worker',
  role: 'engineer',
  squad: 'core',
  unrecorded: [],
  harness: 'codex',
  usd: null,
  work_min: null,
});

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
    const lanes = D.lanesOf(P, rows);
    expect(lanes.map((l) => l.key)).toEqual(['Working', 'Review', 'Merged', 'Closed']);
    const ids = Object.fromEntries(lanes.map((l) => [l.key, l.cards.map((c) => c.id)]));
    expect(ids).toEqual({ Working: ['gh-1'], Review: ['gh-2', 'untracked'], Merged: ['gh-3'], Closed: ['gh-4'] });
  });

  test('a null task renders "untracked" with its url', () => {
    const card = D.lanesOf(P, rows)[1].cards.find((c) => c.untracked);
    expect(card.id).toBe('untracked');
    expect(card.url).toBe('https://github.com/o/r/pull/9');
  });

  test('the card carries title, id, lead, lane, cost, time and ETA, and no action', () => {
    const card = D.lanesOf(P, rows)[0].cards[0];
    expect(card).toMatchObject({ id: 'gh-1', title: 'one', lead: 'b-lead', lane: 'Working' });
    for (const k of ['cost', 'time', 'eta']) expect(typeof card[k]).toBe('string');
    for (const k of Object.keys(card)) expect(k).not.toMatch(/^(action|actions|buttons|on[A-Z].*)$/);
    expect(Object.values(card).some((v) => typeof v === 'function')).toBe(false);
  });

  test('newest updated_at first, at most 12 cards a lane, with the total kept', () => {
    const many = Array.from({ length: 14 }, (_, i) => row({ task: `gh-${i}`, updated_at: iso(NOW - (14 - i) * MIN) }));
    const working = D.lanesOf(P, many)[0];
    expect(working.cards).toHaveLength(12);
    expect(working.total).toBe(14);
    expect(working.cards[0].id).toBe('gh-13');
  });
});

describe('T4 cost, time and ETA', () => {
  const rows = [
    row({
      task: 'gh-1',
      lane: 'Working',
      state: 'created',
      created_at: iso(NOW - 90 * MIN),
      task_open_min: 90,
      pr_open_min: null,
      meter_state: 'measured',
      meter_reason: null,
      tokens: tokensOf(1500),
      cost: costOf('priced', 1.5),
      activity_hours: 2,
      actors: [actorOf()],
    }),
    row({
      task: 'gh-2',
      lane: 'Working',
      branch: 'feat/gh-2',
      meter_state: 'missing',
      meter_reason: 'no_task_usage',
      tokens: null,
      cost: null,
      branch_usage: {
        branch: 'feat/gh-2',
        state: 'measured',
        reason: null,
        tokens: tokensOf(4200),
        cost: costOf('priced', 4.25),
        activity_hours: 3,
      },
    }),
    row({
      task: 'gh-3',
      state: 'merged',
      lane: 'Merged',
      pr_lead_min: 60,
      task_lead_min: 60,
      meter_state: 'zero',
      tokens: tokensOf(0),
      cost: costOf('zero', 0),
    }),
    row({
      task: null,
      state: 'opened',
      lane: 'Review',
      pr_open_min: 300,
      url: 'https://github.com/o/r/pull/9',
      meter_state: 'measured',
      tokens: tokensOf(2000),
      cost: costOf('partial', 2),
    }),
    row({ task: 'gh-4', state: 'closed', lane: 'Closed', meter_state: 'missing', meter_reason: 'outside_d30_window' }),
    row({
      task: 'gh-old1',
      state: 'merged',
      lane: 'Merged',
      pr_lead_min: 120,
      task_lead_min: 120,
      meter_state: 'measured',
      tokens: tokensOf(3000),
      cost: costOf('priced', 3),
    }),
    row({
      task: 'gh-old2',
      state: 'merged',
      lane: 'Merged',
      pr_lead_min: 240,
      task_lead_min: 240,
      meter_state: 'measured',
      tokens: tokensOf(3000),
      cost: costOf('priced', 3),
    }),
  ];
  const cards = (listRows = rows) =>
    Object.fromEntries(
      D.lanesOf(P, listRows).flatMap((l) => l.cards.map((c) => [c.id === 'untracked' ? c.url : c.id, c])),
    );

  test('null renders "–", a measured 0 renders $0.00 and 0m', () => {
    expect(D.fmtUsd(null)).toBe('–');
    expect(D.fmtUsd(0)).toBe('$0.00');
    expect(D.fmtUsd(1.234)).toBe('$1.23');
    expect(D.fmtMin(null)).toBe('–');
    expect(D.fmtMin(0)).toBe('0m');
    expect(D.fmtMin(90)).toBe('1.5h');
  });

  test('single cost path from genie-rs list --json: docFeed and feedRows are retired', () => {
    expect(['docFeed' in D, 'feedRows' in D, 'feedRowFor' in D]).toEqual([false, false, false]);
    const dataSrc = readFileSync(join(import.meta.dir, 'data.js'), 'utf8');
    const mainSrc = readFileSync(join(import.meta.dir, 'main.js'), 'utf8');
    expect(dataSrc.includes('herdr-meter') || mainSrc.includes('herdr-meter')).toBe(false);
    expect(dataSrc.includes('KNOWN_PREVIOUS_REPO_SLUGS') || mainSrc.includes('KNOWN_PREVIOUS_REPO_SLUGS')).toBe(false);
    expect(mainSrc).toContain('Branch usage (d30, not task-isolated)');
  });

  test('renders measured priced and partial costs, zero only on zero state, and actors/branch_usage', () => {
    const c = cards();
    expect(c['gh-1']).toMatchObject({
      meter_state: 'measured',
      cost_state: 'priced',
      meter_reason: null,
      usd: 1.5,
      cost: '$1.50',
      cost_badge: null,
      tokens: 1500,
      work_min: null,
      activity_hours: 2,
      branch_usage: null,
      bots: [actorOf()],
    });
    expect(c['gh-3']).toMatchObject({
      meter_state: 'zero',
      cost_state: 'zero',
      usd: 0,
      cost: '$0.00',
      cost_badge: null,
      tokens: 0,
    });
    expect(c['https://github.com/o/r/pull/9']).toMatchObject({
      meter_state: 'measured',
      cost_state: 'partial',
      usd: 2,
      cost: '$2.00',
      cost_badge: 'partial',
      tokens: 2000,
    });
    expect(c['gh-2']).toMatchObject({
      meter_state: 'missing',
      meter_reason: 'no_task_usage',
      usd: null,
      cost: '–',
      cost_badge: null,
      tokens: null,
      branch_usage: {
        branch: 'feat/gh-2',
        state: 'measured',
        cost_state: 'priced',
        reason: null,
        tokens_total: 4200,
        usd: 4.25,
        cost_text: '$4.25',
        cost_badge: null,
        activity_hours: 3,
      },
    });
  });

  test('missing, stale, unsupported and unpriced states render "–" with reason and never $0.00', () => {
    const c = cards([
      row({ task: 't-missing', meter_state: 'missing', meter_reason: 'absent_store', cost: null, tokens: null }),
      row({
        task: 't-old-meter',
        meter_state: 'missing',
        meter_reason: 'needs usagemeter >= 3.129.2',
        cost: null,
        tokens: null,
      }),
      row({
        task: 't-stale-num',
        meter_state: 'stale',
        meter_reason: 'ingestion_stale',
        tokens: tokensOf(800),
        cost: costOf('priced', 9.5),
      }),
      row({ task: 't-stale-null', meter_state: 'stale', meter_reason: 'ingestion_stale', tokens: null, cost: null }),
      row({
        task: 't-unsupported',
        meter_state: 'unsupported',
        meter_reason: 'source_unsupported',
        tokens: null,
        cost: null,
      }),
      row({
        task: 't-unpriced',
        meter_state: 'measured',
        meter_reason: null,
        tokens: tokensOf(1200),
        cost: costOf('unpriced', null),
      }),
      row({
        task: 't-measured-zero-cost',
        meter_state: 'measured',
        meter_reason: null,
        tokens: tokensOf(0),
        cost: costOf('zero', 0),
      }),
    ]);
    expect(c['t-missing']).toMatchObject({ cost: '–', usd: null, tokens: null, meter_reason: 'absent_store' });
    expect(c['t-old-meter']).toMatchObject({
      cost: '–',
      usd: null,
      tokens: null,
      meter_reason: 'needs usagemeter >= 3.129.2',
    });
    expect(c['t-stale-num']).toMatchObject({ cost: '–', usd: null, tokens: null, meter_reason: 'ingestion_stale' });
    expect(c['t-stale-null']).toMatchObject({ cost: '–', usd: null, tokens: null, meter_reason: 'ingestion_stale' });
    expect(c['t-unsupported']).toMatchObject({
      cost: '–',
      usd: null,
      tokens: null,
      meter_reason: 'source_unsupported',
    });
    expect(c['t-unpriced']).toMatchObject({
      cost: '–',
      usd: null,
      tokens: 1200,
      cost_state: 'unpriced',
      meter_reason: 'unpriced_models',
    });
    expect(c['t-measured-zero-cost']).toMatchObject({ cost: '$0.00', usd: 0, tokens: 0, cost_state: 'zero' });
  });

  test('list task and PR times drive open and terminal cards; missing list time stays unknown', () => {
    const c = cards();
    expect(c['gh-3'].time).toBe('1.0h');
    expect(c['gh-1'].time).toBe('1.5h');
    expect(c['gh-2'].time).toBe('–');
    expect(c['gh-2'].eta).toBe('–');
  });

  test('ETA: past 60, 120, 240 with 90 elapsed gives ~1.5h left; 300 elapsed is over', () => {
    const history = D.historyOf(rows);
    expect(history).toEqual([60, 120, 240]);
    expect(D.etaText(D.estimateOf(90, history))).toBe('~1.5h');
    expect(D.etaText(D.estimateOf(300, history))).toBe('over');
    const c = cards();
    expect(c['gh-1'].eta).toBe('~1.5h');
    expect(c['gh-1'].merges).toBe(3);
    expect(c['https://github.com/o/r/pull/9'].eta).toBe('over');
  });

  test('ETA history includes only valid merged list samples from this project', () => {
    const samples = [
      ...rows,
      row({ state: 'closed', lane: 'Closed', pr_lead_min: 900 }),
      row({ state: 'opened', lane: 'Review', pr_lead_min: 800 }),
      row({ state: 'merged', lane: 'Merged', pr_lead_min: null }),
      row({ state: 'merged', lane: 'Merged', pr_lead_min: -1 }),
      row({ state: 'merged', lane: 'Merged', pr_lead_min: Number.NaN }),
      row({ state: 'merged', lane: 'Merged', pr_lead_min: 0 }),
    ];
    expect(D.historyOf(samples)).toEqual([0, 60, 120, 240]);
    const other = [{ task: 'other', state: 'merged', lane: 'Merged', pr_lead_min: 99999 }];
    expect(D.lanesOf('/other', other)[2].cards[0].merges).toBe(1);
    expect(cards()['gh-1'].est).toMatchObject({ basis: 2 });
    expect(cards()['gh-1'].merges).toBe(3);
  });

  test('Working and Review use separate comparable merged histories', () => {
    const samples = [
      row({ task: 'gh-1', state: 'created', created_at: iso(NOW - 30 * MIN), task_open_min: 30 }),
      row({ task: 'gh-2', state: 'opened', lane: 'Review', task_open_min: 90, pr_open_min: 10 }),
      row({ task: 'gh-3', state: 'merged', lane: 'Merged', task_lead_min: 120, pr_lead_min: 20 }),
      row({ task: 'gh-4', state: 'merged', lane: 'Merged', task_lead_min: null, pr_lead_min: 40 }),
      row({ task: 'gh-5', state: 'closed', lane: 'Closed', task_lead_min: 999 }),
    ];
    const lanes = D.lanesOf(P, samples);
    expect(lanes[0].cards[0]).toMatchObject({ time: '30m', eta: '~1.5h', merges: 1, est: { basis: 1 } });
    expect(lanes[1].cards[0]).toMatchObject({ time: '10m', eta: '~20m', merges: 2, est: { basis: 2 } });
    const legacy = D.lanesOf(P, [row({ pr_open_min: null, age_min: 900 })])[0].cards[0];
    expect(legacy).toMatchObject({ time: '–', eta: '–' });
  });

  test('terminal producer rows prefer task lead time and fall back to PR lead time', () => {
    const samples = D.applyList(
      null,
      ok(
        JSON.stringify([
          { task: 'gn-13', task_key: 'gn-13', state: 'merged', lane: 'Merged', task_lead_min: 15, pr_lead_min: 5 },
          {
            task: null,
            task_key: 'pr:github:https://github.com/o/r/pull/9',
            state: 'merged',
            lane: 'Merged',
            url: 'https://github.com/o/r/pull/9',
            task_lead_min: null,
            pr_lead_min: 29,
          },
          { task: 'gn-14', task_key: 'gn-14', state: 'closed', lane: 'Closed', task_lead_min: 0, pr_lead_min: 10 },
          {
            task: null,
            task_key: 'pr:github:https://github.com/o/r/pull/10',
            state: 'closed',
            lane: 'Closed',
            url: 'https://github.com/o/r/pull/10',
            task_lead_min: null,
            pr_lead_min: 12,
          },
          { task: 'gn-15', task_key: 'gn-15', state: 'merged', lane: 'Merged', task_lead_min: null, pr_lead_min: null },
          { task: 'gn-16', task_key: 'gn-16', state: 'merged', lane: 'Merged', task_lead_min: 30, pr_lead_min: null },
        ]),
      ),
      NOW,
    ).rows;
    const lanes = D.lanesOf(P, samples);
    expect(lanes[2].cards.map((c) => [c.time, c.lead_min])).toEqual([
      ['15m', 15],
      ['29m', 29],
      ['–', null],
      ['30m', 30],
    ]);
    expect(lanes[3].cards.map((c) => [c.time, c.lead_min])).toEqual([
      ['0m', 0],
      ['12m', 12],
    ]);
    expect(D.historyOf(samples)).toEqual([5, 29]);
    expect(D.historyOf(samples, 'task_lead_min')).toEqual([15, 30]);
  });

  test('meter activity_hours and branch_usage never supply card time, ETA, or card task cost', () => {
    const unknown = D.lanesOf(P, [row({ activity_hours: 100, work_min: 999 })])[0].cards[0];
    expect(unknown).toMatchObject({ time: '–', eta: '–', elapsed: null, lead_min: null, merges: 0, work_min: null });
    const known = D.lanesOf(P, rows)[0].cards.find((c) => c.id === 'gh-1');
    expect(known).toMatchObject({ time: '1.5h', eta: '~1.5h' });
    const closed = D.lanesOf(P, [row({ state: 'closed', lane: 'Closed', pr_lead_min: 0 })])[3].cards[0];
    expect(closed).toMatchObject({ time: '0m', eta: '–' });
    const old = D.normalizeRow({ task: 'gh-1' });
    expect([old.age_min, old.task_open_min, old.task_lead_min, old.pr_open_min, old.pr_lead_min]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  test('tasks with missing meter state keep cost unknown ("–") and preserve list time and ETA', () => {
    expect(cards()['gh-4']).toMatchObject({
      cost: '–',
      usd: null,
      meter_state: 'missing',
      meter_reason: 'outside_d30_window',
      time: '–',
      eta: '–',
    });
    const unmeasuredRows = rows.map((r) => ({
      ...r,
      meter_state: 'missing',
      meter_reason: 'usagemeter_unavailable',
      tokens: null,
      cost: null,
    }));
    const lanes = D.lanesOf(P, unmeasuredRows);
    expect(lanes.map((l) => l.cards.length)).toEqual([2, 1, 3, 1]);
    for (const card of lanes.flatMap((l) => l.cards)) {
      expect(card.cost).toBe('–');
      expect(card.usd).toBeNull();
    }
    expect(lanes[0].cards.find((c) => c.id === 'gh-1')).toMatchObject({ time: '1.5h', eta: '~1.5h' });
    expect(lanes[2].cards.find((c) => c.id === 'gh-3')?.time).toBe('1.0h');
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
    const card = (task: string) => D.lanesOf(P, board[P])[0].cards.find((c) => c.id === task);
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
    const card = D.lanesOf(P, board[P])[0].cards.find((c) => c.id === 'gh-1');
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
    const card = D.lanesOf(P, board[P])[0].cards.find((c) => c.id === 'gh-6');
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
      meter_state: null,
      meter_reason: null,
      tokens: null,
      cost: null,
      activity_hours: null,
      actors: null,
      work_min: null,
      branch_usage: null,
    });
    expect(D.lanesOf(P, [r])[1].cards[0]).toMatchObject({
      id: 'gh-1',
      cost: '–',
      usd: null,
      meter_state: 'missing',
      branch_usage: null,
      bots: [],
    });
  });
});

describe('refresh (data.js `refresh`, the host injected)', () => {
  const BIN = '/opt/genie/bin/genie-rs';
  const REPO = '/work/repo';
  type Reply = { code: number; stdout?: string; stderr?: string } | Error;
  /** D.LOGIN_CANDIDATES by name: the person's `$SHELL` (through /bin/sh), then /bin/zsh, then /bin/sh. */
  const SHELL_LABELS = ['$SHELL', '/bin/zsh', '/bin/sh'];
  /**
   * A fake host. `bin` answers `genie-rs` runs; BIN_SCRIPT finds BIN while `binThere()`. `login`
   * answers each login shell (by default none starts, so the inherited PATH is kept and every run
   * is unwrapped). A run through `/usr/bin/env PATH=<p>` lands in `wrapped` as typed and in `calls`
   * as the command it runs.
   */
  function host({
    bin,
    binThere = () => true,
    terminals = [] as unknown[],
    workersText = '',
    projects = [REPO],
    now = () => NOW,
    login = (_shell: string): Reply => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
  }: {
    bin: (args: string[]) => Reply;
    binThere?: () => boolean;
    terminals?: unknown[] | (() => unknown[]);
    workersText?: string;
    projects?: string[];
    now?: () => number;
    login?: (shell: string) => Reply;
  }) {
    const calls: string[][] = [];
    const wrapped: string[][] = [];
    const shells: string[] = [];
    const answer = (r: Reply) =>
      r instanceof Error ? Promise.reject(r) : Promise.resolve({ stdout: '', stderr: '', ...r });
    const io = {
      exec: (cmd: string, args: string[] = []): Promise<unknown> => {
        if (cmd === '/usr/bin/env') {
          wrapped.push([cmd, ...args]);
          return io.exec(args[1], args.slice(2));
        }
        const candidate = D.LOGIN_CANDIDATES.findIndex(
          ([c, a]) => c === cmd && a.length === args.length && a.every((x, i) => x === args[i]),
        );
        if (candidate >= 0) {
          const label = SHELL_LABELS[candidate];
          shells.push(label);
          return answer(login(label));
        }
        calls.push([cmd, ...args]);
        if (cmd === 'sh' && args[1] === D.BIN_SCRIPT) return answer({ code: binThere() ? 0 : 1, stdout: `${BIN}\n` });
        if (cmd === 'sh' && args[1] === D.REALPATH_SCRIPT) return answer({ code: 0, stdout: '' });
        if (cmd === 'tail') return answer({ code: 0, stdout: workersText });
        if (cmd === BIN) return answer(bin(args));
        return answer(new Error(`unexpected exec ${cmd}`));
      },
      probe: (folders: string[]) => {
        calls.push(['probe', ...folders]);
        return Promise.resolve({ code: 0, stdout: projects.map((p) => `synced\t${p}\n`).join(''), stderr: '' });
      },
      spaces: () => projects.map((folder) => ({ folder, machine: null })),
      home: () => '/home/me',
      terminals: () => (typeof terminals === 'function' ? terminals() : terminals),
      focusedFolder: () => null,
      workersFile: '/app/automagik-herdr/workers.jsonl',
      now,
      notify: () => {},
      published: [] as unknown[],
      publish: () => {},
    };
    return { io, calls, wrapped, shells };
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
      { address: 't9', state: 'live', status: 'working', labels: { bot: 'b-main' } }, // a bot's own pane: never a worker
      { address: 't8', state: 'dead', status: null, labels: {} }, // no longer live
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

  test('an unlabelled live worker keeps its icon while working, idle, blocked and working again', async () => {
    // A legacy worker: no labels at all, only its workers.jsonl start row joins it to gh-2.
    const workersText = `${JSON.stringify({ event: 'start', kind: 'worker', terminal: 't7', task: 'gh-2', project: REPO })}\n`;
    let status = 'working';
    const terminals = () => [{ address: 't7', state: 'live', status, labels: {} }];
    const m = D.newModel();
    const { io, calls } = host({
      bin: (args) => (args[0] === 'list' ? { code: 0, stdout: listJson } : { code: 0 }),
      terminals,
      workersText,
    });
    for (const s of ['working', 'idle', 'blocked', 'working']) {
      status = s;
      await D.refresh(m, io, { sync: false });
      const card = D.lanesOf(REPO, m.lists[REPO].rows)[0].cards.find((c) => c.id === 'gh-2');
      expect([s, D.terminalFor(card, terminals(), { realpaths: m.realpaths, workers: m.workers })]).toEqual([s, 't7']);
    }
    expect(calls.filter((c) => c[0] === 'tail')).toHaveLength(4);
  });

  test('a mixed forge batch: a finished exit 1 backs off and a finished success resets, though a sibling failed to launch', async () => {
    const A = '/work/a';
    const B = '/work/b';
    let minute = 0;
    const forge: Record<string, Reply> = {};
    const { io, calls } = host({
      projects: [A, B],
      now: () => minute * MIN,
      bin: (args) => (args[0] === 'list' ? { code: 0, stdout: '[]' } : (forge[args[2]] ?? { code: 0 })),
    });
    const synced = (at: number) =>
      calls
        .slice(at)
        .filter((c) => c[0] === BIN && c[1] === 'forge-sync')
        .map((c) => c[3]);

    // Case 1: A finishes with exit 1 while B fails to launch.
    let m = D.newModel();
    forge[A] = { code: 1 };
    forge[B] = enoent();
    await D.refresh(m, io);
    expect(m.bin).toEqual({ found: false, path: BIN }); // the missing-binary line still shows
    expect(m.results).toEqual({ [A]: false }); // B never launched: no result for it
    minute = 1;
    forge[A] = { code: 0 };
    forge[B] = { code: 0 };
    let at = calls.length;
    await D.refresh(m, io); // the binary runs again: resolved anew, A's failure is in the plan
    expect(m.bin).toEqual({ found: true, path: BIN });
    expect(synced(at)).toEqual([B]); // A sits out its one-minute backoff
    expect(m.sched.backoff[A]).toEqual({ fails: 1, until: 2 * MIN });

    // Case 2: A, two failures behind, finishes successfully while B fails to launch.
    m = D.newModel();
    m.sched = { pointer: null, neverPointer: null, backoff: { [A]: { fails: 2, until: 0 } } };
    minute = 0;
    forge[A] = { code: 0 };
    forge[B] = enoent();
    await D.refresh(m, io);
    expect(m.results).toEqual({ [A]: true });
    minute = 1;
    forge[A] = { code: 1 };
    forge[B] = { code: 0 };
    at = calls.length;
    await D.refresh(m, io); // the plan resets A, so A runs and fails once
    expect(synced(at)).toEqual([A, B]);
    expect(m.sched.backoff[A]).toBeUndefined();
    minute = 2;
    at = calls.length;
    await D.refresh(m, io);
    expect(m.sched.backoff[A]).toEqual({ fails: 1, until: 3 * MIN }); // one failure, one minute: not 3 and four
    expect(synced(at)).toEqual([B]);
  });

  const GH_MISSING =
    'genie-rs: gh could not be run (No such file or directory (os error 2)): install it and run gh auth login\n';

  test('the login PATH is resolved once and every genie-rs run (BIN_SCRIPT, list, forge-sync) carries it', async () => {
    const LOGIN = '/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin';
    const m = D.newModel();
    const { io, calls, wrapped, shells } = host({
      login: () => ({ code: 0, stdout: `Welcome!\n\n__GENIE_LOGIN_PATH__${LOGIN}` }),
      bin: (args) => (args[0] === 'list' ? { code: 0, stdout: listJson } : { code: 0 }),
    });
    await D.refresh(m, io);
    await D.refresh(m, io);
    expect(shells).toEqual(['$SHELL']); // once per model, the first shell that answered
    expect(m.path).toBe(LOGIN);
    expect(wrapped).toContainEqual(['/usr/bin/env', `PATH=${LOGIN}`, 'sh', '-c', D.BIN_SCRIPT]);
    expect(wrapped).toContainEqual(['/usr/bin/env', `PATH=${LOGIN}`, BIN, 'list', '--json', '--project', REPO]);
    expect(wrapped).toContainEqual(['/usr/bin/env', `PATH=${LOGIN}`, BIN, 'forge-sync', '--project', REPO]);
    // Every genie-rs run went through env; the probe, realpaths and tail did not; automagik-herdr is never run.
    expect(calls.some((c) => c[0] === 'automagik-herdr')).toBe(false);
    const viaEnv = (c: string[]) => c[0] === BIN || (c[0] === 'sh' && c[2] === D.BIN_SCRIPT);
    expect(wrapped.length).toBe(calls.filter(viaEnv).length);
    expect(calls.filter((c) => !viaEnv(c)).every((c) => !wrapped.some((w) => w[2] === c[0]))).toBe(true);
    expect(m.lists[REPO].rows).toHaveLength(2);
  });

  test('usagemeter via genie-rs list --json: refresh populates cost, actors and branch_usage without calling automagik-herdr', async () => {
    const LOGIN = '/Users/me/.local/bin:/usr/bin:/bin';
    const enrichedList = JSON.stringify([
      row({
        task: 'gh-1',
        lane: 'Review',
        meter_state: 'measured',
        cost: costOf('priced', 1.25),
        tokens: tokensOf(500),
        actors: [actorOf()],
      }),
      row({
        task: 'gh-2',
        lane: 'Working',
        branch: 'feat/gh-2',
        meter_state: 'missing',
        meter_reason: 'no_task_usage',
        branch_usage: {
          branch: 'feat/gh-2',
          state: 'measured',
          reason: null,
          tokens: tokensOf(300),
          cost: costOf('partial', 0.75),
          activity_hours: 1,
        },
      }),
    ]);
    const m = D.newModel();
    const { io, calls } = host({
      login: () => ({ code: 0, stdout: `\n__GENIE_LOGIN_PATH__${LOGIN}` }),
      bin: (args) => (args[0] === 'list' ? { code: 0, stdout: enrichedList } : { code: 0 }),
    });
    await D.refresh(m, io);
    expect(calls.some((c) => c[0] === 'automagik-herdr')).toBe(false);
    expect('feed' in m).toBe(false);
    const cards = D.lanesOf(REPO, m.lists[REPO].rows).flatMap((l) => l.cards);
    expect(cards.find((c) => c.id === 'gh-1')).toMatchObject({
      cost: '$1.25',
      usd: 1.25,
      tokens: 500,
      meter_state: 'measured',
    });
    expect(cards.find((c) => c.id === 'gh-2')).toMatchObject({
      cost: '–',
      usd: null,
      meter_state: 'missing',
      meter_reason: 'no_task_usage',
      branch_usage: { branch: 'feat/gh-2', cost_text: '$0.75', cost_badge: 'partial', tokens_total: 300 },
    });
  });

  test('no login shell answers: the inherited PATH is kept and every run is exactly as before', async () => {
    for (const login of [
      (): Reply => Object.assign(new Error('spawn /bin/zsh ENOENT'), { code: 'ENOENT' }),
      (): Reply => new Error('the command took longer than 30 s'),
      (): Reply => ({ code: 1, stdout: '' }),
      (): Reply => ({ code: 0, stdout: 'a profile that printed only this\n' }), // no marker
      (): Reply => ({ code: 0, stdout: '\n__GENIE_LOGIN_PATH__' }), // an empty PATH
    ]) {
      const m = D.newModel();
      const { io, calls, wrapped, shells } = host({
        login,
        bin: (args) => (args[0] === 'list' ? { code: 0, stdout: listJson } : { code: 0 }),
      });
      await D.refresh(m, io);
      await D.refresh(m, io);
      expect(shells).toEqual(['$SHELL', '/bin/zsh', '/bin/sh']); // each asked once, then never again
      expect(m.path).toBeNull();
      expect(wrapped).toEqual([]);
      expect(calls).toContainEqual([BIN, 'forge-sync', '--project', REPO]);
      expect(m.lists[REPO].rows).toHaveLength(2);
    }
  });

  test("refresh's first login exec is /bin/sh running $SHELL, no shell injected from JS", async () => {
    const m = D.newModel();
    const execs: string[][] = [];
    const { io } = host({ bin: () => ({ code: 0, stdout: '[]' }) });
    const exec = io.exec;
    io.exec = (cmd: string, args: string[] = []) => {
      execs.push([cmd, ...args]);
      return exec(cmd, args);
    };
    await D.refresh(m, io);
    expect(execs[0]).toEqual(['/bin/sh', '-c', 'exec "${SHELL:-/bin/zsh}" -l -c "$1"', 'sh', D.LOGIN_PATH_COMMAND]);
    expect('shell' in io).toBe(false);
    const main = readFileSync(join(import.meta.dir, 'main.js'), 'utf8');
    expect(main).not.toContain('process'); // Herdr's runtime has no process.env
  });

  test('$SHELL fails, /bin/zsh answers: the fallback order', async () => {
    const m = D.newModel();
    const { io, shells } = host({
      login: (sh) => (sh === '/bin/zsh' ? { code: 0, stdout: '\n__GENIE_LOGIN_PATH__/z/bin' } : { code: 127 }),
      bin: () => ({ code: 0, stdout: '[]' }),
    });
    await D.refresh(m, io);
    expect(shells).toEqual(['$SHELL', '/bin/zsh']);
    expect(m.path).toBe('/z/bin');
  });

  test("a non-POSIX $SHELL answer (nushell's literal $PATH, a space-joined list) is no PATH: the next shell is used", async () => {
    for (const answer of [
      '\n__GENIE_LOGIN_PATH__$PATH', // nushell: no interpolation in "$PATH"
      '\n__GENIE_LOGIN_PATH__/usr/local/bin /usr/bin /bin', // fish 2: a list joined with spaces
      '\n__GENIE_LOGIN_PATH__/usr/bin:bin:/bin', // a relative entry
    ]) {
      const m = D.newModel();
      const { io, shells, wrapped } = host({
        login: (sh) =>
          sh === '$SHELL'
            ? { code: 0, stdout: answer }
            : { code: 0, stdout: '\n__GENIE_LOGIN_PATH__/z/bin:/usr/bin:/bin' },
        bin: () => ({ code: 0, stdout: '[]' }),
      });
      await D.refresh(m, io);
      expect(shells).toEqual(['$SHELL', '/bin/zsh']);
      expect(m.path).toBe('/z/bin:/usr/bin:/bin');
      expect(wrapped.every((w) => w[1] === 'PATH=/z/bin:/usr/bin:/bin')).toBe(true);
    }
  });

  test('under the login PATH a missing genie-rs (env exit 127, 126) is still the missing-binary line', async () => {
    for (const code of [127, 126]) {
      let gone = false;
      const m = D.newModel();
      const { io } = host({
        login: () => ({ code: 0, stdout: '\n__GENIE_LOGIN_PATH__/l/bin' }),
        bin: (args) =>
          gone
            ? { code, stderr: `env: ${BIN}: No such file or directory\n` }
            : args[0] === 'list'
              ? { code: 0, stdout: listJson }
              : { code: 0 },
        binThere: () => !gone,
      });
      await D.refresh(m, io);
      expect(m.bin).toEqual({ found: true, path: BIN });
      gone = true;
      await D.refresh(m, io);
      expect(m.bin).toEqual({ found: false, path: BIN });
      expect(m.lists[REPO].rows).toHaveLength(2); // the last good list is kept
    }
  });

  test('gh missing on PATH: the note says so, through the backoff, until a sync succeeds', async () => {
    let minute = 0;
    let forge: Reply = { code: 1, stderr: GH_MISSING };
    const m = D.newModel();
    const { io } = host({
      now: () => minute * MIN,
      bin: (args) => (args[0] === 'list' ? { code: 0, stdout: '[]' } : forge),
    });
    expect(D.forgeNoteOf(m, REPO)).toBeNull(); // before the first attempt: no note
    await D.refresh(m, io);
    expect(m.lists[REPO]).toMatchObject({ rows: [], stale: false });
    expect(D.forgeNoteOf(m, REPO)).toBe('gh not found on PATH');
    minute = 1;
    await D.refresh(m, io); // backed off: no forge-sync this tick, the reason stays
    expect(m.results).toEqual({});
    expect(D.forgeNoteOf(m, REPO)).toBe('gh not found on PATH');
    minute = 2;
    forge = { code: 0 };
    await D.refresh(m, io);
    expect(D.forgeNoteOf(m, REPO)).toBeNull();
    expect(m.reasons).toEqual({});
  });

  test('a zero-row project whose sync fails for another reason shows the generic note', async () => {
    const m = D.newModel();
    const { io } = host({
      bin: (args) => (args[0] === 'list' ? { code: 0, stdout: '[]' } : { code: 1, stderr: 'gh: HTTP 502\n' }),
    });
    await D.refresh(m, io);
    expect(m.lists[REPO].rows).toEqual([]);
    expect(D.forgeNoteOf(m, REPO)).toBe('forge not synced');
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

describe('login PATH (the strings main.js hands to exec, run for real)', () => {
  test("forgeReason words genie-rs's gh/glab text and nothing else", () => {
    const e = (stderr: string) => D.forgeReason({ ok: false, code: 1, stdout: '', stderr });
    expect(
      e('genie-rs: gh could not be run (No such file or directory (os error 2)): install it and run gh auth login'),
    ).toBe('gh not found on PATH');
    expect(
      e(
        'genie-rs: glab could not be run (No such file or directory (os error 2)): install it and run glab auth login --hostname g',
      ),
    ).toBe('glab not found on PATH');
    expect(e('genie-rs: gh could not be run (Permission denied (os error 13)): install it and run gh auth login')).toBe(
      'gh could not be run',
    );
    expect(e('genie-rs: gh api failed: HTTP 401')).toBeNull();
    expect(D.forgeReason(null)).toBeNull();
  });

  test('parseLoginPath keeps a POSIX PATH (spaces inside an entry, empty entries) and rejects anything else', () => {
    const p = (text: string) =>
      D.parseLoginPath({ ok: true, code: 0, stdout: `\n__GENIE_LOGIN_PATH__${text}`, stderr: '' });
    expect(p('/opt/my tools/bin:/usr/bin:/bin')).toBe('/opt/my tools/bin:/usr/bin:/bin');
    expect(p('/a::/b:')).toBe('/a::/b:');
    expect(p('$PATH')).toBeNull();
    expect(p('/usr/local/bin /usr/bin /bin')).toBeNull();
    expect(p('/usr/bin:./node_modules/.bin')).toBeNull();
    expect(p('')).toBeNull();
  });

  /** Herdr's exec, played by Bun: resolves `{code, stdout, stderr}`, rejects when the program cannot start. */
  const realExec =
    (env: Record<string, string>) =>
    (cmd: string, args: string[] = []) => {
      try {
        const r = Bun.spawnSync([cmd, ...args], { env, stdin: 'ignore' });
        return Promise.resolve({ code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() });
      } catch (e) {
        return Promise.reject(e);
      }
    };
  // Spaces, quotes, `$(...)`, backticks, `;`, `&&`, `*` and a glob: argv carries them, no shell parses them.
  const WEIRD = `/opt/my tools/bin:/x/$(touch PWNED);echo hi:/y/\`id\`:/z/"q"'s && * ?:/usr/bin:/bin`;

  test('a login shell that prints a banner: the PATH after the marker, unchanged, then argv reaches genie-rs unchanged', async () => {
    const root = tmp();
    // A login shell whose profile sets an odd PATH and prints a banner: `<shell> -l -c <cmd>`.
    const fake = join(root, 'fake-shell');
    writeFileSync(
      fake,
      `#!/bin/sh\necho 'Last login: today'\nPATH='${WEIRD.replace(/'/g, `'\\''`)}'\nexport PATH\nexec /bin/sh -c "$3"\n`,
    );
    chmodSync(fake, 0o755);
    // Herdr's exec hands the program its own environment, SHELL included: /bin/sh execs it.
    const exec = realExec({ HOME: root, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: fake });
    const path = await D.resolveLoginPath({ exec });
    expect(path).toBe(WEIRD);

    // The very argv refresh builds, run for real: genie-rs (a stub) sees that PATH and its own args.
    const stub = join(root, 'genie-rs');
    writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$PATH" "$@"\n');
    chmodSync(stub, 0o755);
    const [cmd, args] = D.loginArgv(path, stub, ['forge-sync', '--project', '/a b/$(x)']);
    expect(cmd).toBe('/usr/bin/env');
    expect(args[0]).toBe(`PATH=${WEIRD}`);
    const r = await exec(cmd, args);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${WEIRD}\nforge-sync\n--project\n/a b/$(x)\n`);
    expect(readdirSync(root).sort()).toEqual(['fake-shell', 'genie-rs']); // nothing ran the $(touch)
  });

  test('a nushell-like $SHELL that prints a literal $PATH falls through to a real login shell', async () => {
    const root = tmp();
    const nu = join(root, 'nu');
    writeFileSync(nu, "#!/bin/sh\nprintf '\\n__GENIE_LOGIN_PATH__$PATH'\n");
    chmodSync(nu, 0o755);
    const exec = realExec({ HOME: root, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: nu });
    expect((await exec(...D.LOGIN_CANDIDATES[0])).stdout).toBe('\n__GENIE_LOGIN_PATH__$PATH');
    const path = await D.resolveLoginPath({ exec });
    expect(path).not.toBe('$PATH');
    expect(path).toEqual(expect.stringContaining('/bin'));
  });

  test('$SHELL that fails falls through to the next login shell; none at all keeps the inherited PATH', async () => {
    const root = tmp();
    const failing = join(root, 'failing-shell');
    writeFileSync(failing, '#!/bin/sh\nexit 1\n');
    chmodSync(failing, 0o755);
    const exec = realExec({ HOME: root, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: failing });
    const next = await D.resolveLoginPath({ exec });
    expect(next).toEqual(expect.stringContaining('/bin')); // /bin/zsh or /bin/sh answered
    const first = D.LOGIN_CANDIDATES[0];
    const none = await D.resolveLoginPath({
      exec: (cmd: string, args: string[]) =>
        cmd === first[0] && args[0] === first[1][0] ? exec(cmd, args) : Promise.reject(new Error('ENOENT')),
    });
    expect(none).toBeNull();
    expect(D.loginArgv(null, '/b/genie-rs', ['list'])).toEqual(['/b/genie-rs', ['list']]);
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
