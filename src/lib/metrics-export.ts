/**
 * `genie metrics export` — turn the capture ledger into measured lifecycle
 * intervals, off the critical path, with no agent action.
 *
 *   1. Read `<GENIE_HOME>/metrics/events.jsonl` (written only while capture is on).
 *   2. Verify each line against its repo's `task_events` row on the full key
 *      `(db, task, event, kind, at)` — a line whose transaction rolled back, or
 *      whose database is gone, is counted unmatched and never used.
 *   3. Per card, consecutive matched events form intervals (`claim→report`,
 *      `report→move`, …). An interval's usage is every model call the opening
 *      event's runtime session logged inside it (`metrics-usage.ts`); no session
 *      or no log on this host means usage null — unknown, never zero.
 *   4. Optionally, the operator's price table (`metrics-prices.ts`, read from
 *      disk, never fetched here) prices the calls the runtime left unpriced.
 *
 * The optional Phoenix projection lives in `metrics-phoenix.ts`; this module
 * never touches the network.
 */

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import type { CaptureLine, RuntimeSession } from './metrics-capture.js';
import { type OffloadUsage, offloadInWindow, readOffloadRows, repoRootOfDb } from './metrics-offload.js';
import { type PriceTable, hasTokens, tableCost } from './metrics-prices.js';
import { type UsageSample, matchOmpSessionByCwd, readUsageSamples } from './metrics-usage.js';

export interface UsageTotals {
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Sum over calls the runtime (or, with a price table, the table) priced; null when none was priced. */
  costUsd: number | null;
  /**
   * Present only while a price table is loaded, so a host without one exports byte-identically.
   * Who priced `costUsd`: the runtime, the table, both ('mixed'); null when `costUsd` is null.
   */
  costSource?: CostSource | null;
  /** Present only while a price table is loaded: the calls `costUsd` covers, out of `calls`. */
  pricedCalls?: number;
}

export type CostSource = 'runtime' | 'table' | 'mixed';

export interface Interval {
  db: string;
  task: string;
  fromEvent: number;
  toEvent: number;
  transition: string;
  startAt: number;
  endAt: number;
  durationMs: number;
  session: RuntimeSession;
  usage: UsageTotals | null;
  /** Another interval of the same session overlaps this one, so its usage is shared, not exclusive. */
  sharedSession: boolean;
  /** mikro runs this repository logged inside the window (another provider, priced by mikro); null when no ledger. */
  offload: OffloadUsage | null;
  /**
   * How the session was tied to this interval: 'exact' — the runtime exported its id; 'window' — an
   * OMP shell exported none and exactly one OMP session in the same cwd overlapped the interval;
   * 'ambiguous' — several did, so no usage is attributed; null — no runtime session at all.
   */
  sessionMatch: 'exact' | 'window' | 'ambiguous' | null;
}

export interface LedgerRead {
  lines: CaptureLine[];
  corrupt: number;
}

export function readCaptureLedger(path: string, sinceMs = 0): LedgerRead {
  if (!existsSync(path)) return { lines: [], corrupt: 0 };
  const lines: CaptureLine[] = [];
  let corrupt = 0;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const line = JSON.parse(raw) as CaptureLine;
      if (line.v === 1 && line.source === 'task_event' && line.at >= sinceMs) lines.push(line);
    } catch {
      corrupt++;
    }
  }
  return { lines, corrupt };
}

/** Keep the lines whose `(task, event, kind, at)` names a stored row of their db. */
export function verifyAgainstTaskEvents(lines: CaptureLine[]): { matched: CaptureLine[]; unmatched: number } {
  const byDb = new Map<string, CaptureLine[]>();
  for (const line of lines) byDb.set(line.db, [...(byDb.get(line.db) ?? []), line]);
  const matched: CaptureLine[] = [];
  let unmatched = 0;
  for (const [path, group] of byDb) {
    const stored = storedEventKeys(path, group);
    for (const line of group) {
      if (stored.has(eventKey(line.task, line.event, line.kind, line.at))) matched.push(line);
      else unmatched++;
    }
  }
  return { matched, unmatched };
}

