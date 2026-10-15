import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CaptureBundle, captureOmpAttempt } from './capture';
import { parseNativeRequestRecord } from './contracts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'omp');
const SLUG = '--work-bench-task--';
const MAX = 1_000_000;

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** A fresh isolated native home holding copies of the named fixture sessions (and their actor folders). */
function homeWith(...sessions: string[]): string {
  const home = tempDir('capture-home-');
  const dir = join(home, '.omp', 'agent', 'sessions', SLUG);
  mkdirSync(dir, { recursive: true });
  for (const name of sessions) {
    cpSync(join(FIXTURES, `${name}.jsonl`), join(dir, `${name}.jsonl`));
    if (existsSync(join(FIXTURES, name))) cpSync(join(FIXTURES, name), join(dir, name), { recursive: true });
  }
  return home;
}

function capture(home: string, maxBytes = MAX): CaptureBundle {
  const result = captureOmpAttempt(home, { maxBytes });
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return result.value;
}

describe('session linkage', () => {
  test('one top-level session is isolated-home and every request carries its id', () => {
    const home = homeWith('lead-child-aux');
    const bundle = capture(home);
    expect(bundle.linkage).toEqual({
      match: 'isolated-home',
      file: join(home, '.omp', 'agent', 'sessions', SLUG, 'lead-child-aux.jsonl'),
    });
    expect(bundle.requests).toHaveLength(4);
    for (const request of bundle.requests) {
      expect(request.nativeSessionId).toBe('sess-lead-0001');
      expect(parseNativeRequestRecord(request).ok).toBe(true);
    }
    expect(bundle.actors.map((a) => [a.actorId, a.parentActorId, a.role])).toEqual([
      ['sess-lead-0001', null, 'lead'],
      ['sess-aux-0001', 'sess-lead-0001', 'auxiliary'],
      ['sess-child-0001', 'sess-lead-0001', 'worker'],
    ]);
    expect(bundle.evidence).toHaveLength(3);
  });

  test('two top-level sessions are ambiguous and no request carries a session id', () => {
    const bundle = capture(homeWith('lead-child-aux', 'second-session'));
    expect(bundle.linkage.match).toBe('ambiguous');
    if (bundle.linkage.match === 'ambiguous') expect(bundle.linkage.candidates).toHaveLength(2);
    expect(bundle.requests).toHaveLength(5);
    for (const request of bundle.requests) expect(request.nativeSessionId).toBeNull();
  });

  test('an empty home has no linkage', () => {
    const bundle = capture(tempDir('capture-empty-'));
    expect(bundle.linkage).toEqual({ match: 'none' });
    expect(bundle.requests).toEqual([]);
  });
});

describe('token presence', () => {
  test('the undivided cacheWrite is the total; the 5m/1h split is unsupported, and reasoning sits inside output', () => {
    const [first] = capture(homeWith('lead-child-aux')).requests;
    expect(first.tokens).toEqual({
      input: 1200,
      cacheRead: 800,
      cacheWriteTotal: 400,
      cacheWrite5m: null,
      cacheWrite1h: null,
      output: 300,
      reasoning: 120,
    });
    expect(first.presence['tokens.cacheWriteTotal']).toBe('observed');
    expect(first.presence['tokens.cacheWrite5m']).toBe('unsupported');
    expect(first.presence['tokens.cacheWrite1h']).toBe('unsupported');
    expect(first.reasoningIncludedInOutput).toBe(true);
    expect(first.requestedModel).toBe('model-requested');
    expect(first.observedModel).toBe('model-observed');
    expect(first.effort).toBe('medium');
  });

  test('a message without a usage block has null tokens with presence absent, counted missing', () => {
    const bundle = capture(homeWith('missing-usage'));
    expect(bundle.requests).toHaveLength(1);
    const [request] = bundle.requests;
    for (const value of Object.values(request.tokens)) expect(value).toBeNull();
    for (const field of Object.keys(request.tokens)) expect(request.presence[`tokens.${field}`]).toBe('absent');
    expect(bundle.health.missing).toBe(1);
  });
});

