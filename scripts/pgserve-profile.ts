#!/usr/bin/env bun

/**
 * pgserve-profile: capture a workload profile from the genie pgserve instance.
 *
 * Snapshots `pg_stat_*` views at the start, sleeps for `--duration`, then
 * snapshots again and writes a JSON delta to the wish folder. The delta is
 * the input to `pgserve-apply-tuning.ts`.
 *
 * What we capture (deltas where it makes sense):
 *  - pg_stat_database (xact_commit/rollback, blks_read/hit, deadlocks, …)
 *  - pg_stat_bgwriter / pg_stat_checkpointer / pg_stat_wal
 *  - pg_stat_user_tables (top by seq scans + heap fetches)
 *  - pg_stat_user_indexes (top by idx_scan)
 *  - pg_stat_statements top-N (if extension is loaded)
 *  - peak `pg_stat_activity` connection counts (sampled every 5 s)
 *  - lock-wait counts (`pg_locks` granted=false, sampled every 5 s)
 *  - the longest running query at each sample tick
 *
 * The script intentionally takes only read snapshots — it never restarts pgserve
 * or changes config. It is safe to run against a live workload at any time.
 *
 * Usage:
 *   bun run scripts/pgserve-profile.ts --duration 30m \
 *     --out .genie/wishes/hookify-perf-foundation/profile.json
 *
 * Duration accepts: `30s`, `5m`, `2h`, `1h30m`, or a raw integer in seconds.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getConnection } from '../src/lib/db.js';

type Args = {
  duration: number;
  out: string;
  sampleIntervalMs: number;
  topN: number;
};

function parseDuration(input: string): number {
  if (/^\d+$/.test(input)) return Number(input);
  const m = input.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) throw new Error(`invalid --duration: ${input} (use e.g. "30m", "1h30m", "45s")`);
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0);
  const total = h * 3600 + min * 60 + s;
  if (total <= 0) throw new Error(`--duration must be > 0 (got ${input})`);
  return total;
}

function parseArgs(argv: string[]): Args {
  let duration = 60 * 30; // 30 min default
  let out = '.genie/wishes/hookify-perf-foundation/profile.json';
  let sampleIntervalMs = 5000;
  let topN = 20;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--duration') duration = parseDuration(argv[++i]);
    else if (a === '--out') out = argv[++i];
    else if (a === '--sample-interval-ms') sampleIntervalMs = Number(argv[++i]);
    else if (a === '--top-n') topN = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(
        `pgserve-profile — capture a workload profile from genie pgserve.\n\nOptions:\n  --duration <dur>          how long to sample (default 30m)\n  --out <path>              output JSON path (default ${out})\n  --sample-interval-ms <ms> connection / lock sample tick (default 5000)\n  --top-n <n>               top-N entries per ranked view (default 20)\n`,
      );
      process.exit(0);
    } else throw new Error(`unknown arg: ${a}`);
  }
  if (!Number.isFinite(sampleIntervalMs) || sampleIntervalMs <= 0 || sampleIntervalMs > 3600000) {
    throw new Error(`--sample-interval-ms must be 1–3600000 ms (got ${sampleIntervalMs})`);
  }
  if (!Number.isFinite(topN) || topN <= 0 || topN >= 10000) {
    throw new Error(`--top-n must be 1–9999 (got ${topN})`);
  }
  return { duration, out, sampleIntervalMs, topN };
}

type Snapshot = {
  taken_at: string;
  server_version: string;
  shared_preload_libraries: string;
  pg_stat_statements_loaded: boolean;
  settings: Record<string, string>;
  pg_stat_database: unknown[];
  pg_stat_bgwriter: unknown[];
  pg_stat_checkpointer: unknown[];
  pg_stat_wal: unknown[];
  pg_stat_user_tables: unknown[];
  pg_stat_user_indexes: unknown[];
  pg_stat_statements: unknown[] | null;
};

const TRACKED_SETTINGS = [
  'shared_buffers',
  'effective_cache_size',
  'work_mem',
  'maintenance_work_mem',
  'wal_compression',
  'wal_writer_flush_after',
  'wal_writer_delay',
  'wal_buffers',
  'max_wal_size',
  'min_wal_size',
  'checkpoint_timeout',
  'checkpoint_completion_target',
  'synchronous_commit',
  'random_page_cost',
  'effective_io_concurrency',
  'max_connections',
  'jit',
  'shared_preload_libraries',
];

// biome-ignore lint/suspicious/noExplicitAny: pgserve sql tagged template uses generic any
async function snapshot(sql: any, topN: number): Promise<Snapshot> {
  const versionRow = await sql`SELECT version() AS v`;
  const splRow = await sql`SHOW shared_preload_libraries`;
  const spl = String(splRow[0]?.shared_preload_libraries ?? '');
  const psstLoaded = spl.includes('pg_stat_statements');

  const settings: Record<string, string> = {};
  for (const name of TRACKED_SETTINGS) {
    try {
      const r = await sql.unsafe(`SHOW ${name}`);
      settings[name] = String(r[0]?.[name] ?? '');
    } catch {
      settings[name] = '';
    }
  }

  const pg_stat_database = await sql`
    SELECT datname, numbackends, xact_commit, xact_rollback,
           blks_read, blks_hit, tup_returned, tup_fetched,
           tup_inserted, tup_updated, tup_deleted,
           deadlocks, conflicts, temp_files, temp_bytes
    FROM pg_stat_database
    WHERE datname IS NOT NULL
  `;

  // pg_stat_bgwriter shape changed across major versions; pull whatever it has.
  let pg_stat_bgwriter: unknown[] = [];
  try {
    pg_stat_bgwriter = await sql`SELECT * FROM pg_stat_bgwriter`;
  } catch {
    /* missing in some forks */
  }

  let pg_stat_checkpointer: unknown[] = [];
  try {
    pg_stat_checkpointer = await sql`SELECT * FROM pg_stat_checkpointer`;
  } catch {
    /* < PG17 */
  }

  let pg_stat_wal: unknown[] = [];
  try {
    pg_stat_wal = await sql`SELECT * FROM pg_stat_wal`;
  } catch {
    /* < PG14 */
  }

  const pg_stat_user_tables = await sql.unsafe(
    `SELECT schemaname, relname,
            seq_scan, seq_tup_read, idx_scan, idx_tup_fetch,
            n_tup_ins, n_tup_upd, n_tup_del, n_live_tup, n_dead_tup,
            vacuum_count, autovacuum_count, analyze_count, autoanalyze_count
     FROM pg_stat_user_tables
     ORDER BY (COALESCE(seq_scan,0)+COALESCE(idx_scan,0)) DESC
     LIMIT ${topN}`,
  );

  const pg_stat_user_indexes = await sql.unsafe(
    `SELECT schemaname, indexrelname, relname, idx_scan, idx_tup_read, idx_tup_fetch
     FROM pg_stat_user_indexes
     ORDER BY idx_scan DESC NULLS LAST
     LIMIT ${topN}`,
  );

  let pg_stat_statements: unknown[] | null = null;
  if (psstLoaded) {
    try {
      pg_stat_statements = await sql.unsafe(
        `SELECT queryid, calls, total_exec_time, mean_exec_time,
                stddev_exec_time, rows, shared_blks_hit, shared_blks_read,
                left(query, 240) AS query
         FROM pg_stat_statements
         ORDER BY total_exec_time DESC
         LIMIT ${topN}`,
      );
    } catch {
      pg_stat_statements = null;
    }
  }

  return {
    taken_at: new Date().toISOString(),
    server_version: String(versionRow[0]?.v ?? ''),
    shared_preload_libraries: spl,
    pg_stat_statements_loaded: psstLoaded,
    settings,
    pg_stat_database,
    pg_stat_bgwriter,
    pg_stat_checkpointer,
    pg_stat_wal,
    pg_stat_user_tables,
    pg_stat_user_indexes,
    pg_stat_statements,
  };
}

