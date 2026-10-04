import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaptureLine, RuntimeSession } from './metrics-capture.js';
import { buildIntervals, readCaptureLedger, summarize, verifyAgainstTaskEvents } from './metrics-export.js';
import { installSalt, intervalSpan, projectToPhoenix, validateTarget } from './metrics-phoenix.js';
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
    expect(samples[0]).toMatchObject({ cacheRead: 10, cacheWrite: 5, output: 2, costUsd: null });
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

  test('a corrupt ledger line is counted, and --since drops older lines', () => {
    const path = join(root, 'events.jsonl');
    write(
      path,
      `${JSON.stringify(line('/x', 1, 'claim', 5))}\n{"torn\n${JSON.stringify(line('/x', 2, 'report', 50))}\n`,
    );
    expect(readCaptureLedger(path, 10)).toMatchObject({ corrupt: 1, lines: [{ event: 2 }] });
    expect(readCaptureLedger(join(root, 'absent.jsonl'))).toEqual({ lines: [], corrupt: 0 });
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