const eventKey = (task: string, event: number, kind: string, at: number) =>
  `${task}\u0000${event}\u0000${kind}\u0000${at}`;

function storedEventKeys(path: string, group: CaptureLine[]): Set<string> {
  const keys = new Set<string>();
  if (!existsSync(path)) return keys;
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const query = db.query<{ task_id: string; id: number; kind: string; created_at: number }, [number]>(
      'SELECT task_id, id, kind, created_at FROM task_events WHERE id = ?',
    );
    for (const line of group) {
      const row = query.get(line.event);
      if (row) keys.add(eventKey(row.task_id, row.id, row.kind, row.created_at));
    }
  } catch {
    // an unreadable or foreign database: every line of it stays unmatched
  } finally {
    db?.close();
  }
  return keys;
}

function sumUsage(samples: UsageSample[], startAt: number, endAt: number, prices: PriceTable | null): UsageTotals {
  const inside = samples.filter((sample) => sample.at >= startAt && sample.at < endAt);
  // The runtime's own price always wins; the table only fills calls the runtime left unpriced. A call
  // that used no tokens costs nothing either way, so it is never evidence that the interval was priced.
  const runtime = inside.filter((s) => s.costUsd !== null).map((s) => s.costUsd as number);
  const table = prices
    ? inside
        .filter((s) => s.costUsd === null && hasTokens(s))
        .map((s) => tableCost(prices, s.model, s))
        .filter((c): c is number => c !== null)
    : [];
  const priced = [...runtime, ...table];
  const costUsd = finiteSum(priced);
  const totals: UsageTotals = {
    calls: inside.length,
    input: inside.reduce((sum, s) => sum + s.input, 0),
    cacheRead: inside.reduce((sum, s) => sum + s.cacheRead, 0),
    cacheWrite: inside.reduce((sum, s) => sum + s.cacheWrite, 0),
    output: inside.reduce((sum, s) => sum + s.output, 0),
    costUsd,
  };
  if (!prices) return totals;
  if (costUsd === null) return { ...totals, costSource: null, pricedCalls: 0 };
  const source = combineSources([runtime.length > 0 ? 'runtime' : null, table.length > 0 ? 'table' : null]);
  return { ...totals, costSource: source, pricedCalls: priced.length };
}

/** The sum, or null when there is nothing to sum or it overflows — never Infinity. */
const finiteSum = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sum = values.reduce((total, v) => total + v, 0);
  return Number.isFinite(sum) ? sum : null;
};

/** Who priced a set of costs: one source, or 'mixed' when they differ; null when none priced. */
const combineSources = (sources: Array<CostSource | null | undefined>): CostSource | null => {
  const known = new Set(sources.filter((s): s is CostSource => !!s));
  if (known.size === 0) return null;
  return known.size === 1 ? ([...known][0] as CostSource) : 'mixed';
};

const sessionKey = (session: RuntimeSession) => `${session.source}:${session.id ?? session.file ?? ''}`;

/** The opening event's session, or — for an OMP shell that exported no id — the one OMP session that matches by cwd and window. */
function resolveIntervalSession(
  from: CaptureLine,
  env: NodeJS.ProcessEnv,
): { session: RuntimeSession; match: Interval['sessionMatch'] } {
  const session = from.session;
  if (session.source === null) return { session, match: null };
  if (session.ambiguous) return { session, match: 'ambiguous' };
  if (session.source !== 'pi' || session.id !== null || session.file !== null) return { session, match: 'exact' };
  if (!from.cwd) return { session, match: null };
  const found = matchOmpSessionByCwd(from.cwd, from.at, env);
  if (found === 'ambiguous') return { session, match: 'ambiguous' };
  if (found === null) return { session, match: null };
  return { session: { source: 'pi', id: found.id, file: found.file }, match: 'window' };
}

