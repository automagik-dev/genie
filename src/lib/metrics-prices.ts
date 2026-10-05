/**
 * The optional, self-updatable price table that turns measured tokens into USD
 * where the runtime did not price the call (Claude Code and Codex logs carry
 * tokens but no price; pi/OMP prices its own calls and always wins).
 *
 * Tokens stay the primary currency. Nothing here is on by default: with no
 * table at `<GENIE_HOME>/metrics/prices.json`, `genie metrics export` behaves
 * and prints exactly as it did before the table existed. The export reads the
 * table from disk and never fetches it; only `genie metrics prices update` does, and
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
 *
 * Two LiteLLM refinements are honoured, both generically:
 *   - 1-hour cache writes (Claude Code logs `cache_creation.ephemeral_1h_input_tokens`)
 *     take `cache_creation_input_token_cost_above_1hr`; the rest of the writes the
 *     5-minute `cache_creation_input_token_cost`. No split logged → the flat rate.
 *   - Long-context tiers: when an entry carries any `<rate>_above_<N>k_tokens` and the
 *     call's prompt (input + cacheRead + cacheWrite) exceeds N·1000, every kind the
 *     call used is priced at the highest crossed tier's rate — absent there → null.
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

/** The token counts a price applies to — a `UsageSample` satisfies it. */
export interface PricedTokens {
  input: number;
  cacheRead: number;
  /** Every cache write, whatever its TTL. */
  cacheWrite: number;
  output: number;
  /** The part of `cacheWrite` logged as 1-hour writes; absent when the runtime logs no TTL split. */
  cacheWrite1h?: number;
}

type Rec = Record<string, unknown>;

const obj = (value: unknown): Rec | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : null;
const rate = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
/** A rate the entry itself carries — an inherited property is no rate. */
const ownRate = (entry: Rec, field: string): number | null => (Object.hasOwn(entry, field) ? rate(entry[field]) : null);

export function pricesPath(): string {
  return join(metricsDir(), 'prices.json');
}

/** Entries that carry at least one per-token rate — LiteLLM's `sample_spec` and image/audio-only rows do not count. */
export function countPricedModels(models: Rec): number {
  let n = 0;
  for (const value of Object.values(models)) {
    const entry = obj(value);
    if (entry && (ownRate(entry, 'input_cost_per_token') !== null || ownRate(entry, 'output_cost_per_token') !== null))
      n++;
  }
  return n;
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The stored table, or null when absent, unreadable or malformed — never a guess, never a crash. The header must
 * have the shape `prices update` writes: an ISO `fetchedAt`, a 64-hex lowercase `sha256` (the hash of the
 * downloaded source — provenance only, not re-checked against the stored body) and a model count equal to the
 * priced models in the body. The source is redacted on read, so a table stored by an older genie never shows
 * its credentials.
 */
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
  const { source, fetchedAt, sha256, models: count } = header;
  if (typeof source !== 'string' || typeof fetchedAt !== 'string' || typeof sha256 !== 'string') return null;
  const at = Date.parse(fetchedAt);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== fetchedAt || !SHA256.test(sha256)) return null;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count !== countPricedModels(models))
    return null;
  return { meta: { source: displaySource(source), fetchedAt, sha256, models: count }, models };
}

/** Exact id first, then the part after the last `/` (`openai-codex/gpt-6.1-sol` → `gpt-6.1-sol`); null otherwise. */
export function entryFor(table: PriceTable, model: string | null): Rec | null {
  if (!model) return null;
  if (Object.hasOwn(table.models, model)) return obj(table.models[model]);
  const suffix = model.slice(model.lastIndexOf('/') + 1);
  return suffix !== model && Object.hasOwn(table.models, suffix) ? obj(table.models[suffix]) : null;
}

const TIER = /_above_(\d+)k_tokens$/;

/**
 * `_above_<N>k_tokens` for the highest N the prompt exceeds among the entry's declared tiers; '' for the base
 * rates. A tier is declared by its key whatever its value: an invalid rate at the crossed tier makes the call
 * unknown, never a fallback to the base or a lower tier.
 */
