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
  });
});
