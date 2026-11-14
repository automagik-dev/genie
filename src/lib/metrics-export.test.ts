import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { CaptureLine, RuntimeSession } from './metrics-capture.js';
import {
  type Interval,
  buildIntervals,
  formatSummary,
  formatTaskUsage,
  ledgerRepos,
  readCaptureLedger,
  readTaskUsage,
  summarize,
  verifyAgainstTaskEvents,
} from './metrics-export.js';
import { installSalt, intervalSpan, projectToPhoenix, validateTarget } from './metrics-phoenix.js';

let root: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genie-metrics-export-'));
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

  test('intervals carry the card time and the opening session; no runtime session log is read', () => {
    const at1 = t('2026-10-04T10:00:00Z');
    const at2 = t('2026-10-04T10:10:00Z');
    const at3 = t('2026-10-04T10:20:00Z');
    // The opening session's own log, with usage inside the window: before the meter cutover the export summed it.
    write(
      join(root, 'claude', 'projects', '-repo', 'sess-c.jsonl'),
      jsonl([
        {
          type: 'assistant',
          timestamp: '2026-10-04T10:05:00Z',
          message: { id: 'in', usage: { input_tokens: 424242, output_tokens: 10 } },
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
    const intervals = buildIntervals(matched);
    expect(intervals.map((i) => [i.transition, i.durationMs, i.session])).toEqual([
      ['claim→report', 600_000, session],
      ['report→move', 600_000, silent],
    ]);
    expect(Object.keys(intervals[0] as Interval).sort()).toEqual(
      [
        'db',
        'durationMs',
        'endAt',
        'fromEvent',
        'offload',
        'session',
        'startAt',
        'task',
        'toEvent',
        'transition',
      ].sort(),
    );
    expect(summarize(intervals)).toEqual([
      { transition: 'claim→report', n: 1, p50Minutes: 10, p90Minutes: 10, offloadUsd: null },
      { transition: 'report→move', n: 1, p50Minutes: 10, p90Minutes: 10, offloadUsd: null },
    ]);
    expect(JSON.stringify(intervals)).not.toContain('424242');
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
    const [unknown] = buildIntervals(verifyAgainstTaskEvents(lines).matched);
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
    const [priced] = buildIntervals(verifyAgainstTaskEvents(lines).matched);
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
    const intervals = buildIntervals(verifyAgainstTaskEvents(lines).matched);
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
    const again = buildIntervals(verifyAgainstTaskEvents(lines).matched).find((i) => i.task === 't1');
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
      const offload = () => buildIntervals(verifyAgainstTaskEvents(lines).matched)[0]?.offload;
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
    const offload = () => buildIntervals(verifyAgainstTaskEvents(lines).matched)[0]?.offload;
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
      `${JSON.stringify(line('/x/.genie/genie.db', 1, 'claim', 5))}\n{"torn\n${JSON.stringify(line('/x/.genie/genie.db', 2, 'report', 50))}\n`,
    );
    expect(readCaptureLedger(path, 10)).toMatchObject({ corrupt: 1, lines: [{ event: 2 }] });
    expect(readCaptureLedger(join(root, 'absent.jsonl'))).toEqual({ lines: [], corrupt: 0, ignored: 0 });
  });

  describe('lines of a database that is not <root>/.genie/genie.db are ignored (#3135)', () => {
    const at1 = t('2026-10-04T10:00:00Z');
    const at2 = t('2026-10-04T10:10:00Z');
    const events = [
      { id: 1, task: 't1', kind: 'claim', at: at1 },
      { id: 2, task: 't1', kind: 'report', at: at2 },
    ];

    /** A test database with REAL matching rows: before the filter it verified and produced an interval. */
    function seedScratchDb(): string {
      const repoDb = seedDb(events);
      const scratch = join(root, 'genie-task-AbCd', 'race.db');
      mkdirSync(join(scratch, '..'), { recursive: true });
      copyFileSync(repoDb, scratch);
      return scratch;
    }

    test('a mixed ledger builds intervals only from the per-repo lines and counts the rest', () => {
      const scratch = seedScratchDb();
      const repoDb = join(root, 'repo', '.genie', 'genie.db');
      const path = join(root, 'events.jsonl');
      const body = jsonl([
        line(scratch, 1, 'claim', at1),
        line(repoDb, 1, 'claim', at1),
        line(scratch, 2, 'report', at2),
        line(repoDb, 2, 'report', at2),
        { ...line(repoDb, 2, 'report', at2), db: undefined },
      ]);
      write(path, body);

      const ledger = readCaptureLedger(path);
      expect(ledger.ignored).toBe(3);
      expect(ledger.corrupt).toBe(0);
      expect(ledger.lines.map((l) => l.db)).toEqual([repoDb, repoDb]);
      const { matched, unmatched } = verifyAgainstTaskEvents(ledger.lines);
      expect(unmatched).toBe(0);
      const intervals = buildIntervals(matched);
      expect(intervals).toHaveLength(1);
      expect(intervals[0]).toMatchObject({ db: repoDb, transition: 'claim→report' });
      // The ledger is read, never rewritten.
      expect(readFileSync(path, 'utf8')).toBe(body);

      const stats = { lines: ledger.lines.length, unmatched, corrupt: ledger.corrupt, ignored: ledger.ignored };
      expect(formatSummary(summarize(intervals), stats).split('\n')[0]).toBe(
        'ledger lines 2, unmatched 0, corrupt 0, ignored 3',
      );
      // --since applies first: a line outside the window is not counted as ignored either.
      expect(readCaptureLedger(path, at2)).toMatchObject({ ignored: 2, lines: [{ event: 2 }] });
    });

    test('a ledger with only per-repo lines reads and prints exactly as before', () => {
      const repoDb = seedDb(events);
      const path = join(root, 'events.jsonl');
      const lines = [line(repoDb, 1, 'claim', at1), line(repoDb, 2, 'report', at2)];
      write(path, jsonl(lines));
      const ledger = readCaptureLedger(path);
      expect(ledger).toEqual({ lines, corrupt: 0, ignored: 0 });
      const summary = summarize(buildIntervals(verifyAgainstTaskEvents(ledger.lines).matched));
      const pinned =
        'ledger lines 2, unmatched 0, corrupt 0\n' +
        'transition\tn\tp50min\tp90min\toffloadUsd\n' +
        'claim→report\t1\t10.0\t10.0\t-\n';
      expect(formatSummary(summary, { lines: 2, unmatched: 0, corrupt: 0 })).toBe(pinned);
      expect(formatSummary(summary, { lines: 2, unmatched: 0, corrupt: 0, ignored: 0 })).toBe(pinned);
      expect(formatSummary([], { lines: 0, unmatched: 0, corrupt: 0, ignored: 0 })).toBe(
        'ledger lines 0, unmatched 0, corrupt 0\nno intervals yet: a card needs two captured events\n',
      );
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
    expect(a.attributes).toMatchObject({ 'genie.transition': 'claim→report', 'genie.duration_ms': 1000 });
    // Per-transition tokens left the export with the meter cutover (D5): no span carries a token count or a cost.
    expect(Object.keys(a.attributes).filter((k) => k.startsWith('llm.') || k.includes('usage'))).toEqual([]);
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

describe('task usage from the Rust meter (genie-rs usage)', () => {
  /** A stand-in genie-rs: logs its argv, prints `answer.json`, exits with `exit.code` (0 by default). */
  function stubGenieRs(answer: string, code = 0): { path: string; calls: () => string[] } {
    const dir = join(root, 'bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'answer.json'), answer);
    const path = join(dir, 'genie-rs');
    writeFileSync(
      path,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/calls.log"\ncat "${dir}/answer.json"\nexit ${code}\n`,
      { mode: 0o755 },
    );
    const calls = () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n');
    return { path, calls };
  }
  const tokens = (total: number) => ({
    input: total,
    cache_read: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    output: 0,
    reasoning: 0,
    unsplit: 0,
    total,
  });
  const measured = {
    repo: 'example.com/Acme/Widgets',
    repo_aliases: [],
    window: 'd7',
    meter_state: 'measured',
    meter_reason: null,
    meter: { meter_version: '3.138.5', pricing: { table: { origin: 'bundled' } } },
    rows: [
      { task: 'gn-1', state: 'measured', reason: null, tokens: tokens(14450), cost: { state: 'priced', usd: 0.0275 } },
      {
        task: 'gn-4',
        state: 'measured',
        reason: 'unpriced_models',
        tokens: tokens(900),
        cost: { state: 'unpriced', usd: null, unpriced_models: ['acme-local-1'] },
      },
      {
        task: 'gn-6',
        state: 'stale',
        reason: 'ingestion_stale',
        tokens: tokens(77),
        cost: { state: 'priced', usd: null },
      },
      { task: 'gn-9', state: 'missing', reason: 'task_ambiguous', tokens: null, cost: null },
    ],
  };

  test('one call per repository with the window, its rows as the meter gave them, and – wherever it cannot say', () => {
    const bin = stubGenieRs(JSON.stringify(measured));
    const usage = readTaskUsage('/work/Widgets', 'd7', { path: bin.path });
    // genie never names a previous repository name: genie-rs owns the aliases (KNOWN_PREVIOUS_REPO_SLUGS).
    expect(bin.calls()).toEqual(['usage --project /work/Widgets --window d7 --json']);
    expect(usage).toMatchObject({ project: '/work/Widgets', meter_state: 'measured', meter_reason: null });
    expect(usage.rows?.map((r) => r.task)).toEqual(['gn-1', 'gn-4', 'gn-6', 'gn-9']);
    expect(usage.meter).toEqual(measured.meter);
    expect(formatTaskUsage([usage])).toBe(
      'task usage example.com/Acme/Widgets (usagemeter query --by task, d7)\n' +
        'task\ttokens\tusd\tstate\treason\n' +
        'gn-1\t14450\t0.0275\tpriced\t-\n' +
        'gn-4\t900\t–\tunpriced\tunpriced_models\n' +
        'gn-6\t–\t–\tstale\tingestion_stale\n' +
        'gn-9\t–\t–\tmissing\ttask_ambiguous\n',
    );
    const empty = readTaskUsage('/work/Widgets', 'd1', {
      path: stubGenieRs(JSON.stringify({ ...measured, rows: [] })).path,
    });
    expect(formatTaskUsage([empty])).toContain('no task usage in d1\n');
    expect(formatTaskUsage([])).toBe('');
  });

  test('a meter that cannot answer, or a genie-rs that cannot run, is – with its reason: rows null, never 0', () => {
    const tooOld = { ...measured, meter_state: 'missing', meter_reason: 'needs usagemeter >= 3.129.2', rows: null };
    const old = readTaskUsage('/w', 'd30', { path: stubGenieRs(JSON.stringify(tooOld)).path });
    expect(old).toMatchObject({ meter_state: 'missing', meter_reason: 'needs usagemeter >= 3.129.2', rows: null });
    expect(old.meter).toBeNull();
    expect(formatTaskUsage([old])).toBe(
      'task usage example.com/Acme/Widgets (usagemeter query --by task, d30)\n–\tneeds usagemeter >= 3.129.2\n',
    );
    const reasonOf = (bin: { path: string } | { missing: string }) => readTaskUsage('/w', 'd30', bin).meter_reason;
    expect(reasonOf({ missing: 'GENIE_RS_BIN=/x does not exist' })).toBe(
      'genie_rs_unavailable: GENIE_RS_BIN=/x does not exist',
    );
    expect(reasonOf({ path: join(root, 'no-such-genie-rs') })).toStartWith('genie_rs_unavailable: ');
    expect(reasonOf({ path: stubGenieRs('', 2).path })).toBe('genie_rs_exit_2');
    expect(reasonOf({ path: stubGenieRs('not json').path })).toBe('invalid_json');
    expect(reasonOf({ path: stubGenieRs(JSON.stringify({ ...measured, rows: 'x' })).path })).toBe('invalid_json');
    expect(reasonOf({ path: stubGenieRs('null').path })).toBe('invalid_json');
    for (const bin of [{ missing: 'x' }, { path: stubGenieRs('not json').path }]) {
      expect(readTaskUsage('/w', 'd30', bin)).toMatchObject({ meter_state: 'missing', rows: null, meter: null });
    }
  });

  test('the repositories asked about are the verified ledger’s, each once', () => {
    const at = (db: string, event: number) => ({ db, event }) as CaptureLine;
    expect(
      ledgerRepos([at('/a/.genie/genie.db', 1), at('/b/.genie/genie.db', 2), at('/a/.genie/genie.db', 3)]),
    ).toEqual(['/a', '/b']);
    expect(ledgerRepos([])).toEqual([]);
  });
});
