/**
 * `genie db migrate-v1` — migrate v1-era genie data into the current v2
 * fingerprinted workspace.
 *
 * Drops into `src/term-commands/db-migrate-v1.ts`. Companion file:
 * `src/lib/v1-migration-prompt.ts` (auto-detect + prompt-once at startup).
 *
 * Background
 * ----------
 * pgserve v1 served arbitrary database names freely. After v2 upgrade, the
 * bare `genie` database with months of tasks/wishes/sessions is silently
 * unreachable to v2 peers (no fingerprint owns the name) and reapable by
 * the GC sweep. This command does the ETL: v1 → caller's v2 fingerprinted
 * DB, then archives v1 with persist=true so it can never be reaped.
 *
 * Connection model
 * ----------------
 *   - V1 source: TCP `127.0.0.1:<port>` user=postgres pass=postgres database=genie.
 *     Postgres itself does not enforce fingerprints — the wrapper does.
 *   - V2 target: caller's `getConnection()` (already routed via socket).
 *
 * Schema-aware ETL (lessons from real migration)
 * ----------------------------------------------
 *   1. Identity columns (attidentity='a' GENERATED ALWAYS): excluded from
 *      INSERT column list. Otherwise: "cannot insert a non-DEFAULT value".
 *   2. Stored generated columns (attgenerated='s'): excluded.
 *   3. Bare `ON CONFLICT DO NOTHING` (no constraint target) — handles any
 *      unique violation, including junction tables without `id` PK.
 *   4. FK ordering: executors → agents (genie schema has agents.current_executor_id).
 *   5. Self-FKs (sessions.parent_session_id): `session_replication_role='replica'`
 *      bypasses ALL FK triggers for the session. Standard Postgres bulk-load.
 *
 * Idempotency & safety
 * --------------------
 *   - `ON CONFLICT DO NOTHING` makes every table idempotent.
 *   - On full success, v1 DB is renamed to `genie_archive_<YYYYMMDD>` and
 *     marked persist=true in pgserve_meta — GC cannot reap it.
 *   - Completion is recorded in `_genie_migration_state` on the target,
 *     so the startup auto-prompt suppresses future offers.
 */

import type { Command } from 'commander';
import postgres from 'postgres';
import { getConnection, isAvailable, shutdown } from '../lib/db.js';
import { recordMigrationComplete } from '../lib/v1-migration-prompt.js';

const V1_DB_NAME = 'genie';
const V1_USER = 'postgres';
const V1_PASS = 'postgres';
const V1_HOST = '127.0.0.1';

/** FK-safe order. Parents BEFORE children. */
const FOUNDATION_TABLES = [
  'organizations',
  'projects',
  'executors',
  'agents',
  'agent_projects',
  'teams',
  'board_templates',
  'boards',
  'task_types',
  'wishes',
  'tasks',
  'task_actors',
  'task_dependencies',
  'task_stage_log',
  'tags',
  'task_tags',
  'assignments',
] as const;

/** Tables NEVER migrated — high-volume runtime logs that regenerate. */
const NEVER_MIGRATE = new Set([
  'tool_events',
  'genie_runtime_events',
  'heartbeats',
  'machine_snapshots',
  'genie_bridge_sessions',
  'mailbox',
  'messages',
]);

interface MigrateOptions {
  dryRun?: boolean;
  yes?: boolean;
  includeSessions?: string;
  includeAudit?: string;
  includeContent?: boolean;
  archive?: boolean;
}

interface ColumnInfo {
  name: string;
  identity: 'a' | 'd' | '';
  generated: 's' | '';
}

interface TableResult {
  copied: number;
  skipped: number;
  failed?: string;
}

