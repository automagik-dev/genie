import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type PriceTable,
  loadPriceTable,
  pricesPath,
  ratesFor,
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
    expect(ratesFor(table, 'openai/gpt-6.1-sol')?.input).toBe(0.000003);
    expect(ratesFor(table, 'openai-codex/gpt-6.1-sol')?.input).toBe(0.000002);
    expect(ratesFor(table, 'gpt-6.1')).toBeNull();
    expect(ratesFor(table, 'claude-opus-5-5-20261001')).toBeNull();
    expect(ratesFor(table, null)).toBeNull();
    // Inherited object keys are not models.
    expect(ratesFor(table, 'constructor')).toBeNull();
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