/**
 * Usage inside the window, or null when unknown. A 'window' match that holds NO call inside the
 * interval is null too: the matched OMP session may have been idle while another runtime did the
 * work, so its 0 would be a guess dressed as a measurement.
 */
function usageFor(
  samples: UsageSample[] | null,
  startAt: number,
  endAt: number,
  match: Interval['sessionMatch'],
  prices: PriceTable | null,
): UsageTotals | null {
  if (!samples) return null;
  const usage = sumUsage(samples, startAt, endAt, prices);
  return match === 'window' && usage.calls === 0 ? null : usage;
}

/**
 * Consecutive matched events of one card → intervals, with the opening session's usage inside each.
 * `prices` (the operator's optional table, read from disk, never fetched) prices calls the runtime left unpriced.
 */
export function buildIntervals(
  matched: CaptureLine[],
  env: NodeJS.ProcessEnv = process.env,
  prices: PriceTable | null = null,
): Interval[] {
  const byCard = new Map<string, CaptureLine[]>();
  for (const line of matched) {
    const key = `${line.db}\u0000${line.task}`;
    byCard.set(key, [...(byCard.get(key) ?? []), line]);
  }
  const samplesBySession = new Map<string, UsageSample[] | null>();
  const samplesFor = (session: RuntimeSession): UsageSample[] | null => {
    if (session.source === null) return null;
    const key = sessionKey(session);
    if (!samplesBySession.has(key)) {
      const samples = readUsageSamples(session, env);
      samplesBySession.set(key, samples.length > 0 ? samples : null);
    }
    return samplesBySession.get(key) ?? null;
  };
  const offloadRows = new Map<string, ReturnType<typeof readOffloadRows>>();
  const rowsFor = (root: string) => {
    if (!offloadRows.has(root)) offloadRows.set(root, readOffloadRows(root));
    return offloadRows.get(root) ?? null;
  };
  const intervals: Interval[] = [];
  for (const events of byCard.values()) {
    events.sort((a, b) => a.at - b.at || a.event - b.event);
    for (let i = 0; i + 1 < events.length; i++) {
      const from = events[i] as CaptureLine;
      const to = events[i + 1] as CaptureLine;
      const { session, match } = resolveIntervalSession(from, env);
      const samples = match === 'ambiguous' ? null : samplesFor(session);
      intervals.push({
        db: from.db,
        task: from.task,
        fromEvent: from.event,
        toEvent: to.event,
        transition: `${from.kind}→${to.kind}`,
        startAt: from.at,
        endAt: to.at,
        durationMs: to.at - from.at,
        session,
        usage: usageFor(samples, from.at, to.at, match, prices),
        sharedSession: false,
        sessionMatch: match,
        offload: null,
      });
    }
  }
  markSharedSessions(intervals);
  // mikro rows carry a repository, not a session: an attempt inside two cards' windows of one repo is ambiguous.
  for (const interval of intervals) {
    const root = repoRootOfDb(interval.db);
    const others = intervals.filter((o) => o.task !== interval.task && repoRootOfDb(o.db) === root);
    interval.offload = offloadInWindow(rowsFor(root), interval.startAt, interval.endAt, others);
  }
  return intervals;
}

function markSharedSessions(intervals: Interval[]): void {
  const bySession = new Map<string, Interval[]>();
  for (const interval of intervals) {
    if (interval.session.source === null) continue;
    const key = sessionKey(interval.session);
    bySession.set(key, [...(bySession.get(key) ?? []), interval]);
  }
  for (const group of bySession.values()) {
    for (const a of group) {
      a.sharedSession = group.some((b) => b !== a && b.task !== a.task && b.startAt < a.endAt && a.startAt < b.endAt);
    }
  }
}