function tierSuffix(entry: Rec, prompt: number): string {
  let best = -1;
  for (const key of Object.keys(entry)) {
    const n = Number(TIER.exec(key)?.[1] ?? -1);
    if (n > best && prompt > n * 1000) best = n;
  }
  return best < 0 ? '' : `_above_${best}k_tokens`;
}

export const hasTokens = (t: PricedTokens): boolean => t.input + t.cacheRead + t.cacheWrite + t.output > 0;

/**
 * USD for one call, or null when any kind it used has no rate, a token count is negative or non-finite, or the
 * cost overflows. A call with no tokens at all costs 0.
 */
export function tableCost(table: PriceTable, model: string | null, tokens: PricedTokens): number | null {
  const counts = [tokens.input, tokens.cacheRead, tokens.cacheWrite, tokens.output, tokens.cacheWrite1h ?? 0];
  if (!counts.every((n) => Number.isFinite(n) && n >= 0)) return null;
  if (!hasTokens(tokens)) return 0;
  const entry = entryFor(table, model);
  if (!entry) return null;
  const tier = tierSuffix(entry, tokens.input + tokens.cacheRead + tokens.cacheWrite);
  const write1h = Math.min(tokens.cacheWrite, tokens.cacheWrite1h ?? 0);
  const parts: Array<[number, string]> = [
    [tokens.input, 'input_cost_per_token'],
    [tokens.cacheRead, 'cache_read_input_token_cost'],
    [tokens.cacheWrite - write1h, 'cache_creation_input_token_cost'],
    [write1h, 'cache_creation_input_token_cost_above_1hr'],
    [tokens.output, 'output_cost_per_token'],
  ];
  let cost = 0;
  for (const [count, field] of parts) {
    if (count === 0) continue;
    const perToken = ownRate(entry, `${field}${tier}`);
    if (perToken === null) return null;
    cost += count * perToken;
  }
  return Number.isFinite(cost) ? cost : null;
}

export type PriceUpdateResult =
  | { ok: true; meta: PriceTableMeta; path: string }
  | { ok: false; code: 1 | 2; message: string };

const refuse = (code: 1 | 2, message: string): PriceUpdateResult => ({ ok: false, code, message });

/** What genie stores, prints and reports for a source: a URL without userinfo, query or fragment. */
export function displaySource(from: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(from)) return from;
  try {
    const url = new URL(from);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return from.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1').replace(/[?#].*$/, '');
  }
}

async function fetchSource(
  from: string,
  shown: string,
  timeoutMs: number,
): Promise<{ bytes: Buffer } | PriceUpdateResult> {
  if (/^https?:\/\//i.test(from)) {
    try {
      const res = await fetch(from, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return refuse(1, `GET ${shown} answered ${res.status}`);
      return { bytes: Buffer.from(await res.arrayBuffer()) };
    } catch (error) {
      // The runtime's message may quote the URL it was handed: never echo the raw one.
      const reason = (error instanceof Error ? error.message : String(error)).split(from).join(shown);
      return refuse(1, `GET ${shown}: ${reason}`);
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(from))
    return refuse(2, `--from takes an http(s) URL or a local file, not ${shown}`);
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
  const shown = displaySource(from);
  const fetched = await fetchSource(from, shown, options.timeoutMs ?? 60_000);
  if ('ok' in fetched) return fetched;
  let models: Rec | null;
  try {
    models = obj(JSON.parse(fetched.bytes.toString('utf8')));
  } catch {
    return refuse(2, `${shown} is not JSON; the stored table is unchanged`);
  }
  if (!models) return refuse(2, `${shown} is not a JSON object of model prices; the stored table is unchanged`);
  const count = countPricedModels(models);
  if (count === 0) return refuse(2, `${shown} names no model with a per-token rate; the stored table is unchanged`);
  const meta: PriceTableMeta = {
    source: shown,
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
