import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type PriceTable,
  entryFor,
  loadPriceTable,
  pricesPath,
  tableCost,
  updatePriceTable,
} from './metrics-prices.js';

let root: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genie-metrics-prices-'));
  savedHome = process.env.GENIE_HOME;
  process.env.GENIE_HOME = join(root, 'genie');
});

afterEach(() => {
  if (savedHome === undefined) Reflect.deleteProperty(process.env, 'GENIE_HOME');
  else process.env.GENIE_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

const table: PriceTable = {
  meta: { source: 't', fetchedAt: 't', sha256: 't', models: 3 },
  models: {
    'claude-opus-5-5': {
      input_cost_per_token: 0.00001,
      output_cost_per_token: 0.0001,
      cache_read_input_token_cost: 0.000001,
      cache_creation_input_token_cost: 0.00002,
    },
    'gpt-6.1-sol': { input_cost_per_token: 0.000002, output_cost_per_token: 0.00002 },
    'openai/gpt-6.1-sol': { input_cost_per_token: 0.000003, output_cost_per_token: 0.00003 },
  },
};
const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

describe('lookup and cost', () => {
  test('exact id first, then the part after the last slash; nothing fuzzier', () => {
    expect(entryFor(table, 'openai/gpt-6.1-sol')?.input_cost_per_token).toBe(0.000003);
    expect(entryFor(table, 'openai-codex/gpt-6.1-sol')?.input_cost_per_token).toBe(0.000002);
    expect(entryFor(table, 'gpt-6.1')).toBeNull();
    expect(entryFor(table, 'claude-opus-5-5-20261001')).toBeNull();
    expect(entryFor(table, null)).toBeNull();
    // Inherited object keys are not models.
    expect(entryFor(table, 'constructor')).toBeNull();
  });

  test('cost sums every kind; a kind used without a rate is unknown, never 0', () => {
    expect(tableCost(table, 'claude-opus-5-5', tokens(100, 10, 1000, 50))).toBeCloseTo(0.004, 12);
    // gpt-6.1-sol carries no cache rates: uncached usage prices, any cached token does not.
    expect(tableCost(table, 'gpt-6.1-sol', tokens(1000, 100))).toBeCloseTo(0.004, 12);
    expect(tableCost(table, 'gpt-6.1-sol', tokens(1000, 100, 1))).toBeNull();
    expect(tableCost(table, 'gpt-6.1-sol', tokens(1000, 100, 0, 1))).toBeNull();
    expect(tableCost(table, 'unknown-model', tokens(1, 1))).toBeNull();
    // A call that used no tokens costs 0 whatever its model.
    expect(tableCost(table, null, tokens(0, 0))).toBe(0);
  });
});

describe('cache TTL and long-context tiers', () => {
  const tiered: PriceTable = {
    meta: { source: 't', fetchedAt: 't', sha256: 't', models: 3 },
    models: {
      'claude-ttl': {
        input_cost_per_token: 0.00001,
        output_cost_per_token: 0.0001,
        cache_read_input_token_cost: 0.000001,
        cache_creation_input_token_cost: 0.00002,
        cache_creation_input_token_cost_above_1hr: 0.00004,
      },
      'claude-no-1h': {
        input_cost_per_token: 0.00001,
        output_cost_per_token: 0.0001,
        cache_creation_input_token_cost: 0.00002,
      },
      'long-ctx': {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.00001,
        cache_read_input_token_cost: 0.0000001,
        input_cost_per_token_above_200k_tokens: 0.000002,
        output_cost_per_token_above_200k_tokens: 0.00002,
        input_cost_per_token_above_1000k_tokens: 0.000004,
        output_cost_per_token_above_1000k_tokens: 0.00004,
      },
    },
  };

  test('1-hour cache writes are priced at the _above_1hr rate; the rest at the 5-minute rate', () => {
    const cost = tableCost(tiered, 'claude-ttl', { ...tokens(0, 0, 0, 100), cacheWrite1h: 60 });
    expect(cost).toBeCloseTo(40 * 0.00002 + 60 * 0.00004, 12);
    // No TTL split logged: every write at the flat rate, as before.
    expect(tableCost(tiered, 'claude-ttl', tokens(0, 0, 0, 100))).toBeCloseTo(100 * 0.00002, 12);
    // 1h tokens but no 1h rate: unknown, never the 5-minute price.
    expect(tableCost(tiered, 'claude-no-1h', { ...tokens(0, 0, 0, 100), cacheWrite1h: 1 })).toBeNull();
    expect(tableCost(tiered, 'claude-no-1h', { ...tokens(0, 0, 0, 100), cacheWrite1h: 0 })).toBeCloseTo(0.002, 12);
  });

  test('a prompt above an _above_<N>k_tokens threshold is priced at the highest tier it crosses', () => {
    // 150k prompt: base rates.
    expect(tableCost(tiered, 'long-ctx', tokens(150_000, 10))).toBeCloseTo(150_000 * 0.000001 + 10 * 0.00001, 12);
    // Exactly 200k is not above it.
    expect(tableCost(tiered, 'long-ctx', tokens(200_000, 10))).toBeCloseTo(200_000 * 0.000001 + 10 * 0.00001, 12);
    // 250k prompt (input + cacheRead + cacheWrite): every kind at its 200k tier.
    expect(tableCost(tiered, 'long-ctx', tokens(250_000, 10))).toBeCloseTo(250_000 * 0.000002 + 10 * 0.00002, 12);
    expect(tableCost(tiered, 'long-ctx', tokens(1_200_000, 10))).toBeCloseTo(1_200_000 * 0.000004 + 10 * 0.00004, 12);
    // The tier lacks a cache-read rate although the base has one: unknown, never the base price.
    expect(tableCost(tiered, 'long-ctx', tokens(100_000, 10, 150_000))).toBeNull();
  });
});

// A faithful fixture of the 33f286d / v6.261005.4 writer: `${JSON.stringify({ genie: meta, models })}\n`, where
// `sha256` is the hash of the DOWNLOADED bytes (often pretty-printed), not of the re-serialized body stored here.
const downloaded = '{\n  "m": { "input_cost_per_token": 0.001 }\n}\n';
function writeEnvelope(
  path: string,
  body: string,
  header: Partial<{ source: unknown; fetchedAt: unknown; sha256: unknown; models: unknown }> = {},
): void {
  const meta = {
    source: 'https://example.invalid/p.json',
    fetchedAt: '2026-10-05T00:00:00.000Z',
    sha256: createHash('sha256').update(downloaded).digest('hex'),
    models: 1,
    ...header,
  };
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ genie: meta, models: JSON.parse(body) })}\n`);
}

describe('R3: the stored envelope must have the shape genie writes (item 4)', () => {
  const body = JSON.stringify({ m: { input_cost_per_token: 0.001 } });

  test('a well-formed envelope loads (control)', () => {
    writeEnvelope(pricesPath(), body);
    expect(loadPriceTable()?.meta.models).toBe(1);
  });

  test('fetchedAt must be the ISO timestamp genie writes', () => {
    for (const fetchedAt of ['not-a-date', '2026-10-05', 'Mon, 05 Oct 2026 00:00:00 GMT']) {
      writeEnvelope(pricesPath(), body, { fetchedAt });
      expect(loadPriceTable()).toBeNull();
    }
  });

  test('sha256 must be 64 lowercase hex', () => {
    const upper = createHash('sha256').update(body).digest('hex').toUpperCase();
    for (const sha256 of ['x', upper]) {
      writeEnvelope(pricesPath(), body, { sha256 });
      expect(loadPriceTable()).toBeNull();
    }
  });

  test('the model count must equal the priced models in the body', () => {
    writeEnvelope(pricesPath(), body, { models: 0 });
    expect(loadPriceTable()).toBeNull();
    writeEnvelope(pricesPath(), body, { models: 2 });
    expect(loadPriceTable()).toBeNull();
  });
});

describe('R3: a table written by the 33f286d / v6.261005.4 updater keeps loading', () => {
  test('the faithful fixture loads as PRESENT and prices calls; sha256 is provenance, not a body check', () => {
    writeEnvelope(pricesPath(), JSON.stringify({ m: { input_cost_per_token: 0.001 } }));
    const loaded = loadPriceTable();
    expect(loaded?.meta).toMatchObject({ models: 1, sha256: createHash('sha256').update(downloaded).digest('hex') });
    expect(tableCost(loaded as PriceTable, 'm', tokens(10, 0))).toBeCloseTo(0.01, 12);
  });

  test('the updater itself, fed a pretty-printed source, writes a table that loads and prices', async () => {
    const from = join(root, 'pretty.json');
    writeFileSync(from, downloaded);
    expect((await updatePriceTable(from)).ok).toBe(true);
    const loaded = loadPriceTable();
    expect(loaded?.meta.sha256).toBe(createHash('sha256').update(downloaded).digest('hex'));
    expect(tableCost(loaded as PriceTable, 'm', tokens(10, 0))).toBeCloseTo(0.01, 12);
  });
});

describe('R3: an already-stored source is redacted on read (item 5)', () => {
  test('userinfo, query and fragment never leave loadPriceTable', () => {
    const body = JSON.stringify({ m: { input_cost_per_token: 0.001 } });
    writeEnvelope(pricesPath(), body, { source: 'https://user:hunter2@example.invalid/p.json?token=abc123#frag' });
    expect(loadPriceTable()?.meta.source).toBe('https://example.invalid/p.json');
  });
});

describe('prices update', () => {
  const litellm = {
    sample_spec: { max_tokens: 'set to max tokens' },
    'claude-opus-5-5': { input_cost_per_token: 0.00001, output_cost_per_token: 0.0001 },
    'gpt-6.1-sol': { input_cost_per_token: 0.000002 },
  };

  test('a local file is copied atomically with its source, time, sha256 and priced-model count', async () => {
    expect(loadPriceTable()).toBeNull();
    const from = join(root, 'prices.json');
    const body = JSON.stringify(litellm);
    writeFileSync(from, body);
    const result = await updatePriceTable(from, { now: new Date('2026-10-05T00:00:00Z') });
    expect(result).toMatchObject({ ok: true, path: pricesPath() });
    const stored = loadPriceTable();
    expect(stored?.meta).toEqual({
      source: from,
      fetchedAt: '2026-10-05T00:00:00.000Z',
      sha256: createHash('sha256').update(body).digest('hex'),
      models: 2,
    });
    expect(stored?.models).toEqual(litellm);
    expect(statSync(pricesPath()).mode & 0o777).toBe(0o600);
    // No temp file is left beside the table.
    expect(readdirSync(join(root, 'genie', 'metrics'))).toEqual(['prices.json']);
  });

  test('non-JSON, a non-object, a table with no rate, a missing file or a foreign scheme → exit 2, old table untouched', async () => {
    const good = join(root, 'good.json');
    writeFileSync(good, JSON.stringify(litellm));
    expect((await updatePriceTable(good)).ok).toBe(true);
    const before = readFileSync(pricesPath());

    const cases: Array<[string, string | null]> = [
      ['not-json.json', '<html>rate limited</html>'],
      ['array.json', '[1, 2]'],
      ['no-rates.json', JSON.stringify({ sample_spec: {} })],
      ['absent.json', null],
    ];
    for (const [name, content] of cases) {
      const from = join(root, name);
      if (content !== null) writeFileSync(from, content);
      const result = await updatePriceTable(from);
      expect(result).toMatchObject({ ok: false, code: 2 });
    }
    expect(await updatePriceTable('ftp://example.invalid/p.json')).toMatchObject({ ok: false, code: 2 });
    expect(readFileSync(pricesPath()).equals(before)).toBe(true);
    expect(readdirSync(join(root, 'genie', 'metrics'))).toEqual(['prices.json']);
  });

  test('a URL is stored, shown and reported without its userinfo, query or fragment', async () => {
    // A loopback server: no real network is touched.
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json(litellm) });
    try {
      const base = `http://127.0.0.1:${server.port}/p.json`;
      const secret = `http://user:hunter2@127.0.0.1:${server.port}/p.json?sig=abc123#frag`;
      const result = await updatePriceTable(secret);
      expect(result).toMatchObject({ ok: true, meta: { source: base } });
      expect(readFileSync(pricesPath(), 'utf8')).not.toMatch(/hunter2|abc123|frag/);
    } finally {
      server.stop(true);
    }
    const failed = await updatePriceTable('http://user:hunter2@127.0.0.1:9/p.json?sig=abc123#frag', {
      timeoutMs: 5000,
    });
    expect(failed.ok).toBe(false);
    expect(failed.ok ? '' : failed.message).not.toMatch(/hunter2|abc123|frag/);
    expect(failed.ok ? '' : failed.message).toContain('http://127.0.0.1:9/p.json');
  });

  test('an unreachable URL is a network failure: exit 1, nothing written', async () => {
    // A closed loopback port refuses at once — no real network is touched.
    const result = await updatePriceTable('http://127.0.0.1:9/prices.json', { timeoutMs: 5000 });
    expect(result).toMatchObject({ ok: false, code: 1 });
    expect(loadPriceTable()).toBeNull();
  });

  test('a stored file that is not a genie price table reads as no table', () => {
    const path = pricesPath();
    rmSync(join(root, 'genie'), { recursive: true, force: true });
    mkdirSync(join(root, 'genie', 'metrics'), { recursive: true });
    writeFileSync(path, JSON.stringify({ 'claude-opus-5-5': {} }));
    expect(loadPriceTable()).toBeNull();
    writeFileSync(path, '{torn');
    expect(loadPriceTable()).toBeNull();
    // A hand-edited header whose fields are not plain values is no table — never a crash.
    const models = { m: { input_cost_per_token: 1 } };
    for (const genie of [
      { source: { toString: null }, fetchedAt: 'x', sha256: 'x', models: 1 },
      { source: 'x', fetchedAt: 7, sha256: 'x', models: 1 },
      { source: 'x', fetchedAt: 'x', sha256: 'x', models: '1' },
    ]) {
      writeFileSync(path, JSON.stringify({ genie, models }));
      expect(loadPriceTable()).toBeNull();
    }
  });
});

