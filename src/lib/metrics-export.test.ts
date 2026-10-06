import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { CaptureLine, RuntimeSession } from './metrics-capture.js';
import {
  type Interval,
  buildIntervals,
  formatSummary,
  readCaptureLedger,
  summarize,
  verifyAgainstTaskEvents,
} from './metrics-export.js';
import { installSalt, intervalSpan, projectToPhoenix, validateTarget } from './metrics-phoenix.js';
import type { PriceTable } from './metrics-prices.js';
import { readUsageSamples } from './metrics-usage.js';

let root: string;
let env: NodeJS.ProcessEnv;
let savedHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genie-metrics-export-'));
  env = { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex') };
  // installSalt() persists under <GENIE_HOME>/metrics: never the operator's real home.
  savedHome = process.env.GENIE_HOME;
  process.env.GENIE_HOME = join(root, 'genie');
});

afterEach(() => {
  if (savedHome === undefined) Reflect.deleteProperty(process.env, 'GENIE_HOME');
  else process.env.GENIE_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

const t = (iso: string) => Date.parse(iso);
const jsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

function write(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

describe('runtime session logs → usage samples', () => {
  test('claude-code: one sample per message id (the last streamed record), subagent logs included', () => {
    const base = join(root, 'claude', 'projects', '-repo');
    const usage = (n: number) => ({
      input_tokens: n,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
      output_tokens: 2,
    });
    write(
      join(base, 'sess-c.jsonl'),
      jsonl([
        { type: 'assistant', timestamp: '2026-10-04T10:00:01Z', message: { id: 'm1', usage: usage(1) } },
        { type: 'assistant', timestamp: '2026-10-04T10:00:02Z', message: { id: 'm1', usage: usage(3) } },
        { type: 'user', timestamp: '2026-10-04T10:00:03Z', message: { content: 'x' } },
      ]),
    );
    write(
      join(base, 'sess-c', 'subagents', 'agent-a.jsonl'),
      jsonl([
        // A fork subagent transcript repeats its parent's message: counted once across files.
        { type: 'assistant', timestamp: '2026-10-04T10:00:02Z', message: { id: 'm1', usage: usage(3) } },
        { type: 'assistant', timestamp: '2026-10-04T10:00:04Z', message: { id: 'm2', usage: usage(7) } },
      ]),
    );
    const samples = readUsageSamples({ id: 'sess-c', source: 'claude-code', file: null }, env);
    expect(samples.map((s) => s.input)).toEqual([3, 7]);
    expect(samples[0]).toMatchObject({ cacheRead: 10, cacheWrite: 5, output: 2, costUsd: null, model: null });
  });

  test('codex: one sample per moved cumulative total (re-emitted token_count skipped), cached input split out', () => {
    const event = (ts: string, total: number, input: number) => ({
      timestamp: ts,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: total },
          last_token_usage: { input_tokens: input, cached_input_tokens: 60, output_tokens: 4 },
        },
      },
    });
    write(
      join(root, 'codex', 'sessions', '2026', '10', '04', 'rollout-2026-10-04T10-00-00-thr-9.jsonl'),
      jsonl([
        event('2026-10-04T10:00:05Z', 104, 100),
        event('2026-10-04T10:00:06Z', 104, 100), // the same turn re-emitted
        { timestamp: '2026-10-04T10:00:07Z', type: 'response_item', payload: { type: 'message' } },
        event('2026-10-04T10:00:08Z', 268, 160),
      ]),
    );
    const samples = readUsageSamples({ id: 'thr-9', source: 'codex', file: null }, env);
    expect(samples.map((s) => [s.input, s.cacheRead, s.output])).toEqual([
      [40, 60, 4],
      [100, 60, 4],
    ]);
    expect(samples[0]?.costUsd).toBeNull();
    expect(samples.map((s) => s.model)).toEqual([null, null]);
  });

  test('model ids: Claude message.model (<synthetic> is none), Codex the latest turn_context, pi/OMP as written', () => {
    const usage = { input_tokens: 1, output_tokens: 1 };
    write(
      join(root, 'claude', 'projects', '-repo', 'sess-m.jsonl'),
      jsonl([
        { type: 'assistant', timestamp: '2026-10-04T10:00:01Z', message: { id: 'a', model: 'claude-opus-5-5', usage } },
        { type: 'assistant', timestamp: '2026-10-04T10:00:02Z', message: { id: 'b', model: '<synthetic>', usage } },
      ]),
    );
    expect(readUsageSamples({ id: 'sess-m', source: 'claude-code', file: null }, env).map((s) => s.model)).toEqual([
      'claude-opus-5-5',
      null,
    ]);

    const tokens = (ts: string, total: number) => ({
      timestamp: ts,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: 5, output_tokens: 1 } },
      },
    });
    const turn = (ts: string, model?: string) => ({ timestamp: ts, type: 'turn_context', payload: { model } });
    write(
      join(root, 'codex', 'sessions', '2026', '10', '04', 'rollout-2026-10-04T10-00-00-thr-m.jsonl'),
      jsonl([
        tokens('2026-10-04T10:00:00Z', 6),
        turn('2026-10-04T10:00:01Z', 'gpt-5.6-sol'),
        tokens('2026-10-04T10:00:02Z', 12),
        turn('2026-10-04T10:00:03Z', 'gpt-6.1-sol'),
        tokens('2026-10-04T10:00:04Z', 18),
        turn('2026-10-04T10:00:05Z'),
        tokens('2026-10-04T10:00:06Z', 24),
      ]),
    );
    // Before any turn_context, and after one that names no model, the model is unknown — never carried over.
    expect(readUsageSamples({ id: 'thr-m', source: 'codex', file: null }, env).map((s) => s.model)).toEqual([
      null,
      'gpt-5.6-sol',
      'gpt-6.1-sol',
      null,
    ]);

    const file = join(root, '.omp', 'agent', 'sessions', '-repo', '2026-10-04T10-00-00Z_pi-m.jsonl');
    write(
      file,
      jsonl([
        {
          type: 'message',
          timestamp: '2026-10-04T10:00:07Z',
          message: { role: 'assistant', model: 'openai-codex/gpt-6.1-sol', usage: { input: 1, output: 1 } },
        },
      ]),
    );
    expect(readUsageSamples({ id: null, source: 'pi', file }, env).map((s) => s.model)).toEqual([
      'openai-codex/gpt-6.1-sol',
    ]);
  });

  test('pi/OMP: assistant message usage with the runtime’s own cost, sibling subagent logs included', () => {
    const file = join(root, '.omp', 'agent', 'sessions', '-repo', '2026-10-04T10-00-00Z_pi-1.jsonl');
    const usage = { input: 9, output: 1, cacheRead: 3, cacheWrite: 0, cost: { total: 0.25 } };
    write(file, jsonl([{ type: 'message', timestamp: '2026-10-04T10:00:07Z', message: { role: 'assistant', usage } }]));
    write(
      join(file.replace(/\.jsonl$/, ''), 'Scout.jsonl'),
      jsonl([{ type: 'message', timestamp: '2026-10-04T10:00:08Z', message: { role: 'assistant', usage } }]),
    );
    const byFile = readUsageSamples({ id: null, source: 'pi', file }, env);
    expect(byFile.map((s) => s.costUsd)).toEqual([0.25, 0.25]);
    // Without PI_SESSION_FILE the log is found by its session id.
    expect(readUsageSamples({ id: 'pi-1', source: 'pi', file: null }, env)).toHaveLength(2);
  });

  test('no runtime, or no log on this host: no samples (unknown, never zero)', () => {
    expect(readUsageSamples({ id: null, source: null, file: null }, env)).toEqual([]);
    expect(readUsageSamples({ id: 'absent', source: 'claude-code', file: null }, env)).toEqual([]);
  });
});

