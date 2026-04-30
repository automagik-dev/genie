/**
 * `genie db ls` — list all pgserve databases on the host.
 *
 * Drops into `src/term-commands/db-ls.ts`. Operator visibility for the
 * proliferation of per-fingerprint DBs in pgserve v2.
 *
 * Default output (table): name, size, persist, last_connection, package_realpath
 * --json: machine-readable, full row from pgserve_meta + size
 * --counts: extra column showing tasks/wishes counts per DB (slow — opens
 *           one connection per DB; off by default)
 * --all: include system DBs (postgres / template0 / template1)
 * --orphans: only show DBs that don't match `app_*_<12hex>` AND aren't tracked
 *
 * No destructive actions — read-only by design.
 */

import type { Command } from 'commander';
import postgres from 'postgres';
import { getConnection, isAvailable, shutdown } from '../lib/db.js';

const PG_USER = 'postgres';
const PG_PASS = 'postgres';
const PG_HOST = '127.0.0.1';
const SYSTEM_DBS = new Set(['postgres', 'template0', 'template1']);
const V2_TENANT_DB_PATTERN = /^app_[a-z0-9_]{1,50}_[0-9a-f]{12}$/;

interface DbRow {
  name: string;
  sizeBytes: number;
  fingerprint: string | null;
  persist: boolean;
  lastConnectionAt: Date | null;
  packageRealpath: string | null;
  livenessPid: number | null;
  isV2Pattern: boolean;
  isSystem: boolean;
  /** Optional: filled when --counts is set. */
  counts?: { tasks?: number; wishes?: number; teams?: number; sessions?: number };
}

interface LsOptions {
  json?: boolean;
  counts?: boolean;
  all?: boolean;
  orphans?: boolean;
}