describe('request identity', () => {
  test('a later streaming revision replaces the earlier one', () => {
    const bundle = capture(homeWith('streaming-revision'));
    expect(bundle.requests).toHaveLength(1);
    expect(bundle.requests[0].tokens.output).toBe(250);
    expect(bundle.requests[0].revision).toBe('2026-10-01T13:00:08.000Z');
    expect(bundle.health.duplicate).toBe(0);
  });

  test('an exact duplicate is counted once and a malformed line is skipped', () => {
    const bundle = capture(homeWith('malformed-duplicate'));
    expect(bundle.requests).toHaveLength(1);
    expect(bundle.health.duplicate).toBe(1);
    expect(bundle.health.malformed).toBe(1);
  });

  test('same identity and revision with different counters is conflicting', () => {
    const bundle = capture(homeWith('conflicting'));
    expect(bundle.requests).toHaveLength(1);
    expect(bundle.health.conflicting).toBe(1);
    expect(bundle.health.duplicate).toBe(0);
  });

  test('a retry links to the failed request it repeats, and a failed request stays its own record', () => {
    const bundle = capture(homeWith('retry-failed'));
    expect(bundle.requests.map((r) => [r.requestId, r.failed, r.retryOf])).toEqual([
      ['r02', true, null],
      ['r03', false, 'r02'],
      ['r05', true, null],
    ]);
  });
});

describe('input origin', () => {
  test('steering adds no attempt and no user-role message is classified human', () => {
    const bundle = capture(homeWith('steered-injected'));
    expect(bundle.requests).toHaveLength(3);
    expect(bundle.inputs.map((i) => [i.eventId, i.kind, i.origin])).toEqual([
      ['sess-steer-0008:t01', 'initial-task', 'unknown'],
      ['sess-steer-0008:t04', 'message', 'unknown'],
      ['sess-steer-0008:t06', 'message', 'unknown'],
    ]);
  });

  test('a nested actor prompt is automated', () => {
    const inputs = capture(homeWith('lead-child-aux')).inputs;
    expect(inputs.filter((i) => i.origin === 'human')).toEqual([]);
    expect(inputs.filter((i) => i.origin === 'automated')).toHaveLength(2);
  });
});

describe('bounds', () => {
  test('maxBytes below the fixture size truncates', () => {
    const home = homeWith('lead-child-aux');
    const size = statSync(join(home, '.omp', 'agent', 'sessions', SLUG, 'lead-child-aux.jsonl')).size;
    const bundle = capture(home, 300);
    expect(300).toBeLessThan(size);
    expect(bundle.health.truncated).toBe(true);
    expect(bundle.health.bytesRead).toBeLessThanOrEqual(300);
  });

  test('a session in a decoy $HOME/.omp never reaches the bundle', () => {
    const decoy = tempDir('capture-decoy-');
    const decoySessions = join(decoy, '.omp', 'agent', 'sessions', SLUG);
    mkdirSync(decoySessions, { recursive: true });
    cpSync(join(FIXTURES, 'second-session.jsonl'), join(decoySessions, 'second-session.jsonl'));
    const home = homeWith('lead-child-aux');
    const saved = process.env.HOME;
    process.env.HOME = decoy;
    try {
      const bundle = capture(home);
      expect(bundle.linkage.match).toBe('isolated-home');
      expect(bundle.actors.map((a) => a.actorId)).not.toContain('sess-second-0002');
      for (const ref of bundle.evidence) expect(ref.path.startsWith(decoy)).toBe(false);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, 'HOME');
      else process.env.HOME = saved;
    }
  });

  test('capture makes no network call', () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('network access during capture');
    }) as unknown as typeof fetch;
    try {
      const result = captureOmpAttempt(homeWith('lead-child-aux'), { maxBytes: MAX });
      expect(result.ok).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});
