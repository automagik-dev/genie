/**
 * `--agents-dir` is strictly additive, and this file is the proof.
 *
 * Half of it is over the parsed options (pure, free); the other half is a DRY
 * bench run — a fixture set filtered to nothing by `--only`, so zero jobs exist,
 * no provider is called and no cent is spent — whose printed table, summary line
 * and recorded JSON are compared with and without the flag. The one difference
 * a reader is allowed to see is the recorded `agentsDir` key itself.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BenchUsageError, parseBenchOptions } from './bench-options';

const REPO = resolve(import.meta.dir, '..', '..');

describe('parseBenchOptions', () => {
  test('no --agents-dir leaves the key off entirely, so runAgent keeps its own default', () => {
    const o = parseBenchOptions(['wish-context'], '/repo');
    expect('agentsDir' in o).toBe(false);
    expect(o.agentsDir).toBeUndefined();
    expect(o).toEqual({
      agent: 'wish-context',
      dir: '/repo',
      reps: 1,
      concurrency: 3,
      only: undefined,
      tags: {},
      fixturesPath: '/repo/scripts/mikro/fixtures/wish-context.json',
      phoenix: true,
      writeEvidence: false,
    });
  });

  test('--agents-dir is resolved to an absolute path and changes nothing else', () => {
    const base = parseBenchOptions(['review-prep', '--dir', '/repo', '--reps', '2'], '/cwd');
    const withFlag = parseBenchOptions(
      ['review-prep', '--dir', '/repo', '--reps', '2', '--agents-dir', 'tmp/copy/.mikro/agents'],
      '/cwd',
    );
    expect(withFlag.agentsDir).toBe(resolve('tmp/copy/.mikro/agents'));
    expect({ ...withFlag, agentsDir: undefined }).toEqual({ ...base, agentsDir: undefined });
  });

  test('the registry decides the agent name — --agents-dir does not register one', () => {
    expect(() => parseBenchOptions(['mikro-scribe'], '/repo')).toThrow(BenchUsageError);
    expect(() => parseBenchOptions(['mikro-scribe', '--agents-dir', '/tmp/agents'], '/repo')).toThrow(BenchUsageError);
    expect(() => parseBenchOptions([], '/repo')).toThrow(BenchUsageError);
    // …and every registered name is accepted, including the coach.
    for (const name of ['issue-triage', 'wish-context', 'review-prep', 'mikro-coach'])
      expect(parseBenchOptions([name], '/repo').agent).toBe(name);
  });

  test('the other flags keep their meanings', () => {
    const o = parseBenchOptions(
      [
        'issue-triage',
        '--dir',
        '/repo',
        '--reps',
        '3',
        '--concurrency',
        '1',
        '--only',
        'a,,b',
        '--tag',
        'round=7',
        '--tag',
        'note=a=b',
        '--fixtures',
        '/f.json',
        '--timeout-ms',
        '1000',
        '--no-phoenix',
        '--write-evidence',
      ],
      '/cwd',
    );
    expect(o).toMatchObject({
      reps: 3,
      concurrency: 1,
      only: ['a', 'b'],
      tags: { round: '7', note: 'a=b' },
      fixturesPath: '/f.json',
      timeoutMs: 1000,
      phoenix: false,
      writeEvidence: true,
    });
  });
});

/** One dry bench run: zero jobs, no provider call, one recorded JSON. */
function dryBench(extra: string[]): { stdout: string; record: Record<string, unknown> } {
  const dir = mkdtempSync(join(tmpdir(), 'mikro-bench-dry-'));
  try {
    const fixtures = join(dir, 'fixtures.json');
    writeFileSync(fixtures, JSON.stringify({ fixtures: [{ id: 'kept-out', prompt: 'x', truth: {} }] }));
    mkdirSync(join(dir, '.mikro', 'runs'), { recursive: true });
    const proc = Bun.spawnSync(
      [
        'bun',
        join(REPO, 'scripts', 'mikro', 'bench.ts'),
        'wish-context',
        '--dir',
        dir,
        '--fixtures',
        fixtures,
        '--only',
        'no-such-fixture',
        '--no-phoenix',
        ...extra,
      ],
      { cwd: REPO },
    );
    const runs = join(dir, '.mikro', 'runs');
    const written = readdirSync(runs).filter((f) => f.startsWith('bench-'));
    expect(written).toHaveLength(1);
    return {
      stdout: proc.stdout.toString(),
      record: JSON.parse(readFileSync(join(runs, written[0]), 'utf8')) as Record<string, unknown>,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('bench.ts --agents-dir (dry run, no provider call)', () => {
  test('without the flag the transcript and the record are what they always were', () => {
    const { stdout, record } = dryBench([]);
    expect(stdout).toContain('| fixture | rep | ok |');
    expect(stdout).toContain('runs 0 · yield 0.00');
    expect('agentsDir' in record).toBe(false);
    expect(Object.keys(record)).toEqual(['traceId', 'tags', 'summary', 'bars', 'rows', 'results']);
  });

  test('with the flag only the recorded agentsDir differs', () => {
    const plain = dryBench([]);
    const pointed = dryBench(['--agents-dir', join(REPO, '.mikro', 'agents')]);
    expect(pointed.stdout).toBe(plain.stdout);
    expect(pointed.record.agentsDir).toBe(join(REPO, '.mikro', 'agents'));
    const comparable = (r: Record<string, unknown>) => {
      const copy = { ...r };
      copy.traceId = undefined;
      copy.agentsDir = undefined;
      return copy;
    };
    expect(comparable(pointed.record)).toEqual(comparable(plain.record));
  });
});
