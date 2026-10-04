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
import { type UsageSample, matchPiSessionByCwd, readUsageSamples } from './metrics-usage.js';

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

/** The opening event's session, or — for an OMP shell that exported no id — the one OMP session that matches by cwd and window. */
function resolveIntervalSession(
  from: CaptureLine,
  to: CaptureLine,
  env: NodeJS.ProcessEnv,
): { session: RuntimeSession; match: Interval['sessionMatch'] } {
  const session = from.session;
  if (session.source === null) return { session, match: null };
  if (session.ambiguous) return { session, match: 'ambiguous' };
  if (session.source !== 'pi' || session.id !== null || session.file !== null) return { session, match: 'exact' };
  if (!from.cwd) return { session, match: null };
  const found = matchPiSessionByCwd(from.cwd, from.at, to.at, env);
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
): UsageTotals | null {
  if (!samples) return null;
  const usage = sumUsage(samples, startAt, endAt);
  return match === 'window' && usage.calls === 0 ? null : usage;
}

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
  const intervals: Interval[] = [];
  for (const events of byCard.values()) {
    events.sort((a, b) => a.at - b.at || a.event - b.event);
    for (let i = 0; i + 1 < events.length; i++) {
      const from = events[i] as CaptureLine;
      const to = events[i + 1] as CaptureLine;
      const { session, match } = resolveIntervalSession(from, to, env);
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
        usage: usageFor(samples, from.at, to.at, match),
        sharedSession: false,
        sessionMatch: match,
      });
    }
  }
  markSharedSessions(intervals);
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
}

const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
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
  const out = [head, 'transition\tn\tp50min\tp90min\twithUsage\tmeanTokens\tcostUsd'];
  for (const r of rows) {
    out.push(
      `${r.transition}\t${r.n}\t${r.p50Minutes.toFixed(1)}\t${r.p90Minutes.toFixed(1)}\t${r.withUsage}/${r.n}\t${r.meanTokens ?? '-'}\t${r.costUsd === null ? '-' : r.costUsd.toFixed(4)}`,
    );
  }
  return `${out.join('\n')}\n`;
}
