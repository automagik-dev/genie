/**
 * `genie metrics export` — turn the capture ledger into measured lifecycle
 * intervals, off the critical path, with no agent action.
 *
 *   1. Read `<GENIE_HOME>/metrics/events.jsonl` (written only while capture is on).
 *   2. Verify each line against its repo's `task_events` row on the full key
 *      `(db, task, event, kind, at)` — a line whose transaction rolled back, or
 *      whose database is gone, is counted unmatched and never used.
 *   3. Per card, consecutive matched events form intervals (`claim→report`,
 *      `report→move`, …) with their wall-clock time and the mikro offload cost
 *      inside them (`metrics-offload.ts`).
 *   4. Per repository the verified ledger names, task tokens and USD come from the
 *      Rust meter: one `genie-rs usage` call (`usagemeter query --by task`, with
 *      the repository's previous names as `--repo-alias`, owned by
 *      `genie_tasks::meter`). A meter that cannot answer is unknown, never 0.
 *
 * Per-transition tokens are not reported (meter wish D5): the meter serves task
 * totals, not slices of one session's log, until its `--since/--until` query is
 * adopted. Genie no longer reads any runtime session log here. Historical usage
 * the meter has not seen is imported by the meter itself:
 * `usagemeter sync --backfill [--days <N>] [--budget-secs <S>]` and
 * `usagemeter sync --evidence-backfill --days <N>`; genie adds no wrapper.
 *
 * The optional Phoenix projection lives in `metrics-phoenix.ts`; this module
 * never touches the network.
 */

import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { type CaptureLine, type RuntimeSession, isCanonicalRepoDb } from './metrics-capture.js';
import { type OffloadUsage, offloadInWindow, readOffloadRows, repoRootOfDb } from './metrics-offload.js';

export interface Interval {
  db: string;
  task: string;
  fromEvent: number;
  toEvent: number;
  transition: string;
  startAt: number;
  endAt: number;
  durationMs: number;
  /** The runtime session the opening event was written in, as captured. */
  session: RuntimeSession;
  /** mikro runs this repository logged inside the window (another provider, priced by mikro); null when no ledger. */
  offload: OffloadUsage | null;
}

export interface LedgerRead {
  /** In-window lines of a per-repo database — the only ones the export uses. */
  lines: CaptureLine[];
  corrupt: number;
  /** In-window lines whose `db` is not `<root>/.genie/genie.db` (a test or scratch database): read past, never used. */
  ignored: number;
}

export function readCaptureLedger(path: string, sinceMs = 0): LedgerRead {
  if (!existsSync(path)) return { lines: [], corrupt: 0, ignored: 0 };
  const lines: CaptureLine[] = [];
  let corrupt = 0;
  let ignored = 0;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const line = JSON.parse(raw) as CaptureLine;
      if (line.v !== 1 || line.source !== 'task_event' || !(line.at >= sinceMs)) continue;
      // Written before capture refused these: a test or scratch database is no card lifecycle. Read past, never pruned.
      if (typeof line.db === 'string' && isCanonicalRepoDb(line.db)) lines.push(line);
      else ignored++;
    } catch {
      corrupt++;
    }
  }
  return { lines, corrupt, ignored };
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

/** Consecutive matched events of one card → intervals, with the mikro offload cost inside each. */
export function buildIntervals(matched: CaptureLine[]): Interval[] {
  const byCard = new Map<string, CaptureLine[]>();
  for (const line of matched) {
    const key = `${line.db}\u0000${line.task}`;
    byCard.set(key, [...(byCard.get(key) ?? []), line]);
  }
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
        offload: null,
      });
    }
  }
  // mikro rows carry a repository, not a session: an attempt inside two cards' windows of one repo is ambiguous.
  for (const interval of intervals) {
    const root = repoRootOfDb(interval.db);
    const others = intervals.filter((o) => o.task !== interval.task && repoRootOfDb(o.db) === root);
    interval.offload = offloadInWindow(rowsFor(root), interval.startAt, interval.endAt, others);
  }
  return intervals;
}

export interface TransitionSummary {
  transition: string;
  n: number;
  p50Minutes: number;
  p90Minutes: number;
  /** mikro offload cost summed over the transition's intervals; null when any interval's offload is unknown (a partial sum is not a total). */
  offloadUsd: number | null;
}

const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
const allOrNull = (values: Array<number | null>): number | null =>
  values.length > 0 && !values.includes(null) ? (values as number[]).reduce((sum, v) => sum + v, 0) : null;

export function summarize(intervals: Interval[]): TransitionSummary[] {
  const groups = new Map<string, Interval[]>();
  for (const interval of intervals)
    groups.set(interval.transition, [...(groups.get(interval.transition) ?? []), interval]);
  return [...groups.entries()]
    .map(([transition, group]) => {
      const minutes = group.map((i) => i.durationMs / 60000).sort((a, b) => a - b);
      return {
        transition,
        n: group.length,
        p50Minutes: quantile(minutes, 0.5),
        p90Minutes: quantile(minutes, 0.9),
        // A partial sum is not a total: one interval whose offload bill is unknown makes the transition's unknown.
        offloadUsd: allOrNull(group.map((i) => i.offload?.costUsd ?? null)),
      };
    })
    .sort((a, b) => b.n - a.n || a.transition.localeCompare(b.transition));
}