async function dbLsCommand(options: LsOptions): Promise<void> {
  const available = await isAvailable();
  if (!available) {
    console.error('Database is not running.');
    process.exit(1);
  }

  const v2 = await getConnection();
  const portRows = await v2.unsafe('SHOW port');
  const port = Number((portRows as Array<{ port: string }>)[0]?.port);
  if (!Number.isFinite(port) || port <= 0) {
    console.error('Could not resolve pgserve TCP port.');
    await shutdown();
    process.exit(1);
  }

  // Use TCP admin so we can see ALL DBs (not just the caller's fingerprint).
  const admin = postgres({
    host: PG_HOST,
    port,
    username: PG_USER,
    password: PG_PASS,
    database: 'postgres',
    max: 1,
    onnotice: () => {},
    idle_timeout: 5,
  });

  try {
    const rows = await loadAllDbs(admin);
    let filtered = rows;
    if (!options.all) filtered = filtered.filter((r) => !r.isSystem);
    if (options.orphans) filtered = filtered.filter((r) => !r.isV2Pattern && !r.isSystem && !r.fingerprint);

    if (options.counts) {
      // Connect to each DB and probe genie tables
      for (const row of filtered) {
        if (row.isSystem) continue;
        try {
          const c = postgres({
            host: PG_HOST,
            port,
            username: PG_USER,
            password: PG_PASS,
            database: row.name,
            max: 1,
            onnotice: () => {},
            idle_timeout: 1,
            connect_timeout: 3,
          });
          const probe = await c<{ relname: string; n_live_tup: bigint }[]>`
            SELECT relname, n_live_tup FROM pg_stat_user_tables
            WHERE schemaname='public' AND relname IN ('tasks','wishes','teams','sessions')
          `;
          const counts: NonNullable<DbRow['counts']> = {};
          for (const p of probe) {
            const n = Number(p.n_live_tup);
            if (p.relname === 'tasks') counts.tasks = n;
            else if (p.relname === 'wishes') counts.wishes = n;
            else if (p.relname === 'teams') counts.teams = n;
            else if (p.relname === 'sessions') counts.sessions = n;
          }
          row.counts = counts;
          await c.end({ timeout: 1 });
        } catch {
          // Ignore — DB may not have genie schema; report blank counts
        }
      }
    }

    if (options.json) {
      console.log(JSON.stringify(filtered, null, 2));
    } else {
      printTable(filtered, { showCounts: !!options.counts });
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  await shutdown();
}

async function loadAllDbs(admin: postgres.Sql): Promise<DbRow[]> {
  // Outer join: every DB in pg_database, optional pgserve_meta row.
  const rows = await admin<
    {
      datname: string;
      size_bytes: bigint;
      fingerprint: string | null;
      persist: boolean | null;
      last_connection_at: Date | null;
      package_realpath: string | null;
      liveness_pid: number | null;
    }[]
  >`
    SELECT
      d.datname AS datname,
      pg_database_size(d.datname) AS size_bytes,
      m.fingerprint,
      m.persist,
      m.last_connection_at,
      m.package_realpath,
      m.liveness_pid
    FROM pg_database d
    LEFT JOIN pgserve_meta m ON m.database_name = d.datname
    ORDER BY pg_database_size(d.datname) DESC
  `;
  return rows.map((r) => ({
    name: r.datname,
    sizeBytes: Number(r.size_bytes),
    fingerprint: r.fingerprint,
    persist: !!r.persist,
    lastConnectionAt: r.last_connection_at,
    packageRealpath: r.package_realpath,
    livenessPid: r.liveness_pid,
    isV2Pattern: V2_TENANT_DB_PATTERN.test(r.datname),
    isSystem: SYSTEM_DBS.has(r.datname),
  }));
}

function printTable(rows: DbRow[], opts: { showCounts: boolean }): void {
  if (rows.length === 0) {
    console.log('(no databases)');
    return;
  }

  const cols = [
    { header: 'NAME', getter: (r: DbRow) => r.name },
    { header: 'SIZE', getter: (r: DbRow) => formatBytes(r.sizeBytes) },
    { header: 'PERSIST', getter: (r: DbRow) => (r.persist ? 'yes' : 'no') },
    { header: 'LAST CONNECT', getter: (r: DbRow) => formatDate(r.lastConnectionAt) },
    { header: 'FINGERPRINT', getter: (r: DbRow) => r.fingerprint ?? '(no meta row)' },
    { header: 'PACKAGE', getter: (r: DbRow) => r.packageRealpath ?? '(script-mode)' },
  ];
  if (opts.showCounts) {
    cols.push({
      header: 'TASKS / WISHES / TEAMS / SESSIONS',
      getter: (r: DbRow) => {
        if (!r.counts) return '-';
        return `${r.counts.tasks ?? '-'} / ${r.counts.wishes ?? '-'} / ${r.counts.teams ?? '-'} / ${r.counts.sessions ?? '-'}`;
      },
    });
  }

  const widths = cols.map((c) => Math.max(c.header.length, ...rows.map((r) => c.getter(r).length)));
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  console.log(cols.map((c, i) => c.header.padEnd(widths[i])).join('  '));
  console.log(sep);
  for (const r of rows) {
    console.log(cols.map((c, i) => c.getter(r).padEnd(widths[i])).join('  '));
  }
  console.log();

  // Summary footer
  const total = rows.reduce((acc, r) => acc + r.sizeBytes, 0);
  const persistCount = rows.filter((r) => r.persist).length;
  const orphanCount = rows.filter((r) => !r.fingerprint && !r.isSystem).length;
  const v2Count = rows.filter((r) => r.isV2Pattern).length;
  console.log(
    `${rows.length} databases (${formatBytes(total)} total) — ` +
      `${persistCount} persist, ${orphanCount} orphans, ${v2Count} v2-pattern`,
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

function formatDate(d: Date | null): string {
  if (!d) return '-';
  const now = Date.now();
  const elapsedMs = now - d.getTime();
  const sec = Math.floor(elapsedMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function registerDbLsCommand(db: Command): void {
  db.command('ls')
    .description('List all pgserve databases on this host')
    .option('--json', 'Machine-readable JSON output')
    .option('--counts', 'Probe each DB for tasks/wishes/teams/sessions row counts (slower)')
    .option('--all', 'Include system DBs (postgres, template0, template1)')
    .option('--orphans', 'Only show DBs without a pgserve_meta row (legacy / unmanaged)')
    .action(dbLsCommand);
}

export { loadAllDbs };
