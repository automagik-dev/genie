import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type PriceTable, loadPriceTable } from '../../src/lib/metrics-prices';
import { type AttemptEconomics, type PriceBasis, attemptEconomics, cohortEconomics } from './accounting';
import { type CaptureBundle, captureOmpAttempt } from './capture';
import type { NativeRequestRecord, Presence } from './contracts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'omp');
const SLUG = '--work-bench-task--';
const SHA = 'a'.repeat(64);

const temps: string[] = [];
let savedGenieHome: string | undefined;

beforeAll(() => {
  savedGenieHome = process.env.GENIE_HOME;
  process.env.GENIE_HOME = tempDir('accounting-genie-home-');
});

afterAll(() => {
  if (savedGenieHome === undefined) Reflect.deleteProperty(process.env, 'GENIE_HOME');
  else process.env.GENIE_HOME = savedGenieHome;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  // The GENIE_HOME temp dir is the first one; it lives until afterAll.
  for (const dir of temps.splice(1)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** Copies the named G5 fixture sessions (read-only sources) into a fresh isolated native home and captures it. */
function captureFixture(...sessions: string[]): CaptureBundle {
  const home = tempDir('accounting-home-');
  const dir = join(home, '.omp', 'agent', 'sessions', SLUG);
  mkdirSync(dir, { recursive: true });
  for (const name of sessions) {
    cpSync(join(FIXTURES, `${name}.jsonl`), join(dir, `${name}.jsonl`));
    if (existsSync(join(FIXTURES, name))) cpSync(join(FIXTURES, name), join(dir, name), { recursive: true });
  }
  const result = captureOmpAttempt(home, { maxBytes: 1_000_000 });
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return result.value;
}

/** Single-rate entries: one cache-write rate, no distinct 1-hour TTL rate. */
const SINGLE_RATE = {
  'model-observed': {
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.00001,
    cache_read_input_token_cost: 0.0000005,
    cache_creation_input_token_cost: 0.000004,
  },
  'model-small': {
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000005,
    cache_read_input_token_cost: 0.0000001,
    cache_creation_input_token_cost: 0.000001,
  },
};

/** Writes a stored-shape table into a temp dir and loads it the way the operator's `--prices <file>` is loaded. */
function storedTable(models: Record<string, unknown>, sha256 = SHA): { table: PriceTable; path: string } {
  const path = join(tempDir('accounting-prices-'), 'prices.json');
  const meta = { source: 'fixture://prices', fetchedAt: '2026-10-01T00:00:00.000Z', sha256, models: 2 };
  writeFileSync(path, `${JSON.stringify({ genie: meta, models })}\n`);
  const table = loadPriceTable(path);
  if (!table) throw new Error('fixture price table did not load');
  return { table, path };
}

function basisFor(table: PriceTable, path: string, route: PriceBasis['route'] = 'api'): PriceBasis {
  const { source, fetchedAt, sha256 } = table.meta;
  return { path, source, fetchedAt, sha256, currency: 'USD', route };
}

function priced(bundle: CaptureBundle, models: Record<string, unknown>, route?: PriceBasis['route']): AttemptEconomics {
  const { table, path } = storedTable(models);
  return attemptEconomics(bundle, 'attempt-1', table, basisFor(table, path, route));
}

/** An in-memory request record with every token observed unless set to null. */
function record(
  over: Partial<Omit<NativeRequestRecord, 'tokens'>> & { tokens?: Partial<NativeRequestRecord['tokens']> },
): NativeRequestRecord {
  const tokens: NativeRequestRecord['tokens'] = {
    input: 0,
    cacheRead: 0,
    cacheWriteTotal: 0,
    cacheWrite5m: null,
    cacheWrite1h: null,
    output: 0,
    reasoning: null,
    ...over.tokens,
  };
  const presence: Record<string, Presence> = {};
  for (const [field, value] of Object.entries(tokens))
    presence[`tokens.${field}`] = value === null ? 'absent' : 'observed';
  return {
    requestId: 'req',
    responseId: null,
    revision: '2026-10-01T10:00:00.000Z',
    actorId: 'lead',
    parentActorId: null,
    role: 'lead',
    nativeSessionId: 'sess',
    requestedModel: null,
    observedModel: 'model-observed',
    effort: null,
    reasoningIncludedInOutput: null,
    durationMs: null,
    failed: false,
    retryOf: null,
    ...over,
    tokens,
    presence: { ...presence, ...over.presence },
  };
}

/** A gap-free in-memory bundle holding exactly the given records. */
function bundleOf(requests: NativeRequestRecord[]): CaptureBundle {
  return {
    linkage: { match: 'isolated-home', file: 'lead.jsonl' },
    actors: [
      { actorId: 'lead', parentActorId: null, role: 'lead', sessionFile: 'lead.jsonl', pending: false },
      { actorId: 'child', parentActorId: 'lead', role: 'worker', sessionFile: 'lead/child.jsonl', pending: false },
      { actorId: 'aux', parentActorId: 'lead', role: 'auxiliary', sessionFile: 'lead/aux.jsonl', pending: false },
    ],
    requests,
    inputs: [],
    health: { malformed: 0, duplicate: 0, conflicting: 0, unmatched: 0, missing: 0, truncated: false, bytesRead: 0 },
    evidence: [],
  };
}

/*
 * Hand-computed per-request costs for the lead-child-aux fixture at SINGLE_RATE (USD):
 *   lead e03  model-observed  input 1200*2e-6 + output 300*1e-5 + cacheRead 800*5e-7 + cacheWrite 400*4e-6 = 0.0074
 *             (reasoning 120 is inside output and is not added: re-adding it would give 0.0086)
 *   lead e05  model-observed  input 1600*2e-6 + cacheRead 1200*5e-7                                       = 0.0038
 *   aux  x02  model-small     input 60*1e-6 + output 5*5e-6                                                = 0.000085
 *   child c02 model-observed  input 900*2e-6 + output 150*1e-5 + cacheWrite 300*4e-6                      = 0.0045
 *   attempt                                                                                                = 0.015785
 */
const LEAD_CHILD_AUX_USD = 0.015785;

describe('whole-attempt sum', () => {
  test('lead + child + aux costs the hand-computed sum of their individual requests', () => {
    const econ = priced(captureFixture('lead-child-aux'), SINGLE_RATE);
    expect(econ.requests).toBe(4);
    expect(econ.normalizedCostUsd).toBeCloseTo(LEAD_CHILD_AUX_USD, 12);
    expect(econ.coverage).toEqual({ nativeSource: 'complete', pricedRequests: 4, unpricedRequests: 0 });
    expect(econ.tokens).toEqual({
      input: 3760,
      cacheRead: 2000,
      cacheWriteTotal: 700,
      cacheWrite5m: null,
      cacheWrite1h: null,
      output: 455,
      reasoning: null,
    });
    expect(econ.retries).toBe(0);
    expect(econ.failedRequests).toBe(0);
    expect(econ.attemptId).toBe('attempt-1');
  });

  test('all four requests are counted: lead twice, aux and child', () => {
    const bundle = captureFixture('lead-child-aux');
    const roles = bundle.requests.map((r) => r.role).sort();
    expect(roles).toEqual(['auxiliary', 'lead', 'lead', 'worker']);
    expect(priced(bundle, SINGLE_RATE).requests).toBe(4);
  });

  test('a root rollup beside its descendants is excluded; the total is the descendants alone', () => {
    const child = record({
      requestId: 'c1',
      actorId: 'child',
      parentActorId: 'lead',
      role: 'worker',
      tokens: { input: 900, output: 150, cacheWriteTotal: 300 },
    });
    const aux = record({
      requestId: 'x1',
      actorId: 'aux',
      parentActorId: 'lead',
      role: 'auxiliary',
      observedModel: 'model-small',
      tokens: { input: 60, output: 5 },
    });
    const rollup = record({
      requestId: 'rollup',
      tokens: { input: 960, output: 155, cacheWriteTotal: 300 },
      presence: { rollup: 'observed' },
    });
    const econ = priced(bundleOf([rollup, child, aux]), SINGLE_RATE);
    // child 0.0045 + aux 0.000085, hand-computed as in the fixture comment above.
    expect(econ.normalizedCostUsd).toBeCloseTo(0.004585, 12);
    expect(econ.requests).toBe(2);
    expect(econ.tokens.input).toBe(960);
    expect(econ.tokens.output).toBe(155);
  });
});

describe('token conventions', () => {
  test('a reasoning subset inside output is not added again (lead request, reasoning 120)', () => {
    const bundle = captureFixture('lead-child-aux');
    const [lead] = bundle.requests;
    expect(lead.tokens.reasoning).toBe(120);
    expect(lead.reasoningIncludedInOutput).toBe(true);
    const econ = priced(bundleOf([lead]), SINGLE_RATE);
    expect(econ.normalizedCostUsd).toBeCloseTo(0.0074, 12);
    expect(econ.tokens.output).toBe(300);
    expect(econ.tokens.reasoning).toBe(120);
  });

  test('distinct 5m and 1h cache writes are each priced at their own rate', () => {
    const models = {
      'model-observed': {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.00001,
        cache_read_input_token_cost: 0.0000005,
        cache_creation_input_token_cost: 0.000004,
        cache_creation_input_token_cost_above_1hr: 0.000006,
      },
    };
    const split = record({ tokens: { cacheWriteTotal: 1500, cacheWrite5m: 1000, cacheWrite1h: 500 } });
    // 1000 * 4e-6 + 500 * 6e-6 = 0.007 (one rate for both would give 0.006 or 0.009)
    expect(priced(bundleOf([split]), models).normalizedCostUsd).toBeCloseTo(0.007, 12);
  });

  test('an OMP cacheWriteTotal is priced on a single-rate entry and is null on a distinct-TTL entry', () => {
    const bundle = captureFixture('lead-child-aux');
    for (const r of bundle.requests) {
      expect(r.tokens.cacheWriteTotal).not.toBeNull();
      expect(r.tokens.cacheWrite5m).toBeNull();
      expect(r.tokens.cacheWrite1h).toBeNull();
    }
    expect(priced(bundle, SINGLE_RATE).normalizedCostUsd).toBeCloseTo(LEAD_CHILD_AUX_USD, 12);

    const distinctTtl = {
      ...SINGLE_RATE,
      'model-observed': { ...SINGLE_RATE['model-observed'], cache_creation_input_token_cost_above_1hr: 0.000006 },
    };
    const econ = priced(bundle, distinctTtl);
    expect(econ.normalizedCostUsd).toBeNull();
    // Only the aux request (model-small, single rate) stays priced.
    expect(econ.coverage.pricedRequests).toBe(1);
    expect(econ.coverage.unpricedRequests).toBe(3);
  });

  test('a model with no price entry is null, not 0', () => {
    const econ = priced(captureFixture('lead-child-aux'), { 'model-observed': SINGLE_RATE['model-observed'] });
    expect(econ.normalizedCostUsd).toBeNull();
    expect(econ.coverage.unpricedRequests).toBe(1);
    expect(econ.requests).toBe(4);
  });
});

describe('failures, retries and gaps', () => {
  test('a failed request stays in the request count and is priced (retry-failed.jsonl)', () => {
    const econ = priced(captureFixture('retry-failed'), SINGLE_RATE);
    expect(econ.requests).toBe(3);
    expect(econ.failedRequests).toBe(2);
    expect(econ.retries).toBe(1);
    // r02 500*2e-6 = 0.001; r03 500*2e-6 + 40*1e-5 + 200*4e-6 = 0.0022; r05 560*2e-6 + 200*5e-7 = 0.00122
    expect(econ.normalizedCostUsd).toBeCloseTo(0.00442, 12);
  });

  test('a capture gap makes retries, tokens and cost null, never 0', () => {
    const econ = priced(captureFixture('missing-usage'), SINGLE_RATE);
    expect(econ.coverage.nativeSource).toBe('partial');
    expect(econ.retries).toBeNull();
    expect(econ.normalizedCostUsd).toBeNull();
    expect(econ.tokens.input).toBeNull();
    expect(econ.requests).toBe(1);
  });

  test('a pending actor is a capture gap', () => {
    const bundle = bundleOf([record({})]);
    bundle.actors[1].pending = true;
    const econ = priced(bundle, SINGLE_RATE);
    expect(econ.retries).toBeNull();
    expect(econ.coverage.nativeSource).toBe('partial');
  });
});

describe('basis, route and delivery', () => {
  test('a price table whose sha256 differs from the basis is refused by a throw', () => {
    const { table, path } = storedTable(SINGLE_RATE, 'b'.repeat(64));
    const basis = { ...basisFor(table, path), sha256: SHA };
    expect(() => attemptEconomics(captureFixture('lead-child-aux'), 'attempt-1', table, basis)).toThrow(/sha256/);
  });

  test('a subscription route keeps its route and never reports 0', () => {
    const econ = priced(captureFixture('lead-child-aux'), SINGLE_RATE, 'subscription');
    expect(econ.basis.route).toBe('subscription');
    expect(econ.normalizedCostUsd).toBeCloseTo(LEAD_CHILD_AUX_USD, 12);

    const idle = priced(bundleOf([record({})]), SINGLE_RATE, 'subscription');
    expect(idle.basis.route).toBe('subscription');
    expect(idle.normalizedCostUsd).not.toBe(0);
    expect(idle.normalizedCostUsd).toBeNull();
  });

  test('delivery stays not-exported beside a complete native capture', () => {
    const econ = priced(captureFixture('lead-child-aux'), SINGLE_RATE);
    expect(econ.coverage.nativeSource).toBe('complete');
    expect(econ.delivery).toEqual({ status: 'not-exported', expected: 4, storedVerified: null });
  });
});

describe('cohort economics', () => {
  const econ = (usd: number | null): AttemptEconomics => ({
    attemptId: 'a',
    requests: 1,
    failedRequests: 0,
    retries: 0,
    tokens: {
      input: 1,
      cacheRead: 0,
      cacheWriteTotal: 0,
      cacheWrite5m: null,
      cacheWrite1h: null,
      output: 1,
      reasoning: null,
    },
    normalizedCostUsd: usd,
    coverage: {
      nativeSource: 'complete',
      pricedRequests: usd === null ? 0 : 1,
      unpricedRequests: usd === null ? 1 : 0,
    },
    delivery: { status: 'not-exported', expected: 1, storedVerified: null },
    basis: { path: 'p', source: 's', fetchedAt: 'f', sha256: SHA, currency: 'USD', route: 'api' },
  });

  test('divides by every scheduled attempt and by accepted attempts', () => {
    const cohort = cohortEconomics([
      { econ: econ(0.3), disposition: 'accepted' },
      { econ: econ(0.2), disposition: 'rejected' },
      { econ: econ(0.1), disposition: 'timeout' },
      { econ: econ(0.2), disposition: 'accepted' },
    ]);
    expect(cohort.scheduled).toBe(4);
    expect(cohort.accepted).toBe(2);
    expect(cohort.costPerAttemptUsd).toBeCloseTo(0.2, 12);
    expect(cohort.costPerAcceptedUsd).toBeCloseTo(0.4, 12);
    expect(cohort.partial).toBe(false);
  });

  test('zero accepted gives a null cost per accepted attempt', () => {
    const cohort = cohortEconomics([
      { econ: econ(0.3), disposition: 'rejected' },
      { econ: econ(0.1), disposition: 'timeout' },
    ]);
    expect(cohort.accepted).toBe(0);
    expect(cohort.costPerAcceptedUsd).toBeNull();
    expect(cohort.costPerAttemptUsd).toBeCloseTo(0.2, 12);
  });

  test('a null attempt cost makes both ratios null and labels the known spend partial', () => {
    for (const unknown of [econ(null), null]) {
      const cohort = cohortEconomics([
        { econ: econ(0.3), disposition: 'accepted' },
        { econ: unknown, disposition: 'infra-failure' },
      ]);
      expect(cohort.scheduled).toBe(2);
      expect(cohort.costPerAcceptedUsd).toBeNull();
      expect(cohort.costPerAttemptUsd).toBeNull();
      expect(cohort.partial).toBe(true);
    }
  });
});