async function dbMigrateV1Command(options: MigrateOptions): Promise<void> {
  if (!(await isAvailable())) {
    console.error('Database is not running. Start it with: genie db status');
    process.exit(1);
  }

  const v2 = await getConnection();
  const port = await resolveV1Port(v2);

  console.log('[genie db migrate-v1] Detecting v1 data…');
  const detected = await detectV1(port);
  if (!detected) {
    console.log('  No v1 `genie` database found. Nothing to migrate.');
    await shutdown();
    return;
  }

  const targetRows = await v2.unsafe('SELECT current_database() AS db');
  const targetDb = (targetRows as unknown as Array<{ db: string }>)[0]?.db ?? '';
  const sessionDays = parseDayWindow(options.includeSessions, 30);
  const auditDays = parseDayWindow(options.includeAudit, 0); // OFF by default — too large

  printMigrationPreview(detected, port, targetDb, options, sessionDays, auditDays);

  if (options.dryRun) {
    console.log('--dry-run set, exiting.');
    await shutdown();
    return;
  }
  if (!options.yes && !(await confirm('Proceed with migration?'))) {
    console.log('Aborted.');
    await shutdown();
    return;
  }

  const { v1, v2Bypass } = openMigrationClients(port, targetDb);
  const summary: Record<string, number> = {};
  const failures: string[] = [];

  try {
    await runMigrations(v1, v2Bypass, options, sessionDays, auditDays, summary, failures);
  } finally {
    await v1.end({ timeout: 5 });
    await v2Bypass.end({ timeout: 5 });
  }

  await finalizeMigration(v2, summary, failures, port, options);
  await shutdown();
}

// We need a TCP port to read v1 directly. The runtime may be on a Unix
// socket; ask the live admin client for the port via SHOW port.
async function resolveV1Port(v2: V2Sql): Promise<number> {
  const portRows = await v2.unsafe('SHOW port');
  const port = Number((portRows as unknown as Array<{ port: string }>)[0]?.port);
  if (!Number.isFinite(port) || port <= 0) {
    console.error('Could not resolve pgserve TCP port from runtime connection.');
    await shutdown();
    process.exit(1);
  }
  return port;
}

type V2Sql = Awaited<ReturnType<typeof getConnection>>;

function printMigrationPreview(
  detected: { rowCounts: Record<string, number>; totalSizeBytes: number },
  port: number,
  targetDb: string,
  options: MigrateOptions,
  sessionDays: number,
  auditDays: number,
): void {
  console.log(`  Source: ${V1_DB_NAME} (v1, port ${port}, ${formatBytes(detected.totalSizeBytes)} on disk)`);
  console.log(`  Target: ${targetDb} (your v2 workspace)`);
  console.log();
  console.log('Row counts in v1:');
  for (const t of FOUNDATION_TABLES) {
    const c = detected.rowCounts[t];
    if (typeof c === 'number') console.log(`  ${t.padEnd(22)} ${c}`);
  }
  if (sessionDays > 0)
    console.log(`  ${'sessions'.padEnd(22)} ${detected.rowCounts.sessions ?? 0}  (last ${sessionDays} days)`);
  if (auditDays > 0)
    console.log(`  ${'audit_events'.padEnd(22)} ${detected.rowCounts.audit_events ?? 0}  (last ${auditDays} days)`);
  if (options.includeContent)
    console.log(
      `  ${'session_content'.padEnd(22)} ${detected.rowCounts.session_content ?? 0}  (last ${sessionDays} days, --include-content)`,
    );
  console.log();
  console.log(`Will SKIP:    ${[...NEVER_MIGRATE].join(', ')}`);
  if (options.archive !== false) {
    console.log(`Will ARCHIVE: source DB renamed to ${archiveName()} (kept indefinitely; persist=true)`);
  }
  console.log();
}

function openMigrationClients(port: number, targetDb: string): { v1: postgres.Sql; v2Bypass: postgres.Sql } {
  // Migration session — bypass FK triggers for cross-row inserts (sessions self-FK).
  const v1 = postgres({
    host: V1_HOST,
    port,
    username: V1_USER,
    password: V1_PASS,
    database: V1_DB_NAME,
    max: 1,
    onnotice: () => {},
    idle_timeout: 5,
  });
  // Dedicated v2 client with replica role so FK triggers don't fire.
  const v2Bypass = postgres({
    host: V1_HOST,
    port,
    username: V1_USER,
    password: V1_PASS,
    database: targetDb,
    max: 1,
    onnotice: () => {},
    idle_timeout: 5,
    connection: { session_replication_role: 'replica' },
  });
  return { v1, v2Bypass };
}

