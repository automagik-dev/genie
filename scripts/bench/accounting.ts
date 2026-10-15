/**
 * Genie Bench — whole-attempt request accounting.
 *
 * Turns one Group 5 capture bundle into the attempt's economics, and a set of attempts into
 * cohort economics. Pure: nothing here reads a file, the environment or the network. The price
 * table arrives as an argument (the caller loads it from the operator's `--prices <file>`), and
 * its `meta.sha256` must equal the basis the caller recorded, or the table is refused.
 *
 * An attempt costs the sum of its individual billable native requests: the lead's, every
 * child's and every auxiliary call's, failed requests included. Unknown is null, never 0: a
 * missing token count, a model with no price entry, a cache write whose TTL split the price
 * entry needs but the log does not carry, or any capture gap makes the dependent figure null.
 *
 * Coverage and delivery are separate: `coverage` says how complete the native capture was,
 * `delivery` says whether the observed records were exported and read back. Nothing exports in
 * this wave, so `delivery` is always `not-exported` and is never derived from coverage.
 */
import { type PriceTable, type PricedTokens, entryFor, tableCost } from '../../src/lib/metrics-prices';
import type { CaptureBundle } from './capture';
import type { Disposition, NativeRequestRecord } from './contracts';

export interface PriceBasis {
  path: string;
  source: string;
  fetchedAt: string;
  sha256: string;
  currency: 'USD';
  route: 'api' | 'subscription' | 'unknown';
}

type TokenKey = 'input' | 'cacheRead' | 'cacheWriteTotal' | 'cacheWrite5m' | 'cacheWrite1h' | 'output' | 'reasoning';

export interface AttemptEconomics {
  attemptId: string;
  requests: number;
  failedRequests: number;
  retries: number | null;
  tokens: Record<TokenKey, number | null>;
  normalizedCostUsd: number | null;
  coverage: { nativeSource: 'complete' | 'partial' | 'unknown'; pricedRequests: number; unpricedRequests: number };
  delivery: {
    status: 'not-exported' | 'complete' | 'partial' | 'unknown';
    expected: number;
    storedVerified: number | null;
  };
  basis: PriceBasis;
}

export interface CohortEconomics {
  scheduled: number;
  accepted: number;
  costPerAttemptUsd: number | null;
  costPerAcceptedUsd: number | null;
  partial: boolean;
}

const TOKEN_KEYS: readonly TokenKey[] = [
  'input',
  'cacheRead',
  'cacheWriteTotal',
  'cacheWrite5m',
  'cacheWrite1h',
  'output',
  'reasoning',
];

/** The LiteLLM rate a 1-hour cache write takes; an entry carrying it (at any tier) prices TTLs apart. */
const ONE_HOUR_WRITE_RATE = 'cache_creation_input_token_cost_above_1hr';

/**
 * Root-rollup exclusion rule: a record whose `presence.rollup` is `observed` restates the usage of
 * other records (a parent's summary of its descendants, read from a native summary surface) and is
 * not itself a billable request. It is excluded from the request count, the token totals and the
 * cost, so an attempt never counts a rollup plus its descendants. Every other record — lead, child,
 * auxiliary, failed or retried — is one billable request and is always counted.
 */
function isRootRollup(record: NativeRequestRecord): boolean {
  return record.presence.rollup === 'observed';
}

/** Whether the capture has a gap: any signal that a request may be missing, cut off or unreadable. */
function nativeSourceOf(bundle: CaptureBundle): AttemptEconomics['coverage']['nativeSource'] {
  if (bundle.linkage.match !== 'isolated-home') return 'unknown';
  const { health } = bundle;
  const gap =
    health.truncated ||
    health.unmatched > 0 ||
    health.missing > 0 ||
    health.malformed > 0 ||
    health.conflicting > 0 ||
    bundle.actors.some((actor) => actor.pending);
  return gap ? 'partial' : 'complete';
}

/**
 * The cache-write counts `tableCost` takes, or null when they are unknown. A 5m/1h split prices
 * each TTL at its own rate. An undivided total is known only when the model's entry has a single
 * cache-write rate; on an entry that prices the 1-hour TTL apart, the undivided total is unpriced.
 */