export interface TransitionSummary {
  transition: string;
  n: number;
  p50Minutes: number;
  p90Minutes: number;
  /** Intervals whose usage is known, out of n. */
  withUsage: number;
  meanTokens: number | null;
  costUsd: number | null;
  /** mikro offload cost summed over the transition's intervals; null when any interval's offload is unknown (a partial sum is not a total). */
  offloadUsd: number | null;
  /** Present only while a price table is loaded: model calls inside intervals with known usage. */
  calls?: number;
  /** Present only while a price table is loaded: how many of `calls` `costUsd` covers (a partial sum shows here). */
  pricedCalls?: number;
  /** Present only while a price table is loaded: who priced `costUsd` across the rows' intervals; null when unpriced. */
  costSource?: CostSource | null;
}

const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
const allOrNull = (values: Array<number | null>): number | null =>
  values.length > 0 && !values.includes(null) ? (values as number[]).reduce((sum, v) => sum + v, 0) : null;
const totalTokens = (usage: UsageTotals) => usage.input + usage.cacheRead + usage.cacheWrite + usage.output;

/** `coverage` (set while a price table is loaded) adds `calls`/`pricedCalls`; without it every row keeps its shape. */
export function summarize(intervals: Interval[], coverage = false): TransitionSummary[] {
  const groups = new Map<string, Interval[]>();
  for (const interval of intervals)
    groups.set(interval.transition, [...(groups.get(interval.transition) ?? []), interval]);
  return [...groups.entries()]
    .map(([transition, group]) => {
      const minutes = group.map((i) => i.durationMs / 60000).sort((a, b) => a - b);
      const known = group.map((i) => i.usage).filter((u): u is UsageTotals => u !== null);
      const pricedUsage = known.filter((u) => u.costUsd !== null);
      const costUsd = finiteSum(pricedUsage.map((u) => u.costUsd as number));
      return {
        transition,
        n: group.length,
        p50Minutes: quantile(minutes, 0.5),
        p90Minutes: quantile(minutes, 0.9),
        withUsage: known.length,
        meanTokens: known.length > 0 ? Math.round(known.reduce((s, u) => s + totalTokens(u), 0) / known.length) : null,
        costUsd,
        // A partial sum is not a total: one interval whose offload bill is unknown makes the transition's unknown.
        offloadUsd: allOrNull(group.map((i) => i.offload?.costUsd ?? null)),
        ...(coverage
          ? {
              calls: known.reduce((sum, u) => sum + u.calls, 0),
              pricedCalls: known.reduce((sum, u) => sum + (u.pricedCalls ?? 0), 0),
              costSource: costUsd === null ? null : combineSources(pricedUsage.map((u) => u.costSource)),
            }
          : {}),
      };
    })
    .sort((a, b) => b.n - a.n || a.transition.localeCompare(b.transition));
}

export function formatSummary(
  rows: TransitionSummary[],
  stats: { lines: number; unmatched: number; corrupt: number },
): string {
  const head = `ledger lines ${stats.lines}, unmatched ${stats.unmatched}, corrupt ${stats.corrupt}`;
  if (rows.length === 0) return `${head}\nno intervals yet: a card needs two captured events\n`;
  const coverage = rows.some((r) => r.pricedCalls !== undefined);
  const out = [
    head,
    `transition\tn\tp50min\tp90min\twithUsage\tmeanTokens\tcostUsd\toffloadUsd${coverage ? '\tpriced\tcostSource' : ''}`,
  ];
  for (const r of rows) {
    out.push(
      `${r.transition}\t${r.n}\t${r.p50Minutes.toFixed(1)}\t${r.p90Minutes.toFixed(1)}\t${r.withUsage}/${r.n}\t${r.meanTokens ?? '-'}\t${r.costUsd === null ? '-' : r.costUsd.toFixed(4)}\t${r.offloadUsd === null ? '-' : r.offloadUsd.toFixed(4)}${coverage ? `\t${r.pricedCalls ?? 0}/${r.calls ?? 0}\t${r.costSource ?? '-'}` : ''}`,
    );
  }
  return `${out.join('\n')}\n`;
}