async function runMigrations(
  v1: postgres.Sql,
  v2Bypass: postgres.Sql,
  options: MigrateOptions,
  sessionDays: number,
  auditDays: number,
  summary: Record<string, number>,
  failures: string[],
): Promise<void> {
  for (const table of FOUNDATION_TABLES) {
    if (NEVER_MIGRATE.has(table)) continue;
    await runOne(v1, v2Bypass, table, summary, failures);
  }
  if (sessionDays > 0) {
    await runOne(v1, v2Bypass, 'sessions', summary, failures, { dateColumn: 'created_at', days: sessionDays });
  }
  if (auditDays > 0) {
    await runOne(v1, v2Bypass, 'audit_events', summary, failures, { dateColumn: 'created_at', days: auditDays });
  }
  if (options.includeContent && sessionDays > 0) {
    await runOne(v1, v2Bypass, 'session_content', summary, failures, { dateColumn: 'created_at', days: sessionDays });
  }
}

async function runOne(
  v1: postgres.Sql,
  v2Bypass: postgres.Sql,
  table: string,
  summary: Record<string, number>,
  failures: string[],
  windowOpt?: { dateColumn: string; days: number },
): Promise<void> {
  const r = await migrateOne(v1, v2Bypass, table, windowOpt);
  report(table, r);
  if (r.failed) failures.push(`${table}: ${r.failed}`);
  else summary[table] = r.copied;
}

async function finalizeMigration(
  v2: V2Sql,
  summary: Record<string, number>,
  failures: string[],
  port: number,
  options: MigrateOptions,
): Promise<void> {
  console.log();
  const total = Object.values(summary).reduce((a, b) => a + b, 0);
  console.log(`Migrated ${total} rows across ${Object.keys(summary).length} tables. ${failures.length} failed.`);
  for (const f of failures) console.log(`  - ${f}`);

  if (failures.length > 0) {
    console.log(`Skipping archive due to ${failures.length} failures. Re-run after resolving (idempotent).`);
    return;
  }

  // Mark migration complete in the target DB so the startup prompt is silenced
  await recordMigrationComplete(v2, V1_DB_NAME, summary);
  console.log('Migration recorded in _genie_migration_state — startup prompt will be silenced.');

  if (options.archive !== false) {
    const archive = archiveName();
    console.log(`Archiving v1 → ${archive}`);
    await archiveV1(port, archive);
    console.log(`Done. ${archive} renamed and marked persist=true.`);
  }
}

async function detectV1(port: number): Promise<{ rowCounts: Record<string, number>; totalSizeBytes: number } | null> {
  const v1 = postgres({
    host: V1_HOST,
    port,
    username: V1_USER,
    password: V1_PASS,
    database: V1_DB_NAME,
    max: 1,
    onnotice: () => {},
    connect_timeout: 5,
    idle_timeout: 1,
  });
  try {
    const tableRows = await v1<{ relname: string; n_live_tup: bigint }[]>`
      SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE schemaname='public'
    `;
    if (tableRows.length === 0) return null;
    const counts: Record<string, number> = {};
    for (const r of tableRows) counts[r.relname] = Number(r.n_live_tup);
    const sizeRows = await v1<{ size: bigint }[]>`SELECT pg_database_size(${V1_DB_NAME}) AS size`;
    return { rowCounts: counts, totalSizeBytes: Number(sizeRows[0]?.size ?? 0) };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (['3D000', '08001', '08006', 'ECONNREFUSED'].includes(code ?? '')) return null;
    throw err;
  } finally {
    try {
      await v1.end({ timeout: 1 });
    } catch {
      /* swallow */
    }
  }
}

async function getInsertableColumns(client: postgres.Sql, table: string): Promise<ColumnInfo[]> {
  return client<ColumnInfo[]>`
    SELECT a.attname AS name, a.attidentity::text AS identity, a.attgenerated::text AS generated
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=${table} AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `;
}