describe('ledger → verified intervals', () => {
  function seedDb(rows: Array<{ id: number; task: string; kind: string; at: number }>): string {
    const path = join(root, 'repo', '.genie', 'genie.db');
    mkdirSync(join(path, '..'), { recursive: true });
    const db = new Database(path);
    db.run(
      'CREATE TABLE task_events (id INTEGER PRIMARY KEY, task_id TEXT, kind TEXT, note TEXT, author_kind TEXT, author TEXT, created_at INTEGER)',
    );
    for (const row of rows)
      db.run('INSERT INTO task_events (id, task_id, kind, created_at) VALUES (?, ?, ?, ?)', [
        row.id,
        row.task,
        row.kind,
        row.at,
      ]);
    db.close();
    return path;
  }

  const session: RuntimeSession = { id: 'sess-c', source: 'claude-code', file: null };
  const line = (db: string, event: number, kind: string, at: number, s: RuntimeSession = session): CaptureLine => ({
    v: 1,
    source: 'task_event',
    db,
    task: 't1',
    event,
    kind,
    authorKind: 'claude-code',
    at,
    session: s,
    genie: 'test',
    pid: 1,
  });

  test('a rolled-back line whose event id was reused is unmatched, never attributed', () => {
    const at1 = t('2026-10-04T10:00:00Z');
    const at2 = t('2026-10-04T10:10:00Z');
    const db = seedDb([
      { id: 1, task: 't1', kind: 'claim', at: at1 },
      { id: 2, task: 't1', kind: 'report', at: at2 },
    ]);
    // event 2 was first written at at1+1 and rolled back; the retry reused id 2 at at2.
    const lines = [
      line(db, 1, 'claim', at1),
      line(db, 2, 'report', at1 + 1),
      line(db, 2, 'report', at2),
      line('/gone.db', 1, 'claim', at1),
    ];
    const { matched, unmatched } = verifyAgainstTaskEvents(lines);
    expect(unmatched).toBe(2);
    expect(matched.map((l) => l.at)).toEqual([at1, at2]);
  });

  test('intervals carry the opening session’s usage inside the window; no log → usage null', () => {
    const at1 = t('2026-10-04T10:00:00Z');
    const at2 = t('2026-10-04T10:10:00Z');
    const at3 = t('2026-10-04T10:20:00Z');
    write(
      join(root, 'claude', 'projects', '-repo', 'sess-c.jsonl'),
      jsonl([
        {
          type: 'assistant',
          timestamp: '2026-10-04T10:05:00Z',
          message: { id: 'in', usage: { input_tokens: 100, output_tokens: 10 } },
        },
        {
          type: 'assistant',
          timestamp: '2026-10-04T10:15:00Z',
          message: { id: 'out', usage: { input_tokens: 999, output_tokens: 1 } },
        },
      ]),
    );
    const db = seedDb([
      { id: 1, task: 't1', kind: 'claim', at: at1 },
      { id: 2, task: 't1', kind: 'report', at: at2 },
      { id: 3, task: 't1', kind: 'move', at: at3 },
    ]);
    const silent: RuntimeSession = { id: 'not-on-host', source: 'codex', file: null };
    const { matched } = verifyAgainstTaskEvents([
      line(db, 1, 'claim', at1),
      line(db, 2, 'report', at2, silent),
      line(db, 3, 'move', at3),
    ]);
    const intervals = buildIntervals(matched, env);
    expect(intervals.map((i) => i.transition)).toEqual(['claim→report', 'report→move']);
    expect(intervals[0]?.usage).toMatchObject({ calls: 1, input: 100, output: 10, costUsd: null });
    expect(intervals[0]?.durationMs).toBe(600_000);
    expect(intervals[1]?.usage).toBeNull();
    const summary = summarize(intervals);
    expect(summary.find((s) => s.transition === 'claim→report')).toMatchObject({ n: 1, withUsage: 1, meanTokens: 110 });
    expect(summary.find((s) => s.transition === 'report→move')).toMatchObject({ n: 1, withUsage: 0, meanTokens: null });
  });

  test('an OMP shell exported no session id: its usage joins by the one OMP session in that cwd, else stays null', () => {
    const at1 = t('2026-10-04T10:00:00Z');
    const at2 = t('2026-10-04T10:10:00Z');
    const omp = (name: string, cwd: string) => {
      const file = join(root, '.omp', 'agent', 'sessions', '-repo', `2026-10-04T09-00-00Z_${name}.jsonl`);
      write(
        file,
        jsonl([
          { type: 'title', v: 1, title: name },
          { type: 'session', id: name, timestamp: '2026-10-04T09:00:00Z', cwd },
          {
            type: 'message',
            timestamp: '2026-10-04T10:05:00Z',
            message: {
              role: 'assistant',
              usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
        ]),
      );
      return file;
    };
    const ompFile = omp('omp-1', '/work/repo');
    omp('omp-other-cwd', '/work/elsewhere');
    const db = seedDb([
      { id: 1, task: 't1', kind: 'claim', at: at1 },
      { id: 2, task: 't1', kind: 'report', at: at2 },
    ]);
    const anonymous: RuntimeSession = { id: null, source: 'pi', file: null };
    const lines = [
      { ...line(db, 1, 'claim', at1, anonymous), cwd: '/work/repo' },
      { ...line(db, 2, 'report', at2, anonymous), cwd: '/work/repo' },
    ];
    const [windowed] = buildIntervals(verifyAgainstTaskEvents(lines).matched, env);
    expect(windowed).toMatchObject({
      sessionMatch: 'window',
      session: { source: 'pi', id: 'omp-1', file: ompFile },
      usage: { calls: 1, input: 50, output: 5, costUsd: 0.01 },
    });
    // The same unique match over a window in which that session made no call: unknown, not 0.
    const quiet = [
      { ...line(db, 1, 'claim', at1, anonymous), cwd: '/work/repo', at: at1 },
      { ...line(db, 2, 'report', at2, anonymous), cwd: '/work/repo', at: at2 },
    ];
    expect(buildIntervals(quiet, env).length).toBe(1);
    // A second OMP session in the same cwd over the same window: ambiguous, so no usage is attributed.
    omp('omp-2', '/work/repo');
    const [ambiguous] = buildIntervals(verifyAgainstTaskEvents(lines).matched, env);
    expect(ambiguous).toMatchObject({ sessionMatch: 'ambiguous', usage: null });
  });

  test('a window match with no call inside the interval is unknown, never 0; a nested-shell line is ambiguous', () => {
    const at1 = t('2026-10-04T11:00:00Z');
    const at2 = t('2026-10-04T11:10:00Z');
    write(
      join(root, '.omp', 'agent', 'sessions', '-q', '2026-10-04T09-00-00Z_idle.jsonl'),
      jsonl([{ type: 'session', id: 'idle', timestamp: '2026-10-04T09:00:00Z', cwd: '/work/quiet' }]),
    );
    const db = seedDb([
      { id: 1, task: 't1', kind: 'claim', at: at1 },
      { id: 2, task: 't1', kind: 'report', at: at2 },
    ]);
    const anonymous: RuntimeSession = { id: null, source: 'pi', file: null };
    const [idle] = buildIntervals(
      [{ ...line(db, 1, 'claim', at1, anonymous), cwd: '/work/quiet' }, line(db, 2, 'report', at2, anonymous)],
      env,
    );
    expect(idle).toMatchObject({ sessionMatch: 'window', usage: null });
    const nested: RuntimeSession = { id: null, source: 'codex', file: null, ambiguous: true };
    const [ambiguous] = buildIntervals([line(db, 1, 'claim', at1, nested), line(db, 2, 'report', at2)], env);
    expect(ambiguous).toMatchObject({ sessionMatch: 'ambiguous', usage: null });
  });

  test('the OMP window join needs a session alive at the opening event, and never reads pi logs', () => {
    const at1 = t('2026-10-04T12:00:00Z');
    const at2 = t('2026-10-04T12:10:00Z');
    const usage = { input: 9, output: 1, cacheRead: 0, cacheWrite: 0 };
    // Started AFTER the opening event: it cannot have written it.
    write(
      join(root, '.omp', 'agent', 'sessions', '-late', '2026-10-04T12-05-00Z_late.jsonl'),
      jsonl([
        { type: 'session', id: 'late', timestamp: '2026-10-04T12:05:00Z', cwd: '/work/late' },
        { type: 'message', timestamp: '2026-10-04T12:06:00Z', message: { role: 'assistant', usage } },
      ]),
    );
    // A pi (not OMP) log in the same cwd: never matched for an id-less OMP line.
    write(
      join(root, '.pi', 'agent', 'sessions', '-late', '2026-10-04T11-00-00Z_pi.jsonl'),
      jsonl([
        { type: 'session', id: 'pi', timestamp: '2026-10-04T11:00:00Z', cwd: '/work/late' },
        { type: 'message', timestamp: '2026-10-04T12:06:00Z', message: { role: 'assistant', usage } },
      ]),
    );
    const db = seedDb([
      { id: 1, task: 't1', kind: 'claim', at: at1 },
      { id: 2, task: 't1', kind: 'report', at: at2 },
    ]);
    const anonymous: RuntimeSession = { id: null, source: 'pi', file: null };
    const [interval] = buildIntervals(
      [{ ...line(db, 1, 'claim', at1, anonymous), cwd: '/work/late' }, line(db, 2, 'report', at2, anonymous)],
      env,
    );
    expect(interval).toMatchObject({ sessionMatch: null, usage: null });
  });

  describe('an OMP shell whose cwd is not its session’s (a git worktree): matched by its logged genie call', () => {
    const at1 = t('2026-10-04T10:00:00Z');
    const at2 = t('2026-10-04T10:10:00Z');
    const anonymous: RuntimeSession = { id: null, source: 'pi', file: null };
    let repoRoot: string;
    let worktree: string;
    let db: string;

    beforeEach(() => {
      repoRoot = join(root, 'repo');
      // Outside the repo root, as `git worktree add` registers it: <root>/.git/worktrees/<n>/gitdir.
      worktree = join(root, 'elsewhere', 'wt');
      write(join(repoRoot, '.git', 'worktrees', 'wt', 'gitdir'), `${join(worktree, '.git')}\n`);
      db = seedDb([
        { id: 1, task: 't1', kind: 'claim', at: at1 },
        { id: 2, task: 't1', kind: 'report', at: at2 },
      ]);
    });

    /** A bash tool-call record, shaped as OMP 18.6.1 writes it. */
    const toolCall = (timestamp: string, command: string) => ({
      type: 'message',
      timestamp,
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { i: 'x', command, timeout: 30 } },
        ],
      },
    });
    const sessionFile = (name: string) =>
      join(root, '.omp', 'agent', 'sessions', '-repo', `2026-10-04T09-00-00Z_${name}.jsonl`);
    /** One OMP session log: header, one priced model call inside the interval, then `records`. */
    const omp = (name: string, cwd: string, records: unknown[] = [], started = '2026-10-04T09:00:00Z') => {
      write(
        sessionFile(name),
        jsonl([
          { type: 'title', v: 1, title: name },
          { type: 'session', id: name, timestamp: started, cwd },
          {
            type: 'message',
            timestamp: '2026-10-04T10:05:00Z',
            message: {
              role: 'assistant',
              usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
          ...records,
        ]),
      );
      return sessionFile(name);
    };
    const claimCall = (timestamp: string) => toolCall(timestamp, 'genie task checkout t1 --worker w');
    const interval = (cwd = worktree, database = db) => {
      const lines = [
        { ...line(database, 1, 'claim', at1, anonymous), cwd },
        { ...line(database, 2, 'report', at2, anonymous), cwd },
      ];
      return buildIntervals(verifyAgainstTaskEvents(lines).matched, env)[0];
    };

    test('the one session of the same repository WITHOUT a logged genie call for the card is not matched', () => {
      omp('root-session', repoRoot);
      expect(interval()).toMatchObject({ sessionMatch: null, session: anonymous, usage: null });
    });

    test('the one session whose log ran genie for the card just before the event is matched, labelled window', () => {
      const file = omp('root-session', repoRoot, [claimCall('2026-10-04T09:59:58Z')]);
      expect(interval()).toMatchObject({
        sessionMatch: 'window',
        session: { source: 'pi', id: 'root-session', file },
        usage: { calls: 1, input: 50, output: 5, costUsd: 0.01 },
      });
    });

    test('two sessions of the repository: the one whose log ran genie for this card just before the event', () => {
      omp('idle', repoRoot);
      const worker = omp('worker', repoRoot, [claimCall('2026-10-04T09:59:58Z')]);
      expect(interval()).toMatchObject({
        sessionMatch: 'window',
        session: { source: 'pi', id: 'worker', file: worker },
        usage: { calls: 1, input: 50 },
      });
    });

    test('a genie call logged by a SUBAGENT of a session is that session’s evidence', () => {
      omp('idle', repoRoot);
      const parent = omp('parent', repoRoot);
      write(
        join(parent.replace(/\.jsonl$/, ''), 'G1Worker.jsonl'),
        jsonl([toolCall('2026-10-04T09:59:59Z', 'cd /x && bun dist/genie.js task comment t1 "note"')]),
      );
      expect(interval()).toMatchObject({ sessionMatch: 'window', session: { id: 'parent', file: parent } });
    });

    test('two sessions and no tool call for the card in either log: no match', () => {
      omp('a', repoRoot);
      omp('b', repoRoot);
      expect(interval()).toMatchObject({ sessionMatch: null, session: anonymous, usage: null });
    });

    test('two sessions that BOTH ran genie for the card near the event: ambiguous, no usage is attributed', () => {
      omp('a', repoRoot, [claimCall('2026-10-04T09:59:58Z')]);
      omp('b', worktree, [claimCall('2026-10-04T09:59:50Z')]);
      expect(interval(join(repoRoot, 'src'))).toMatchObject({
        sessionMatch: 'ambiguous',
        session: anonymous,
        usage: null,
      });
    });

    test('a tool call is evidence only for this card, as a genie task command, shortly BEFORE the event', () => {
      omp('near-misses', repoRoot, [
        toolCall('2026-10-04T09:58:00Z', 'genie task checkout t1 --worker w'), // two minutes earlier: too old
        toolCall('2026-10-04T10:00:01Z', 'genie task status t1'), // after the event
        toolCall('2026-10-04T09:59:58Z', 'genie task checkout t2 --worker w'), // another card
        toolCall('2026-10-04T09:59:58Z', 'grep t1 /home/genie/notes/task list.md'), // names the card, runs no genie
        // The card id in a tool RESULT or a user message is not a tool call.
        {
          type: 'message',
          timestamp: '2026-10-04T09:59:58Z',
          message: { role: 'user', content: 'genie task done t1' },
        },
      ]);
      expect(interval()).toMatchObject({ sessionMatch: null, usage: null });
    });

    test('a session whose cwd IS the capture cwd still wins, with no log evidence asked for', () => {
      omp('root-session', repoRoot, [claimCall('2026-10-04T09:59:58Z')]);
      const exact = omp('worktree-session', worktree);
      expect(interval()).toMatchObject({
        sessionMatch: 'window',
        session: { id: 'worktree-session', file: exact },
        usage: { calls: 1 },
      });
      // Two with the capture cwd stay ambiguous: the evidence fallback is only for NO equal-cwd session.
      omp('worktree-session-2', worktree);
      expect(interval()).toMatchObject({ sessionMatch: 'ambiguous', usage: null });
    });

    test('a session started in ANOTHER repository whose log ran genie for the card is matched', () => {
      omp('same-repo-idle', repoRoot);
      const writer = omp('other-repo-writer', join(root, 'other'), [claimCall('2026-10-04T09:59:58Z')]);
      expect(interval()).toMatchObject({
        sessionMatch: 'window',
        session: { source: 'pi', id: 'other-repo-writer', file: writer },
        usage: { calls: 1, input: 50 },
      });
    });

    test('a session started in another repository WITHOUT the tool call is never matched', () => {
      omp('other-repo', join(root, 'other'));
      expect(interval()).toMatchObject({ sessionMatch: null, session: anonymous, usage: null });
    });

    test('a session that started after the event is not matched', () => {
      // Its header is later than the event even though a record in it claims an earlier call.
      omp('late', repoRoot, [claimCall('2026-10-04T09:59:58Z')], '2026-10-04T10:03:00Z');
      expect(interval()).toMatchObject({ sessionMatch: null, usage: null });
    });

    test('a capture cwd outside every checkout of the repository never reaches the evidence fallback', () => {
      omp('root-session', repoRoot, [claimCall('2026-10-04T09:59:58Z')]);
      expect(interval(join(root, 'unrelated'))).toMatchObject({ sessionMatch: null, usage: null });
      // A sibling directory that merely shares the root's name as a prefix is not inside it.
      expect(interval(`${repoRoot}-copy`)).toMatchObject({ sessionMatch: null, usage: null });
    });

    test('a database that is not <root>/.genie/genie.db names no repository: never matched by evidence', () => {
      const fixtures = join(root, 'fixtures');
      const testDb = join(fixtures, 'run-1', 'race.db');
      mkdirSync(join(testDb, '..'), { recursive: true });
      const handle = new Database(testDb);
      handle.run('CREATE TABLE task_events (id INTEGER PRIMARY KEY, task_id TEXT, kind TEXT, created_at INTEGER)');
      handle.run("INSERT INTO task_events VALUES (1, 't1', 'claim', ?), (2, 't1', 'report', ?)", [at1, at2]);
      handle.close();
      // dirname(dirname(db)) is `fixtures`, and the capture cwd is inside it.
      omp('test-runner', fixtures, [claimCall('2026-10-04T09:59:58Z')]);
      expect(interval(join(fixtures, 'run-1'), testDb)).toMatchObject({ sessionMatch: null, usage: null });
    });
  });

  test('mikro offload runs inside the window are priced on the interval; a repo with no mikro ledger is unknown', () => {
    const at1 = t('2026-10-04T13:00:00Z');
    const at2 = t('2026-10-04T13:10:00Z');
    const db = seedDb([
      { id: 1, task: 't1', kind: 'claim', at: at1 },
      { id: 2, task: 't1', kind: 'report', at: at2 },
    ]);
    const repoRoot = join(root, 'repo');
    const run = (ts: string, ok: boolean, cost: number, dir = repoRoot) => ({
      runId: ts,
      ts,
      agent: 'wish-context',
      dir,
      ok,
      footer: { tokensIn: 100, tokensOut: 20, cost },
    });
    const lines = [line(db, 1, 'claim', at1), line(db, 2, 'report', at2)];
    const [unknown] = buildIntervals(verifyAgainstTaskEvents(lines).matched, env);
    expect(unknown?.offload).toBeNull();
    write(
      join(repoRoot, '.mikro', 'runs', 'wish-context.jsonl'),
      jsonl([
        run('2026-10-04T13:02:00Z', false, 0.03),
        run('2026-10-04T13:03:00Z', true, 0.02, join(repoRoot, '.claude', 'worktrees', 'wish-x')),
        run('2026-10-04T13:20:00Z', true, 0.5), // after the window
        run('2026-10-04T13:04:00Z', true, 0.9, '/elsewhere/repo'), // another repository
      ]),
    );
    const [priced] = buildIntervals(verifyAgainstTaskEvents(lines).matched, env);
    expect(priced?.offload).toEqual({ attempts: 2, failed: 1, ambiguous: 0, tokens: 240, costUsd: 0.05 });
    expect(summarize([priced as Interval])[0]?.offloadUsd).toBeCloseTo(0.05, 6);
  });

  test('offload: an unpriced attempt makes the bill unknown; another card in the same window makes runs ambiguous; registered worktrees and GENIE_HOME ledgers count', () => {
    const at1 = t('2026-10-04T14:00:00Z');
    const at2 = t('2026-10-04T14:10:00Z');
    const db = seedDb([
      { id: 1, task: 't1', kind: 'claim', at: at1 },
      { id: 2, task: 't1', kind: 'report', at: at2 },
      { id: 3, task: 't2', kind: 'claim', at: t('2026-10-04T14:04:00Z') },
      { id: 4, task: 't2', kind: 'report', at: t('2026-10-04T14:06:00Z') },
    ]);
    const repoRoot = join(root, 'repo');
    // A worktree of this repo living OUTSIDE its root, registered with git.
    const outside = join(root, 'elsewhere', 'wish-x');
    // Registered RELATIVE to its registration dir, as git ≥2.48 `worktree add --relative-paths` writes it.
    const registration = join(repoRoot, '.git', 'worktrees', 'wish-x');
    write(join(registration, 'gitdir'), `${relative(registration, join(outside, '.git'))}\n`);
    const attempt = (ts: string, dir: string, footer: Record<string, number> | null) => ({ ts, dir, ok: true, footer });
    write(
      join(outside, '.mikro', 'runs', 'review-prep.jsonl'),
      jsonl([attempt('2026-10-04T14:01:00Z', outside, { tokensIn: 10, tokensOut: 5, cost: 0.01 })]),
    );
    write(
      join(root, 'genie', 'mikro', 'runs', 'repo-abcd1234', 'wish-context.jsonl'),
      jsonl([
        attempt('2026-10-04T14:02:00Z', repoRoot, { tokensIn: 20, tokensOut: 5, cost: 0.02 }),
        // inside t2's window too: ambiguous, excluded from t1's bill
        attempt('2026-10-04T14:05:00Z', repoRoot, { tokensIn: 99, tokensOut: 1, cost: 0.5 }),
      ]),
    );
    const t1 = (task: string, id: number, kind: string, at: number) => ({ ...line(db, id, kind, at), task });
    const lines = [
      t1('t1', 1, 'claim', at1),
      t1('t1', 2, 'report', at2),
      t1('t2', 3, 'claim', t('2026-10-04T14:04:00Z')),
      t1('t2', 4, 'report', t('2026-10-04T14:06:00Z')),
    ];
    const intervals = buildIntervals(verifyAgainstTaskEvents(lines).matched, env);
    const first = intervals.find((i) => i.task === 't1');
    // One attempt also sits inside t2's window: it may be t1's, so t1's bill is unknown, never a lower total.
    expect(first?.offload).toEqual({ attempts: 2, failed: 0, ambiguous: 1, tokens: null, costUsd: null });
    // ...and a transition with one unknown interval has an unknown total.
    expect(summarize(intervals).find((r) => r.transition === 'claim→report')?.offloadUsd).toBeNull();
    // One more attempt with no footer (a timeout): tokens and cost become unknown, never a lower total.
    write(
      join(repoRoot, '.mikro', 'runs', 'issue-triage.jsonl'),
      jsonl([attempt('2026-10-04T14:03:00Z', repoRoot, null)]),
    );
    const again = buildIntervals(verifyAgainstTaskEvents(lines).matched, env).find((i) => i.task === 't1');
    expect(again?.offload).toMatchObject({ attempts: 3, tokens: null, costUsd: null });
  });

  // Root ignores mode bits, so the permission cases only prove anything as an ordinary user.
  const asRoot = process.getuid?.() === 0;

  test.skipIf(asRoot)(
    'offload: an unreadable ledger, alone or beside readable ones, is unknown — never a measured 0',
    () => {
      const at1 = t('2026-10-04T15:00:00Z');
      const at2 = t('2026-10-04T15:10:00Z');
      const db = seedDb([
        { id: 1, task: 't1', kind: 'claim', at: at1 },
        { id: 2, task: 't1', kind: 'report', at: at2 },
      ]);
      const repoRoot = join(root, 'repo');
      const runs = join(repoRoot, '.mikro', 'runs');
      const lines = [line(db, 1, 'claim', at1), line(db, 2, 'report', at2)];
      const offload = () => buildIntervals(verifyAgainstTaskEvents(lines).matched, env)[0]?.offload;
      const readable = jsonl([
        { ts: '2026-10-04T15:02:00Z', dir: repoRoot, ok: true, footer: { tokensIn: 1, tokensOut: 1, cost: 0.01 } },
      ]);
      // 1. The only ledger exists but cannot be read (mode 000): unknown, not 0 attempts / $0.
      write(join(runs, 'wish-context.jsonl'), readable);
      chmodSync(join(runs, 'wish-context.jsonl'), 0o000);
      try {
        expect(offload()).toBeNull();
        // 2. A readable ledger beside it: still unknown, never the readable part alone.
        write(join(runs, 'review-prep.jsonl'), readable);
        expect(offload()).toBeNull();
      } finally {
        chmodSync(join(runs, 'wish-context.jsonl'), 0o600);
      }
      expect(offload()).toMatchObject({ attempts: 2, costUsd: 0.02 });
      // 3. An unreadable machine-ledger directory may hold this repository's rows: unknown.
      const machine = join(root, 'genie', 'mikro', 'runs', 'other-12345678');
      write(join(machine, 'wish-context.jsonl'), readable);
      chmodSync(machine, 0o000);
      try {
        expect(offload()).toBeNull();
      } finally {
        chmodSync(machine, 0o700);
      }
      // 4. An unreadable worktree registration may hide a worktree (and its ledger): unknown.
      const registration = join(repoRoot, '.git', 'worktrees', 'wt');
      write(join(registration, 'gitdir'), `${join(root, 'wt-elsewhere', '.git')}\n`);
      chmodSync(join(registration, 'gitdir'), 0o000);
      try {
        expect(offload()).toBeNull();
      } finally {
        chmodSync(join(registration, 'gitdir'), 0o600);
      }
      chmodSync(registration, 0o000);
      try {
        expect(offload()).toBeNull();
      } finally {
        chmodSync(registration, 0o700);
      }
      // A directory named like a ledger is not a ledger, not a read failure.
      mkdirSync(join(runs, 'not-a-ledger.jsonl'));
      // (the readable machine ledger restored above still contributes its attempt)
      expect(offload()).toMatchObject({ attempts: 3, tokens: 6 });
      // An ABSENT ledger dir is simply no ledger, not a read failure.
      rmSync(join(root, 'genie', 'mikro'), { recursive: true, force: true });
      expect(offload()).toMatchObject({ attempts: 2 });
    },
  );

  test('offload: only a ledger actually READ is evidence — a directory named like one alone is no ledger; an empty readable file is a measured 0', () => {
    const at1 = t('2026-10-04T16:00:00Z');
    const at2 = t('2026-10-04T16:10:00Z');
    const db = seedDb([
      { id: 1, task: 't1', kind: 'claim', at: at1 },
      { id: 2, task: 't1', kind: 'report', at: at2 },
    ]);
    const runs = join(root, 'repo', '.mikro', 'runs');
    const lines = [line(db, 1, 'claim', at1), line(db, 2, 'report', at2)];
    const offload = () => buildIntervals(verifyAgainstTaskEvents(lines).matched, env)[0]?.offload;
    // ONLY a directory named wish-context.jsonl: no ledger at all → unknown, not 0 attempts / $0.
    mkdirSync(join(runs, 'wish-context.jsonl'), { recursive: true });
    expect(offload()).toBeNull();
    // A real, readable, empty ledger beside it: a measured 0.
    writeFileSync(join(runs, 'review-prep.jsonl'), '');
    expect(offload()).toEqual({ attempts: 0, failed: 0, ambiguous: 0, tokens: 0, costUsd: 0 });
  });

  test('a corrupt ledger line is counted, and --since drops older lines', () => {
    const path = join(root, 'events.jsonl');
    write(
      path,
      `${JSON.stringify(line('/x', 1, 'claim', 5))}\n{"torn\n${JSON.stringify(line('/x', 2, 'report', 50))}\n`,
    );
    expect(readCaptureLedger(path, 10)).toMatchObject({ corrupt: 1, lines: [{ event: 2 }] });
    expect(readCaptureLedger(join(root, 'absent.jsonl'))).toEqual({ lines: [], corrupt: 0 });
  });

  describe('price table', () => {
    const at1 = t('2026-10-04T10:00:00Z');
    const at2 = t('2026-10-04T10:10:00Z');
    const prices: PriceTable = {
      meta: { source: 'test', fetchedAt: '2026-10-04T00:00:00Z', sha256: 'x', models: 2 },
      models: {
        'claude-opus-5-5': {
          input_cost_per_token: 0.00001,
          output_cost_per_token: 0.0001,
          cache_read_input_token_cost: 0.000001,
          cache_creation_input_token_cost: 0.00002,
        },
        'gpt-6.1-sol': { input_cost_per_token: 0.000002, output_cost_per_token: 0.00002 },
      },
    };
    const claudeCall = (id: string, model: string, ts = '2026-10-04T10:05:00Z') => ({
      type: 'assistant',
      timestamp: ts,
      message: {
        id,
        model,
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 50,
        },
      },
    });
    const claudeIntervals = (calls: unknown[], table: PriceTable | null) => {
      write(join(root, 'claude', 'projects', '-repo', 'sess-c.jsonl'), jsonl(calls));
      const seeded = join(root, 'repo', '.genie', 'genie.db');
      const db = existsSync(seeded)
        ? seeded
        : seedDb([
            { id: 1, task: 't1', kind: 'claim', at: at1 },
            { id: 2, task: 't1', kind: 'report', at: at2 },
          ]);
      const { matched } = verifyAgainstTaskEvents([line(db, 1, 'claim', at1), line(db, 2, 'report', at2)]);
      return buildIntervals(matched, env, table);
    };

    test('no table: the usage carries exactly the fields it always did — no costSource, no pricedCalls', () => {
      const [interval] = claudeIntervals([claudeCall('m1', 'claude-opus-5-5')], null);
      expect(interval?.usage).toEqual({
        calls: 1,
        input: 100,
        cacheRead: 1000,
        cacheWrite: 50,
        output: 10,
        costUsd: null,
      });
    });

    test('a Claude call is priced by the table; an unknown model or <synthetic> stays unknown, never 0', () => {
      const [priced] = claudeIntervals([claudeCall('m1', 'claude-opus-5-5')], prices);
      expect(priced?.usage?.costUsd).toBeCloseTo(100 * 0.00001 + 1000 * 0.000001 + 50 * 0.00002 + 10 * 0.0001, 12);
      expect(priced?.usage).toMatchObject({ costSource: 'table', pricedCalls: 1 });

      const [unknown] = claudeIntervals([claudeCall('m1', 'claude-unreleased-9')], prices);
      expect(unknown?.usage).toMatchObject({ calls: 1, costUsd: null, costSource: null, pricedCalls: 0 });

      const [synthetic] = claudeIntervals([claudeCall('m1', '<synthetic>')], prices);
      expect(synthetic?.usage?.costUsd).toBeNull();
    });

    test('the runtime’s own price beats the table; runtime + table calls are mixed', () => {
      const file = join(root, '.omp', 'agent', 'sessions', '-repo', '2026-10-04T10-00-00Z_pi-1.jsonl');
      const call = (ts: string, cost: { total: number } | undefined) => ({
        type: 'message',
        timestamp: ts,
        message: {
          role: 'assistant',
          model: 'openai-codex/gpt-6.1-sol',
          usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, ...(cost ? { cost } : {}) },
        },
      });
      write(file, jsonl([call('2026-10-04T10:01:00Z', { total: 0.5 }), call('2026-10-04T10:02:00Z', undefined)]));
      const pi: RuntimeSession = { id: null, source: 'pi', file };
      const db = seedDb([
        { id: 1, task: 't1', kind: 'claim', at: at1 },
        { id: 2, task: 't1', kind: 'report', at: at2 },
      ]);
      const { matched } = verifyAgainstTaskEvents([line(db, 1, 'claim', at1, pi), line(db, 2, 'report', at2, pi)]);
      const [mixed] = buildIntervals(matched, env, prices);
      // 0.5 from the runtime (never re-priced) + the table's price for the unpriced call, found by suffix.
      expect(mixed?.usage?.costUsd).toBeCloseTo(0.5 + 1000 * 0.000002 + 100 * 0.00002, 12);
      expect(mixed?.usage).toMatchObject({ costSource: 'mixed', pricedCalls: 2 });

      write(file, jsonl([call('2026-10-04T10:01:00Z', { total: 0.5 })]));
      const [runtimeOnly] = buildIntervals(matched, env, prices);
      expect(runtimeOnly?.usage).toMatchObject({ costUsd: 0.5, costSource: 'runtime', pricedCalls: 1 });
    });

    test('a zero-token call is never evidence of a price: alone it leaves the interval unknown', () => {
      const zero = {
        type: 'assistant',
        timestamp: '2026-10-04T10:04:00Z',
        message: { id: 'z', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } },
      };
      const [onlyZero] = claudeIntervals([zero], prices);
      expect(onlyZero?.usage).toMatchObject({ calls: 1, costUsd: null, costSource: null, pricedCalls: 0 });
      const [withReal] = claudeIntervals([zero, claudeCall('m1', 'claude-opus-5-5')], prices);
      expect(withReal?.usage).toMatchObject({ calls: 2, costSource: 'table', pricedCalls: 1 });
    });

    test('Claude 1-hour cache writes ride the sample and are priced at the 1h rate', () => {
      const ttl: PriceTable = {
        ...prices,
        models: {
          'claude-opus-5-5': {
            input_cost_per_token: 0.00001,
            output_cost_per_token: 0.0001,
            cache_creation_input_token_cost: 0.00002,
            cache_creation_input_token_cost_above_1hr: 0.00004,
          },
        },
      };
      const call = {
        type: 'assistant',
        timestamp: '2026-10-04T10:05:00Z',
        message: {
          id: 'h',
          model: 'claude-opus-5-5',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 100,
            cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 },
          },
        },
      };
      const [interval] = claudeIntervals([call], ttl);
      // The token total is unchanged; only the price splits by TTL.
      expect(interval?.usage).toMatchObject({ cacheWrite: 100, costSource: 'table' });
      expect(interval?.usage?.costUsd).toBeCloseTo(40 * 0.00002 + 60 * 0.00004, 12);
    });

    test('summary coverage: with a table each row carries calls and pricedCalls, and the text grows a column', () => {
      const intervals = claudeIntervals(
        [claudeCall('m1', 'claude-opus-5-5'), claudeCall('m2', 'claude-unreleased-9', '2026-10-04T10:06:00Z')],
        prices,
      );
      const [row] = summarize(intervals, true);
      expect(row).toMatchObject({ calls: 2, pricedCalls: 1, costSource: 'table' });
      const text = formatSummary(summarize(intervals, true), { lines: 2, unmatched: 0, corrupt: 0 });
      expect(text).toContain('\tpriced\tcostSource\n');
      expect(text).toMatch(/claim→report\t1\t.*\t1\/2\ttable\n/);

      const bare = summarize(claudeIntervals([claudeCall('m1', 'claude-opus-5-5')], null));
      expect(Object.keys(bare[0] ?? {})).not.toContain('pricedCalls');
      expect(Object.keys(bare[0] ?? {})).not.toContain('costSource');
      expect(formatSummary(bare, { lines: 2, unmatched: 0, corrupt: 0 })).not.toContain('priced');
    });

    test('summary provenance: runtime and table intervals make a mixed row; an unpriced row is null', () => {
      const usage = (costUsd: number | null, costSource: 'runtime' | 'table' | null) => ({
        calls: 1,
        input: 1,
        cacheRead: 0,
        cacheWrite: 0,
        output: 1,
        costUsd,
        costSource,
        pricedCalls: costUsd === null ? 0 : 1,
      });
      const at = (task: string, u: ReturnType<typeof usage>) =>
        ({
          db: '/d',
          task,
          fromEvent: 1,
          toEvent: 2,
          transition: 'claim→report',
          startAt: 0,
          endAt: 1,
          durationMs: 1,
          session: { id: 's', source: 'claude-code', file: null },
          usage: u,
          sharedSession: false,
          offload: null,
          sessionMatch: 'exact',
        }) as Interval;
      expect(summarize([at('a', usage(1, 'runtime')), at('b', usage(2, 'table'))], true)[0]).toMatchObject({
        costUsd: 3,
        costSource: 'mixed',
      });
      expect(summarize([at('a', usage(null, null))], true)[0]).toMatchObject({ costUsd: null, costSource: null });
      // Two finite interval costs whose sum overflows: unknown, never Infinity.
      expect(summarize([at('a', usage(1e308, 'table')), at('b', usage(1e308, 'table'))], true)[0]?.costUsd).toBeNull();
    });

    test('an interval sum that overflows is null, never Infinity; a negative runtime price is no price', () => {
      const huge: PriceTable = { ...prices, models: { 'claude-opus-5-5': { input_cost_per_token: 1e308 } } };
      const call = (id: string) => ({
        type: 'assistant',
        timestamp: '2026-10-04T10:05:00Z',
        message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 0 } },
      });
      const [overflow] = claudeIntervals([call('a'), call('b')], huge);
      expect(overflow?.usage).toMatchObject({ costUsd: null, costSource: null });

      const file = join(root, '.omp', 'agent', 'sessions', '-repo', '2026-10-04T10-00-00Z_pi-n.jsonl');
      const usage = { input: 1, output: 1, cost: { total: -0.5 } };
      write(
        file,
        jsonl([{ type: 'message', timestamp: '2026-10-04T10:00:07Z', message: { role: 'assistant', usage } }]),
      );
      expect(readUsageSamples({ id: null, source: 'pi', file }, env)[0]?.costUsd).toBeNull();
    });
  });
});