describe('R3: a crossed tier with an invalid rate is unknown, never the base (item 2)', () => {
  const tier = (extra: Record<string, unknown>): PriceTable => ({
    meta: { source: 't', fetchedAt: 't', sha256: 't', models: 1 },
    models: { m: { input_cost_per_token: 0.000001, output_cost_per_token: 0.00001, ...extra } },
  });

  test('a negative rate at the only crossed tier', () => {
    expect(tableCost(tier({ input_cost_per_token_above_200k_tokens: -1 }), 'm', tokens(250_000, 0))).toBeNull();
  });

  test('a null, string or non-finite-looking rate at the only crossed tier', () => {
    for (const bad of [null, '0.000002', {}]) {
      expect(tableCost(tier({ input_cost_per_token_above_200k_tokens: bad }), 'm', tokens(250_000, 0))).toBeNull();
    }
  });

  test('an invalid higher crossed tier never falls back to a valid lower one', () => {
    const table = tier({
      input_cost_per_token_above_200k_tokens: 0.000002,
      input_cost_per_token_above_1000k_tokens: -1,
    });
    expect(tableCost(table, 'm', tokens(1_200_000, 0))).toBeNull();
    // Below the invalid tier the valid lower one still prices.
    expect(tableCost(table, 'm', tokens(250_000, 0))).toBeCloseTo(250_000 * 0.000002, 12);
  });
});