type ActivitySample = {
  ts: string;
  total: number;
  active: number;
  idle: number;
  idle_in_txn: number;
  waiting_locks: number;
  longest_query_seconds: number;
  longest_query: string;
};

// biome-ignore lint/suspicious/noExplicitAny: pgserve sql tagged template uses generic any
async function activitySample(sql: any): Promise<ActivitySample> {
  const states = await sql`
    SELECT state, count(*)::int AS n
    FROM pg_stat_activity
    WHERE pid <> pg_backend_pid()
    GROUP BY state
  `;
  const tally: Record<string, number> = {};
  let total = 0;
  for (const row of states) {
    const k = String(row.state ?? 'null');
    const n = Number(row.n);
    tally[k] = n;
    total += n;
  }

  const locks = await sql`
    SELECT count(*)::int AS n
    FROM pg_locks
    WHERE granted = false
  `;

  const longest = await sql`
    SELECT
      EXTRACT(EPOCH FROM (now() - query_start))::float AS secs,
      left(query, 240) AS q
    FROM pg_stat_activity
    WHERE state = 'active'
      AND pid <> pg_backend_pid()
      AND query_start IS NOT NULL
    ORDER BY query_start ASC
    LIMIT 1
  `;

  return {
    ts: new Date().toISOString(),
    total,
    active: tally.active ?? 0,
    idle: tally.idle ?? 0,
    idle_in_txn: tally['idle in transaction'] ?? 0,
    waiting_locks: Number(locks[0]?.n ?? 0),
    longest_query_seconds: Number(longest[0]?.secs ?? 0),
    longest_query: String(longest[0]?.q ?? ''),
  };
}

function fmtDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : '', `${s}s`].filter(Boolean).join('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });

  const sql = await getConnection();
  console.log(`[pgserve-profile] connected; sampling for ${fmtDuration(args.duration)}`);

  const start = await snapshot(sql, args.topN);
  console.log(
    `[pgserve-profile] start snapshot taken at ${start.taken_at} ` +
      `(pg_stat_statements ${start.pg_stat_statements_loaded ? 'LOADED' : 'NOT loaded — top-query data will be empty; ' + 'add pg_stat_statements to shared_preload_libraries and restart pgserve to enable'})`,
  );

  const samples: ActivitySample[] = [];
  const ticks = Math.max(1, Math.floor((args.duration * 1000) / args.sampleIntervalMs));
  for (let i = 0; i < ticks; i++) {
    try {
      samples.push(await activitySample(sql));
    } catch (err) {
      console.warn(`[pgserve-profile] sample error: ${err instanceof Error ? err.message : err}`);
    }
    if (i % 12 === 0) {
      const last = samples[samples.length - 1];
      console.log(
        `[pgserve-profile] tick ${i + 1}/${ticks} — backends=${last?.total ?? '?'} ` +
          `active=${last?.active ?? '?'} waiting_locks=${last?.waiting_locks ?? '?'}`,
      );
    }
    if (i < ticks - 1) await new Promise((r) => setTimeout(r, args.sampleIntervalMs));
  }

  const end = await snapshot(sql, args.topN);
  console.log(`[pgserve-profile] end snapshot taken at ${end.taken_at}`);

  const peakBackends = samples.reduce((acc, s) => Math.max(acc, s.total), 0);
  const peakActive = samples.reduce((acc, s) => Math.max(acc, s.active), 0);
  const peakWaitingLocks = samples.reduce((acc, s) => Math.max(acc, s.waiting_locks), 0);
  const longestQuerySeconds = samples.reduce((acc, s) => Math.max(acc, s.longest_query_seconds), 0);

  const report = {
    duration_seconds: args.duration,
    sample_interval_ms: args.sampleIntervalMs,
    sample_count: samples.length,
    peak: {
      backends: peakBackends,
      active: peakActive,
      waiting_locks: peakWaitingLocks,
      longest_query_seconds: longestQuerySeconds,
    },
    samples,
    start,
    end,
  };

  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[pgserve-profile] wrote ${outPath}`);

  if (!start.pg_stat_statements_loaded) {
    console.warn(
      `[pgserve-profile] NOTE: pg_stat_statements is not loaded. To enable, append 'shared_preload_libraries = pg_stat_statements' to ${process.env.GENIE_HOME ?? `${process.env.HOME}/.genie`}/data/pgserve/postgresql.conf, restart pgserve, then run CREATE EXTENSION pg_stat_statements; in the genie database.`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[pgserve-profile] failed: ${err instanceof Error ? err.stack : err}`);
    process.exit(1);
  });
