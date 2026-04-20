/**
 * Observability health probes for `genie doctor --observability`.
 *
 * Wish: genie-serve-structured-observability (Groups 1 + 6).
 *
 * Group 1 introduced partition + wide-emit-flag reporting; Group 6 extends
 * the report with watchdog install state, recent watcher-metric presence, and
 * the spill journal drain status. All fields fail soft — if PG is offline the
 * DB-derived fields come back `unknown` so `genie doctor` still runs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getConnection } from '../lib/db.js';
import { isSpillJournalEmpty } from '../lib/emit.js';
import { readWideEmitFlag } from '../lib/observability-flag.js';

export type PartitionHealth = 'ok' | 'warn' | 'fail' | 'unknown';
export type ComponentStatus = 'ok' | 'warn' | 'fail' | 'unknown';

/** Six watcher-of-watcher meta types owned by Group 6. */
export const WATCHER_META_TYPES = [
  'emitter.rejected',
  'emitter.queue.depth',
  'emitter.latency_p99',
  'notify.delivery.lag',
  'stream.gap.detected',
  'correlation.orphan.rate',
] as const;

export interface WatcherMetricReport {
  type: string;
  last_seen_at: string | null;
  status: ComponentStatus;
}

export interface ObservabilityHealthReport {
  partition_health: PartitionHealth;
  partition_count: number;
  next_rotation_at: string | null;
  oldest_partition: string | null;
  newest_partition: string | null;
  wide_emit_flag: 'on' | 'off';
  watchdog: ComponentStatus;
  watchdog_detail?: string;
  watcher_metrics: ComponentStatus;
  watcher_metric_details: WatcherMetricReport[];
  spill_journal: 'empty' | 'pending' | 'unknown';
  spill_path: string;
  message?: string;
}

function spillJournalPath(): string {
  const home = process.env.GENIE_HOME ?? join(homedir(), '.genie');
  return join(home, 'data', 'emit-spill.jsonl');
}

/** Check whether the systemd timer units are present on disk. */
function collectWatchdogStatus(): { status: ComponentStatus; detail?: string } {
  const timer = '/etc/systemd/system/genie-watchdog.timer';
  const service = '/etc/systemd/system/genie-watchdog.service';
  const timerPresent = existsSync(timer);
  const servicePresent = existsSync(service);
  if (timerPresent && servicePresent) return { status: 'ok' };
  if (!timerPresent && !servicePresent) {
    return {
      status: 'warn',
      detail: 'watchdog not installed — run: bun run packages/watchdog/src/cli.ts install',
    };
  }
  return { status: 'warn', detail: `partial install: timer=${timerPresent} service=${servicePresent}` };
}

function collectSpillJournalStatus(): 'empty' | 'pending' | 'unknown' {
  try {
    if (isSpillJournalEmpty()) return 'empty';
    return 'pending';
  } catch {
    // isSpillJournalEmpty reads the file system; treat errors as unknown so the
    // health report never fails just because of a permissions oddity.
    const path = spillJournalPath();
    try {
      if (!existsSync(path)) return 'empty';
      const contents = readFileSync(path, 'utf8');
      return contents.trim().length === 0 ? 'empty' : 'pending';
    } catch {
      return 'unknown';
    }
  }
}

async function collectWatcherMetricStatus(sql: Awaited<ReturnType<typeof getConnection>>): Promise<{
  rollup: ComponentStatus;
  details: WatcherMetricReport[];
}> {
  const rows = (await sql.unsafe(
    `
    SELECT subject AS type, max(created_at) AS last_seen_at
      FROM genie_runtime_events
     WHERE subject = ANY($1)
       AND created_at > now() - interval '5 minutes'
     GROUP BY subject
    `,
    [[...WATCHER_META_TYPES]],
  )) as Array<{ type: string; last_seen_at: Date | string | null }>;

  const seen = new Map<string, string | null>();
  for (const row of rows) {
    const ts = row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null;
    seen.set(row.type, ts);
  }

  const details: WatcherMetricReport[] = WATCHER_META_TYPES.map((type) => ({
    type,
    last_seen_at: seen.get(type) ?? null,
    status: seen.has(type) ? 'ok' : 'warn',
  }));

  const missing = details.filter((d) => d.status === 'warn').length;
  let rollup: ComponentStatus = 'ok';
  if (missing >= WATCHER_META_TYPES.length) rollup = 'warn';
  else if (missing > 0) rollup = 'warn';
  return { rollup, details };
}