describe('Phoenix projection', () => {
  const interval = {
    db: '/repo/.genie/genie.db',
    task: 't1',
    fromEvent: 1,
    toEvent: 2,
    transition: 'claim→report',
    startAt: 0,
    endAt: 1000,
    durationMs: 1000,
    session: { id: 's', source: 'claude-code' as const, file: null },
    usage: { calls: 1, input: 1, cacheRead: 2, cacheWrite: 3, output: 4, costUsd: null },
    sharedSession: false,
    sessionMatch: 'exact' as const,
    offload: { attempts: 2, failed: 1, ambiguous: 0, tokens: 900, costUsd: 0.04 },
  };

  test('a target needs an http(s) endpoint, a project and at most an env var NAME for the key', () => {
    expect(validateTarget({ endpoint: 'http://px:6006/', project: 'mine' })).toEqual({
      endpoint: 'http://px:6006',
      project: 'mine',
    });
    expect(validateTarget({ project: 'mine' })).toBe('an http(s) endpoint');
    expect(validateTarget({ endpoint: 'https://px' })).toBe('a project name');
    expect(validateTarget({ endpoint: 'https://px', project: 'p', apiKeyEnv: 'sk-live-123' })).toContain('NAME');
  });

  test('the install salt is random, persisted 0600 and stable across calls', () => {
    const salt = installSalt();
    expect(salt).toMatch(/^[0-9a-f]{16}$/);
    expect(installSalt()).toBe(salt);
    expect(statSync(join(root, 'genie', 'metrics', 'export-salt')).mode & 0o777).toBe(0o600);
  });

  test('span ids are deterministic per install and the repo path is hashed, never sent', () => {
    const a = intervalSpan(interval, 'salt');
    expect(intervalSpan(interval, 'salt').context).toEqual(a.context);
    expect(intervalSpan(interval, 'other').context.span_id).not.toBe(a.context.span_id);
    expect(JSON.stringify(a)).not.toContain('/repo/');
    expect(a.attributes).toMatchObject({
      'llm.token_count.prompt': 6,
      'llm.token_count.completion': 4,
      'genie.transition': 'claim→report',
    });
    expect(a.attributes['llm.cost.total']).toBeUndefined();
    expect(a.attributes['genie.cost_source']).toBeUndefined();
    const tabled = intervalSpan(
      { ...interval, usage: { ...interval.usage, costUsd: 0.01, costSource: 'table' as const, pricedCalls: 1 } },
      'salt',
    );
    expect(tabled.attributes).toMatchObject({
      'llm.cost.total': 0.01,
      'genie.cost_source': 'table',
      'genie.cost.priced_calls': 1,
      'genie.model_calls': 1,
    });
    // Without a table the span carries no coverage attribute at all.
    expect(a.attributes['genie.cost.priced_calls']).toBeUndefined();
    expect(a.attributes).toMatchObject({
      'genie.offload.attempts': 2,
      'genie.offload.failed': 1,
      'genie.offload.cost_usd': 0.04,
    });
  });

  test('posts only ids Phoenix does not hold and reports what never read back', async () => {
    const stored = new Set<string>();
    const posted: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { data: Array<{ context: { span_id: string } }> };
        for (const span of body.data) posted.push(span.context.span_id);
        return new Response('{"total_queued":1}', { status: 202 });
      }
      expect(String(url)).toContain('attribute=genie.export_id');
      return new Response(
        JSON.stringify({ data: [...stored].map((id) => ({ context: { span_id: id } })), next_cursor: null }),
      );
    }) as typeof fetch;
    try {
      const target = { endpoint: 'http://px', project: 'p' };
      const first = await projectToPhoenix(target, [interval], { timeoutMs: 0, pollMs: 1 });
      expect(first).toEqual({ expected: 1, alreadyStored: 0, posted: 1, missing: 1 });
      for (const id of posted) stored.add(id);
      const second = await projectToPhoenix(target, [interval], { timeoutMs: 0, pollMs: 1 });
      expect(second).toEqual({ expected: 1, alreadyStored: 1, posted: 0, missing: 0 });
      expect(posted).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