export function formatSummary(
  rows: TransitionSummary[],
  stats: { lines: number; unmatched: number; corrupt: number; ignored?: number },
): string {
  // `ignored` appears only when it is not zero, so a ledger with nothing to ignore prints what it always did.
  const head = `ledger lines ${stats.lines}, unmatched ${stats.unmatched}, corrupt ${stats.corrupt}${stats.ignored ? `, ignored ${stats.ignored}` : ''}`;
  if (rows.length === 0) return `${head}\nno intervals yet: a card needs two captured events\n`;
  const out = [head, 'transition\tn\tp50min\tp90min\toffloadUsd'];
  for (const r of rows) {
    out.push(
      `${r.transition}\t${r.n}\t${r.p50Minutes.toFixed(1)}\t${r.p90Minutes.toFixed(1)}\t${r.offloadUsd === null ? '-' : r.offloadUsd.toFixed(4)}`,
    );
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Task usage from the Rust meter (D5, D6)
// ---------------------------------------------------------------------------------------------------------------

/** The `usagemeter query --window` values export accepts; `d90` needs `usagemeter >= 3.129.5`. */
export const METER_WINDOWS = ['d1', 'd7', 'd30', 'd90'] as const;
export type MeterWindow = (typeof METER_WINDOWS)[number];

/** Contract 1 `$defs.taskRow`, as `genie-rs usage` passes it on (`usd` already null whenever it is unknown). */
export interface MeterTaskRow {
  task: string;
  state: 'measured' | 'stale' | 'missing';
  reason: string | null;
  tokens: {
    input: number;
    cache_read: number;
    cache_write_5m: number;
    cache_write_1h: number;
    output: number;
    reasoning: number | null;
    unsplit: number;
    total: number;
  } | null;
  cost: {
    state: 'priced' | 'partial' | 'unpriced' | 'zero';
    usd: number | null;
    unpriced_models: string[];
  } | null;
}

/**
 * One repository's task usage: `genie-rs usage --json` as it printed it, plus the checkout it was asked
 * about. `meter_state: 'missing'` (with `meter_reason`) means the meter could not answer: `rows` is then
 * null — unknown, never an empty list and never 0.
 */
export interface RepoTaskUsage {
  project: string;
  repo: string | null;
  repo_aliases: string[];
  window: MeterWindow;
  meter_state: 'measured' | 'missing';
  meter_reason: string | null;
  /** `meter_version`, `window`, `ingestion`, `sources`, `unattributed`, `actor_unattributed` and `pricing`, as the meter wrote them. */
  meter: Record<string, unknown> | null;
  rows: MeterTaskRow[] | null;
}

/** Where the `genie-rs` binary is (`resolveGenieRsBin` in the task commands), or why there is none. */
export type GenieRsBin = { path: string } | { missing: string };

const GENIE_RS_TIMEOUT_MS = 15_000;
const GENIE_RS_MAX_BYTES = 2 * 1024 * 1024;

/** The repository roots the verified ledger names, each once, in first-seen order. */
export function ledgerRepos(matched: CaptureLine[]): string[] {
  return [...new Set(matched.map((line) => repoRootOfDb(line.db)))];
}

function missingUsage(project: string, window: MeterWindow, reason: string): RepoTaskUsage {
  const empty = { repo: null, repo_aliases: [], meter: null, rows: null };
  return { project, window, meter_state: 'missing', meter_reason: reason, ...empty };
}

/**
 * Task tokens and USD of one repository from one `genie-rs usage --project <root> --window <w> --json` call.
 * Every failure — no binary, a non-zero exit, unreadable JSON — is that repository's `missing` state with its
 * reason; genie never falls back to another source or to a call without the repository's aliases.
 */
export function readTaskUsage(project: string, window: MeterWindow, bin: GenieRsBin): RepoTaskUsage {
  if ('missing' in bin) return missingUsage(project, window, `genie_rs_unavailable: ${bin.missing}`);
  const result = spawnSync(bin.path, ['usage', '--project', project, '--window', window, '--json'], {
    encoding: 'utf8',
    timeout: GENIE_RS_TIMEOUT_MS,
    maxBuffer: GENIE_RS_MAX_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return missingUsage(project, window, `genie_rs_unavailable: ${result.error.message}`);
  if (result.status !== 0) return missingUsage(project, window, `genie_rs_exit_${result.status ?? 'signal'}`);
  let body: Omit<RepoTaskUsage, 'project'>;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    return missingUsage(project, window, 'invalid_json');
  }
  if (body?.meter_state === 'measured' && Array.isArray(body.rows)) return { ...body, project, window };
  if (body?.meter_state !== 'missing') return missingUsage(project, window, 'invalid_json');
  return { ...body, project, window, meter: null, rows: null, meter_reason: body.meter_reason ?? 'missing' };
}

const dash = '–';

/** The text form: one block per repository, `–` wherever the meter could not say (never 0). */
export function formatTaskUsage(repos: RepoTaskUsage[]): string {
  if (repos.length === 0) return '';
  const out: string[] = [];
  for (const r of repos) {
    out.push(`task usage ${r.repo ?? r.project} (usagemeter query --by task, ${r.window})`);
    if (r.rows === null) {
      out.push(`${dash}\t${r.meter_reason ?? 'missing'}`);
      continue;
    }
    if (r.rows.length === 0) {
      out.push(`no task usage in ${r.window}`);
      continue;
    }
    out.push('task\ttokens\tusd\tstate\treason');
    for (const row of r.rows) {
      // A stale or missing row says nothing about tokens either: `–` for both, with its reason.
      const measured = row.state === 'measured';
      const tokens = measured && row.tokens ? String(row.tokens.total) : dash;
      const usd = measured && row.cost?.usd != null ? row.cost.usd.toFixed(4) : dash;
      const state = measured && row.cost ? row.cost.state : row.state;
      out.push(`${row.task}\t${tokens}\t${usd}\t${state}\t${row.reason ?? '-'}`);
    }
  }
  return `${out.join('\n')}\n`;
}
