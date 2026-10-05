/**
 * The optional, self-updatable price table that turns measured tokens into USD
 * where the runtime did not price the call (Claude Code and Codex logs carry
 * tokens but no price; pi/OMP prices its own calls and always wins).
 *
 * Tokens stay the primary currency. Nothing here is on by default: with no
 * table at `<GENIE_HOME>/metrics/prices.json`, `genie metrics export` behaves
 * and prints exactly as it did before the table existed. The export reads the
 * table OFFLINE; only `genie metrics prices update` touches the network, and
 * only when the operator runs it.
 *
 * The table is LiteLLM's `model_prices_and_context_window.json`, stored
 * verbatim under `models` beside a small `genie` header (source, fetchedAt,
 * sha256 of the fetched bytes, model count) in ONE file, so a single rename
 * replaces table and metadata together.
 *
 * Lookup is exact model id, then the part after the last `/` — nothing fuzzier.
 * A rate the table does not carry is unknown, never 0: a sample with nonzero
 * tokens of a kind whose rate is absent is unpriced (null). That includes the
 * cache kinds — some providers bill cached tokens as plain input and LiteLLM
 * then omits the cache field, but genie does not guess which; null on doubt.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { metricsDir } from './metrics-capture.js';

export const DEFAULT_PRICE_SOURCE =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export interface PriceTableMeta {
  source: string;
  fetchedAt: string;
  sha256: string;
  models: number;
}

export interface PriceTable {
  meta: PriceTableMeta;
  models: Record<string, unknown>;
}

export interface ModelRates {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

/** The token counts a price applies to — a `UsageSample` satisfies it. */
export interface PricedTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

type Rec = Record<string, unknown>;

const obj = (value: unknown): Rec | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : null;
const rate = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function pricesPath(): string {
  return join(metricsDir(), 'prices.json');
}

/** Entries that carry at least one per-token rate — LiteLLM's `sample_spec` and image/audio-only rows do not count. */
export function countPricedModels(models: Rec): number {
  let n = 0;
  for (const value of Object.values(models)) {
    const entry = obj(value);
    if (entry && (rate(entry.input_cost_per_token) !== null || rate(entry.output_cost_per_token) !== null)) n++;
  }
  return n;
}

/** The stored table, or null when absent or unreadable — an unreadable table is no table, never a guess. */
export function loadPriceTable(path = pricesPath()): PriceTable | null {
  let parsed: Rec | null;
  try {
    parsed = obj(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
  const header = obj(parsed?.genie);
  const models = obj(parsed?.models);
  if (!header || !models) return null;
  return {
    meta: {
      source: String(header.source ?? ''),
      fetchedAt: String(header.fetchedAt ?? ''),
      sha256: String(header.sha256 ?? ''),
      models: typeof header.models === 'number' ? header.models : countPricedModels(models),
    },
    models,
  };
}

/** Exact id first, then the part after the last `/` (`openai-codex/gpt-6.1-sol` → `gpt-6.1-sol`); null otherwise. */
export function ratesFor(table: PriceTable, model: string | null): ModelRates | null {
  if (!model) return null;
  const slash = model.lastIndexOf('/');
  const entry =
    obj(Object.hasOwn(table.models, model) ? table.models[model] : null) ??
    (slash >= 0 && Object.hasOwn(table.models, model.slice(slash + 1))
      ? obj(table.models[model.slice(slash + 1)])
      : null);
  if (!entry) return null;
  return {
    input: rate(entry.input_cost_per_token),
    output: rate(entry.output_cost_per_token),
    cacheRead: rate(entry.cache_read_input_token_cost),
    cacheWrite: rate(entry.cache_creation_input_token_cost),
  };
}

/** USD for one call, or null when any kind it used has no rate. A call with no tokens at all costs 0. */
export function tableCost(table: PriceTable, model: string | null, tokens: PricedTokens): number | null {
  const kinds: Array<[number, keyof ModelRates]> = [
    [tokens.input, 'input'],
    [tokens.cacheRead, 'cacheRead'],
    [tokens.cacheWrite, 'cacheWrite'],
    [tokens.output, 'output'],
  ];
  if (kinds.every(([count]) => count === 0)) return 0;
  const rates = ratesFor(table, model);
  if (!rates) return null;
  let cost = 0;
  for (const [count, kind] of kinds) {
    if (count === 0) continue;
    const perToken = rates[kind];
    if (perToken === null) return null;
    cost += count * perToken;
  }
  return cost;
}

export type PriceUpdateResult =
  | { ok: true; meta: PriceTableMeta; path: string }
  | { ok: false; code: 1 | 2; message: string };

const refuse = (code: 1 | 2, message: string): PriceUpdateResult => ({ ok: false, code, message });

async function fetchSource(from: string, timeoutMs: number): Promise<{ bytes: Buffer } | PriceUpdateResult> {
  if (/^https?:\/\//i.test(from)) {
    try {
      const res = await fetch(from, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return refuse(1, `GET ${from} answered ${res.status}`);
      return { bytes: Buffer.from(await res.arrayBuffer()) };
    } catch (error) {
      return refuse(1, `GET ${from}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(from))
    return refuse(2, `--from takes an http(s) URL or a local file, not ${from}`);
  try {
    return { bytes: readFileSync(from) };
  } catch (error) {
    return refuse(2, `cannot read ${from}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Fetch (or copy) a LiteLLM-shaped table and replace the stored one atomically: temp file in the same
 * directory, then rename. Any refusal or failure leaves the previous table byte-identical.
 */
export async function updatePriceTable(
  from: string = DEFAULT_PRICE_SOURCE,
  options: { timeoutMs?: number; now?: Date } = {},
): Promise<PriceUpdateResult> {
  const fetched = await fetchSource(from, options.timeoutMs ?? 60_000);
  if ('ok' in fetched) return fetched;
  let models: Rec | null;
  try {
    models = obj(JSON.parse(fetched.bytes.toString('utf8')));
  } catch {
    return refuse(2, `${from} is not JSON; the stored table is unchanged`);
  }
  if (!models) return refuse(2, `${from} is not a JSON object of model prices; the stored table is unchanged`);
  const count = countPricedModels(models);
  if (count === 0) return refuse(2, `${from} names no model with a per-token rate; the stored table is unchanged`);
  const meta: PriceTableMeta = {
    source: from,
    fetchedAt: (options.now ?? new Date()).toISOString(),
    sha256: createHash('sha256').update(fetched.bytes).digest('hex'),
    models: count,
  };
  const path = pricesPath();
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(metricsDir(), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${JSON.stringify({ genie: meta, models })}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    return refuse(1, `cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true, meta, path };
}
