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
 *
 * The optional Phoenix projection lives in `metrics-phoenix.ts`; this module
 * never touches the network.
 */

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import type { CaptureLine, RuntimeSession } from './metrics-capture.js';
import { type OffloadUsage, offloadInWindow, readOffloadRows, repoRootOfDb } from './metrics-offload.js';
import { type UsageSample, readUsageSamples } from './metrics-usage.js';

export interface UsageTotals {
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Sum over calls the runtime priced; null when none was priced. */
  costUsd: number | null;
}

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

function sumUsage(samples: UsageSample[], startAt: number, endAt: number): UsageTotals {
  const inside = samples.filter((sample) => sample.at >= startAt && sample.at < endAt);
  const priced = inside.filter((sample) => sample.costUsd !== null);
  return {
    calls: inside.length,
    input: inside.reduce((sum, s) => sum + s.input, 0),
    cacheRead: inside.reduce((sum, s) => sum + s.cacheRead, 0),
    cacheWrite: inside.reduce((sum, s) => sum + s.cacheWrite, 0),
    output: inside.reduce((sum, s) => sum + s.output, 0),
    costUsd: priced.length > 0 ? priced.reduce((sum, s) => sum + (s.costUsd as number), 0) : null,
  };
}

const sessionKey = (session: RuntimeSession) => `${session.source}:${session.id ?? session.file ?? ''}`;

/** Consecutive matched events of one card → intervals, with the opening session's usage inside each. */
export function buildIntervals(matched: CaptureLine[], env: NodeJS.ProcessEnv = process.env): Interval[] {
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
      const samples = samplesFor(from.session);
      intervals.push({
        db: from.db,
        task: from.task,
        fromEvent: from.event,
        toEvent: to.event,
        transition: `${from.kind}→${to.kind}`,
        startAt: from.at,
        endAt: to.at,
        durationMs: to.at - from.at,
        session: from.session,
        usage: samples ? sumUsage(samples, from.at, to.at) : null,
        sharedSession: false,
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
  /** mikro offload cost summed over the transition's intervals; null when none was priced. */
  offloadUsd: number | null;
}

const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
const allOrNull = (values: Array<number | null>): number | null =>
  values.length > 0 && !values.includes(null) ? (values as number[]).reduce((sum, v) => sum + v, 0) : null;
const totalTokens = (usage: UsageTotals) => usage.input + usage.cacheRead + usage.cacheWrite + usage.output;

export function summarize(intervals: Interval[]): TransitionSummary[] {
  const groups = new Map<string, Interval[]>();
  for (const interval of intervals)
    groups.set(interval.transition, [...(groups.get(interval.transition) ?? []), interval]);
  return [...groups.entries()]
    .map(([transition, group]) => {
      const minutes = group.map((i) => i.durationMs / 60000).sort((a, b) => a - b);
      const known = group.map((i) => i.usage).filter((u): u is UsageTotals => u !== null);
      const priced = known.map((u) => u.costUsd).filter((c): c is number => c !== null);
      return {
        transition,
        n: group.length,
        p50Minutes: quantile(minutes, 0.5),
        p90Minutes: quantile(minutes, 0.9),
        withUsage: known.length,
        meanTokens: known.length > 0 ? Math.round(known.reduce((s, u) => s + totalTokens(u), 0) / known.length) : null,
        costUsd: priced.length > 0 ? priced.reduce((s, c) => s + c, 0) : null,
        // A partial sum is not a total: one interval whose offload bill is unknown makes the transition's unknown.
        offloadUsd: allOrNull(group.map((i) => i.offload?.costUsd ?? null)),
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
  const out = [head, 'transition\tn\tp50min\tp90min\twithUsage\tmeanTokens\tcostUsd\toffloadUsd'];
  for (const r of rows) {
    out.push(
      `${r.transition}\t${r.n}\t${r.p50Minutes.toFixed(1)}\t${r.p90Minutes.toFixed(1)}\t${r.withUsage}/${r.n}\t${r.meanTokens ?? '-'}\t${r.costUsd === null ? '-' : r.costUsd.toFixed(4)}\t${r.offloadUsd === null ? '-' : r.offloadUsd.toFixed(4)}`,
    );
  }
  return `${out.join('\n')}\n`;
}