describe('numeric safety', () => {
  const entry = (rates: Record<string, unknown>): PriceTable => ({
    meta: { source: 't', fetchedAt: 't', sha256: 't', models: 1 },
    models: { m: rates },
  });
  const base = { input_cost_per_token: 0.001, output_cost_per_token: 0.002 };

  test('a negative or non-finite token count prices nothing', () => {
    expect(tableCost(entry(base), 'm', tokens(-10, 5))).toBeNull();
    expect(tableCost(entry(base), 'm', tokens(10, Number.NaN))).toBeNull();
    expect(tableCost(entry(base), 'm', tokens(Number.POSITIVE_INFINITY, 0))).toBeNull();
  });

  test('a negative rate is absent, and a cost that overflows is null, never Infinity', () => {
    expect(tableCost(entry({ ...base, input_cost_per_token: -1 }), 'm', tokens(10, 0))).toBeNull();
    expect(tableCost(entry({ ...base, input_cost_per_token: 1e308 }), 'm', tokens(10, 0))).toBeNull();
  });

  test('rates are read from the entry’s own fields only, never inherited ones', () => {
    const inherited = Object.create({ input_cost_per_token: 0.001, output_cost_per_token: 0.002 });
    expect(tableCost(entry(inherited), 'm', tokens(10, 1))).toBeNull();
  });
});