async function migrateOne(
  v1: postgres.Sql,
  v2: postgres.Sql,
  table: string,
  windowOpt?: { dateColumn: string; days: number },
): Promise<TableResult> {
  try {
    const v1Cols = await getInsertableColumns(v1, table);
    const v2Cols = await getInsertableColumns(v2, table);
    if (v1Cols.length === 0) return { copied: 0, skipped: 0 };
    if (v2Cols.length === 0) return { copied: 0, skipped: 0, failed: 'target lacks table' };

    const v2Map = new Map(v2Cols.map((c) => [c.name, c]));
    const cols = v1Cols
      .map((c) => c.name)
      .filter((name) => {
        const v2c = v2Map.get(name);
        if (!v2c) return false;
        if (v2c.identity === 'a') return false;
        if (v2c.generated === 's') return false;
        return true;
      });
    if (cols.length === 0) return { copied: 0, skipped: 0, failed: 'no insertable shared columns' };

    const colList = cols.map((c) => `"${c}"`).join(',');
    const where = windowOpt ? `WHERE "${windowOpt.dateColumn}" > now() - interval '${windowOpt.days} days'` : '';
    const rows = await v1.unsafe(`SELECT ${colList} FROM "${table}" ${where}`);
    if (rows.length === 0) return { copied: 0, skipped: 0 };

    let copied = 0;
    const batchSize = 200;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const placeholders = batch
        .map((_, ri) => `(${cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(',')})`)
        .join(',');
      const values = batch.flatMap((row) => cols.map((c) => (row as Record<string, unknown>)[c]));
      const stmt = `INSERT INTO "${table}" (${colList}) VALUES ${placeholders} ON CONFLICT DO NOTHING`;
      // biome-ignore lint/suspicious/noExplicitAny: postgres.js unsafe() typed as ParameterOrJSON<never>[] but accepts any param shape at runtime
      const r = await v2.unsafe(stmt, values as any);
      copied += Number((r as unknown as { count?: number }).count ?? 0);
    }
    return { copied, skipped: rows.length - copied };
  } catch (err) {
    return { copied: 0, skipped: 0, failed: err instanceof Error ? err.message : String(err) };
  }
}

async function archiveV1(port: number, archive: string): Promise<void> {
  const admin = postgres({
    host: V1_HOST,
    port,
    username: V1_USER,
    password: V1_PASS,
    database: 'postgres',
    max: 1,
    onnotice: () => {},
  });
  try {
    await admin.unsafe(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
      [V1_DB_NAME],
    );
    await admin.unsafe(`ALTER DATABASE "${V1_DB_NAME}" RENAME TO "${archive}"`);
    await admin.unsafe(
      `INSERT INTO pgserve_meta (database_name, fingerprint, peer_uid, persist) VALUES ($1, $2, $3, true)
       ON CONFLICT (database_name) DO UPDATE SET persist=true`,
      [archive, 'legacy_v1_archive', 0],
    );
  } finally {
    await admin.end({ timeout: 5 });
  }
}

function report(table: string, r: TableResult): void {
  if (r.failed) console.log(`  ✗ ${table.padEnd(22)} FAILED: ${r.failed}`);
  else if (r.copied === 0 && r.skipped === 0) console.log(`  - ${table.padEnd(22)} (no rows)`);
  else console.log(`  ✓ ${table.padEnd(22)} +${r.copied} copied, ${r.skipped} already present`);
}

function archiveName(): string {
  const d = new Date();
  return `genie_archive_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function parseDayWindow(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

async function confirm(prompt: string): Promise<boolean> {
  process.stdout.write(`${prompt} [Y/n]: `);
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    const onData = (chunk: string): void => {
      const v = chunk.trim().toLowerCase();
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      resolve(v === '' || v === 'y' || v === 'yes');
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
}

export function registerDbMigrateV1Command(db: Command): void {
  db.command('migrate-v1')
    .description('Migrate v1-era genie data into your v2 fingerprinted workspace')
    .option('--dry-run', 'Show what would migrate without writing')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--include-sessions <days>', 'Days of session history to migrate (default 30)')
    .option('--include-audit <days>', 'Days of audit_events to migrate (default 0 = skipped)')
    .option('--include-content', 'Also migrate session_content (skipped by default — large)')
    .option('--no-archive', `Don't rename source DB to genie_archive_<date> after migration`)
    .action(dbMigrateV1Command);
}

export { detectV1, migrateOne };