function cacheWrites(
  record: NativeRequestRecord,
  table: PriceTable,
  model: string | null,
): Pick<PricedTokens, 'cacheWrite' | 'cacheWrite1h'> | null {
  const { cacheWrite5m, cacheWrite1h, cacheWriteTotal } = record.tokens;
  if (cacheWrite5m !== null && cacheWrite1h !== null) {
    // A total that disagrees with its own split is a contradiction, not a price.
    if (cacheWriteTotal !== null && cacheWriteTotal !== cacheWrite5m + cacheWrite1h) return null;
    return { cacheWrite: cacheWrite5m + cacheWrite1h, cacheWrite1h };
  }
  if (cacheWriteTotal === null) return null;
  const entry = entryFor(table, model);
  if (!entry) return null;
  if (Object.keys(entry).some((key) => key.startsWith(ONE_HOUR_WRITE_RATE))) return null;
  return { cacheWrite: cacheWriteTotal };
}

/**
 * The output tokens billed at the output rate. A reasoning subset already inside output is not
 * added again; reasoning reported apart from output is billed as output; a reasoning count whose
 * relation to output is not stated cannot be priced.
 */
function billedOutput(record: NativeRequestRecord): number | null {
  const { output, reasoning } = record.tokens;
  if (output === null) return null;
  if (record.reasoningIncludedInOutput === true) return output;
  if (record.reasoningIncludedInOutput === false) return reasoning === null ? null : output + reasoning;
  return reasoning === null || reasoning === 0 ? output : null;
}

/** One request's USD at the table's rates, or null when any count it needs or any rate is unknown. */
function requestCost(record: NativeRequestRecord, table: PriceTable): number | null {
  // The billed model is the one the response names; the requested model is not a stand-in for it.
  const model = record.observedModel;
  const { input, cacheRead } = record.tokens;
  const output = billedOutput(record);
  const writes = cacheWrites(record, table, model);
  if (input === null || cacheRead === null || output === null || writes === null) return null;
  return tableCost(table, model, { input, cacheRead, output, ...writes });
}

function sumTokens(records: NativeRequestRecord[], key: TokenKey): number | null {
  let total = 0;
  for (const record of records) {
    const value = record.tokens[key];
    if (value === null) return null;
    total += value;
  }
  return total;
}

export function attemptEconomics(
  bundle: CaptureBundle,
  attemptId: string,
  table: PriceTable,
  basis: PriceBasis,
): AttemptEconomics {
  if (table.meta.sha256 !== basis.sha256) {
    throw new Error(
      `price table refused: its meta.sha256 ${table.meta.sha256} differs from the recorded basis ${basis.sha256}`,
    );
  }
  const billable = bundle.requests.filter((record) => !isRootRollup(record));
  const nativeSource = nativeSourceOf(bundle);
  const complete = nativeSource === 'complete';

  let pricedRequests = 0;
  let unpricedRequests = 0;
  let cost = 0;
  for (const record of billable) {
    const usd = requestCost(record, table);
    if (usd === null) unpricedRequests++;
    else {
      pricedRequests++;
      cost += usd;
    }
  }

  const tokens = {} as AttemptEconomics['tokens'];
  for (const key of TOKEN_KEYS) tokens[key] = complete ? sumTokens(billable, key) : null;

  let normalizedCostUsd: number | null = complete && unpricedRequests === 0 && Number.isFinite(cost) ? cost : null;
  // A subscription is not free: a zero API-equivalent figure would read as no spend, so it is unknown instead.
  if (basis.route === 'subscription' && normalizedCostUsd === 0) normalizedCostUsd = null;

  return {
    attemptId,
    requests: billable.length,
    failedRequests: billable.filter((record) => record.failed === true).length,
    // A retry the provider made internally never reaches the log; only a gap-free capture proves the count.
    retries: complete ? billable.filter((record) => record.retryOf !== null).length : null,
    tokens,
    normalizedCostUsd,
    coverage: { nativeSource, pricedRequests, unpricedRequests },
    delivery: { status: 'not-exported', expected: billable.length, storedVerified: null },
    basis,
  };
}

export function cohortEconomics(
  rows: Array<{ econ: AttemptEconomics | null; disposition: Disposition }>,
): CohortEconomics {
  const scheduled = rows.length;
  const accepted = rows.filter((row) => row.disposition === 'accepted').length;
  let known = 0;
  let partial = false;
  for (const row of rows) {
    const usd = row.econ?.normalizedCostUsd ?? null;
    if (usd === null) partial = true;
    else known += usd;
  }
  return {
    scheduled,
    accepted,
    costPerAttemptUsd: scheduled > 0 && !partial ? known / scheduled : null,
    costPerAcceptedUsd: accepted > 0 && !partial ? known / accepted : null,
    partial,
  };
}