/**
 * Collect partition counts + next-rotation timestamp from PG. Safe to call in
 * environments where the DB is offline (returns `unknown` instead of throwing).
 */
export async function collectObservabilityHealth(): Promise<ObservabilityHealthReport> {
  const wideEmit = readWideEmitFlag();
  const watchdog = collectWatchdogStatus();
  const spillJournal = collectSpillJournalStatus();
  const spillPath = spillJournalPath();

  try {
    const sql = await getConnection();
    const rows = await sql<{ child: string }[]>`
      SELECT c.relname AS child
        FROM pg_inherits i
        JOIN pg_class   c ON i.inhrelid = c.oid
        JOIN pg_class   p ON i.inhparent = p.oid
       WHERE p.relname = 'genie_runtime_events'
         AND c.relname ~ '^genie_runtime_events_p[0-9]{8}$'
       ORDER BY c.relname
    `;

    const partitions = (rows as Array<{ child: string }>).map((r) => r.child);
    const count = partitions.length;

    const watcher = await collectWatcherMetricStatus(sql);

    if (count === 0) {
      return {
        partition_health: 'warn',
        partition_count: 0,
        next_rotation_at: null,
        oldest_partition: null,
        newest_partition: null,
        wide_emit_flag: wideEmit,
        watchdog: watchdog.status,
        watchdog_detail: watchdog.detail,
        watcher_metrics: watcher.rollup,
        watcher_metric_details: watcher.details,
        spill_journal: spillJournal,
        spill_path: spillPath,
        message: 'No daily partitions detected — run migrations to seed them.',
      };
    }

    // Date of last partition (newest) + expected next rotation.
    const newest = partitions[partitions.length - 1];
    const oldest = partitions[0];
    const newestDate = newest.match(/p(\d{4})(\d{2})(\d{2})$/);

    let nextRotation: string | null = null;
    if (newestDate) {
      const y = Number.parseInt(newestDate[1], 10);
      const m = Number.parseInt(newestDate[2], 10) - 1;
      const d = Number.parseInt(newestDate[3], 10);
      const next = new Date(Date.UTC(y, m, d + 1));
      nextRotation = next.toISOString();
    }

    // <48h runway warning.
    let health: PartitionHealth = 'ok';
    if (nextRotation) {
      const deltaMs = Date.parse(nextRotation) - Date.now();
      if (deltaMs < 48 * 60 * 60 * 1000) {
        health = 'warn';
      }
      if (deltaMs < 0) {
        health = 'fail';
      }
    }

    return {
      partition_health: health,
      partition_count: count,
      next_rotation_at: nextRotation,
      oldest_partition: oldest,
      newest_partition: newest,
      wide_emit_flag: wideEmit,
      watchdog: watchdog.status,
      watchdog_detail: watchdog.detail,
      watcher_metrics: watcher.rollup,
      watcher_metric_details: watcher.details,
      spill_journal: spillJournal,
      spill_path: spillPath,
    };
  } catch (err) {
    return {
      partition_health: 'unknown',
      partition_count: 0,
      next_rotation_at: null,
      oldest_partition: null,
      newest_partition: null,
      wide_emit_flag: wideEmit,
      watchdog: watchdog.status,
      watchdog_detail: watchdog.detail,
      watcher_metrics: 'unknown',
      watcher_metric_details: WATCHER_META_TYPES.map((type) => ({
        type,
        last_seen_at: null,
        status: 'unknown',
      })),
      spill_journal: spillJournal,
      spill_path: spillPath,
      message: `PG unreachable: ${(err as Error).message}`,
    };
  }
}
