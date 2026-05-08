/**
 * Database commands — CLI interface for pgserve management.
 *
 * Commands:
 *   genie db status  — show pgserve health, port, data dir, table counts, migration status
 *   genie db migrate — run pending migrations, show results
 *   genie db query   — execute arbitrary SQL, print results as table
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { parseDuration } from '../lib/cron.js';
import { backup, getSnapshotPath, restore } from '../lib/db-backup.js';
import { getMigrationStatus, runMigrations } from '../lib/db-migrations.js';
import {
  getActivePort,
  getConnection,
  getDataDir,
  isAvailable,
  isSocketMode,
  resolvePgserveLibpqSocketPath,
  resolvePgserveSocketDir,
  shutdown,
} from '../lib/db.js';
import { padRight } from '../lib/term-format.js';
import { registerDbLsCommand } from './db-ls.js';
import { registerDbMigrateV1Command } from './db-migrate-v1.js';

/**
 * Walk up from `start` looking for a package.json. Mirrors pgserve v2's
 * `findNearestPackageJson` lookup: the daemon uses the same algorithm to
 * pick which `pgserve.persist` flag applies to the calling process. Used
 * by `db status` so the printed `Persist:` value matches what the daemon
 * actually honored.
 */
export function findNearestPackageJson(start: string): string | null {
  let cwd = start;
  while (true) {
    const candidate = join(cwd, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cwd);
    if (parent === cwd) return null;
    cwd = parent;
  }
}

/**
 * Read `pgserve.persist` from the nearest package.json. Returns `true` only
 * for an explicit opt-in. Anything else (missing file, missing field,
 * non-boolean) is `false` — matches `readPersistFlag` in pgserve v2.
 */
export function readPersistFlag(start: string = process.cwd()): boolean {
  const path = findNearestPackageJson(start);
  if (path === null) return false;
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { pgserve?: { persist?: unknown } };
    return pkg?.pgserve?.persist === true;
  } catch {
    return false;
  }
}

/**
 * Print query results as an aligned table.
 */
function printTable(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log('(0 rows)');
    return;
  }

  const columns = Object.keys(rows[0]);
  const widths = columns.map((col) => {
    const values = rows.map((r) => String(r[col] ?? 'NULL'));
    return Math.max(col.length, ...values.map((v) => v.length));
  });

  // Header
  const header = columns.map((col, i) => padRight(col, widths[i])).join(' | ');
  console.log(header);
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));

  // Rows
  for (const row of rows) {
    const line = columns.map((col, i) => padRight(String(row[col] ?? 'NULL'), widths[i])).join(' | ');
    console.log(line);
  }

  console.log(`(${rows.length} row${rows.length === 1 ? '' : 's'})`);
}

// ============================================================================
// Commands
// ============================================================================

/**
 * Extract the 12-hex fingerprint suffix from a pgserve v2 database name
 * (`app_<sanitized-name>_<12hex>`). Returns null when the name doesn't
 * match — e.g. test mode runs against bespoke template clones.
 */
export function extractFingerprintFromDbName(db: string): string | null {
  const match = /_([0-9a-f]{12})$/.exec(db);
  return match ? match[1] : null;
}

/**
 * `genie db status` — show pgserve health, connection mode, and table counts.
 *
 * pgserve v2: surfaces socket path, the routed `app_<name>_<12hex>` database,
 * the resolved fingerprint hex, and the package's `pgserve.persist` flag so
 * developers can confirm the daemon is keeping their state across reaps.
 * In legacy TCP mode the original port/host fields are still printed.
 */
async function dbStatusCommand(): Promise<void> {
  console.log('\nGenie Database Status');
  console.log('─'.repeat(50));

  const available = await isAvailable();
  if (!available) {
    const socketPath = resolvePgserveLibpqSocketPath();
    console.log('  Status:   stopped');
    console.log(`  Socket:   ${socketPath} (not bound)`);
    console.log('\n  pgserve daemon is not running. Start it with one of:');
    console.log('    npx pgserve daemon                                            # foreground');
    console.log('    pm2 start node_modules/pgserve/bin/pgserve-wrapper.cjs -- daemon   # background');
    console.log('  Genie will also auto-start the daemon on first connect.');
    console.log('');
    return;
  }

  console.log('  Status:   running');

  try {
    const sql = await getConnection();

    if (isSocketMode()) {
      const socketDir = resolvePgserveSocketDir();
      const rows = await sql`SELECT current_database() AS db`;
      const db = String(rows[0]?.db ?? '');
      const fingerprint = extractFingerprintFromDbName(db);
      const persist = readPersistFlag();

      console.log('  Mode:     socket (pgserve v2)');
      console.log(`  Socket:   ${socketDir}/.s.PGSQL.5432`);
      console.log(`  Database: ${db}`);
      console.log(`  Fingerprint: ${fingerprint ?? '(non-standard name)'}`);
      console.log(`  Persist:  ${persist}${persist ? '' : ' (eligible for 24h TTL reap)'}`);
    } else {
      const port = getActivePort();
      console.log('  Mode:     tcp (legacy)');
      console.log('  Host:     127.0.0.1');
      console.log(`  Port:     ${port}`);
      console.log(`  Data dir: ${getDataDir()}`);
    }

    // Database size
    const sizeResult = await sql`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`;
    console.log(`  DB size:  ${sizeResult[0].size}`);

    // Migration status
    const migrations = await getMigrationStatus(sql);
    console.log(`\n  Migrations: ${migrations.applied.length} applied, ${migrations.pending.length} pending`);

    // Table row counts
    const tables = await sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename != '_genie_migrations'
      ORDER BY tablename
    `;

    if (tables.length > 0) {
      console.log('\n  Table Row Counts:');
      const maxNameLen = Math.max(...tables.map((t: { tablename: string }) => t.tablename.length), 5);

      for (const table of tables) {
        const countResult = await sql.unsafe(`SELECT count(*) AS cnt FROM "${table.tablename}"`);
        const count = countResult[0].cnt;
        console.log(`    ${padRight(table.tablename, maxNameLen)}  ${count}`);
      }
    }

    console.log('\n  Escape hatches:');
    console.log('    GENIE_PG_FORCE_TCP=1                       force legacy TCP loopback');
    console.log('    GENIE_NO_BANNER=1                          suppress connect banner');
    console.log('    PGSERVE_DISABLE_FINGERPRINT_ENFORCEMENT=1  bypass per-fingerprint DB check');

    await shutdown();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  Error querying database: ${message}`);
  }

  console.log('');
}

/**
 * `genie db migrate` — run all pending migrations and show results.
 */
async function dbMigrateCommand(): Promise<void> {
  try {
    const sql = await getConnection();
    const status = await getMigrationStatus(sql);

    if (status.pending.length === 0) {
      console.log('All migrations are up to date.');
      console.log(`  Applied: ${status.applied.length} migration${status.applied.length === 1 ? '' : 's'}`);
      await shutdown();
      return;
    }

    console.log(`Running ${status.pending.length} pending migration${status.pending.length === 1 ? '' : 's'}...`);

    const results = await runMigrations(sql);
    for (const r of results) {
      console.log(`  Applied: ${r.name} (${r.applied_at})`);
    }

    console.log(`\nDone. ${results.length} migration${results.length === 1 ? '' : 's'} applied.`);
    await shutdown();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error running migrations: ${message}`);
    process.exit(1);
  }
}

/**
 * `genie db query "<sql>"` — execute arbitrary SQL and print results.
 */
async function dbQueryCommand(query: string): Promise<void> {
  try {
    const sql = await getConnection();
    const result = await sql.unsafe(query);

    if (result.length === 0 && result.count !== undefined) {
      // DDL or DML statement (INSERT/UPDATE/DELETE)
      console.log(`Query OK, ${result.count} row${result.count === 1 ? '' : 's'} affected.`);
    } else {
      printTable(result);
    }

    await shutdown();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Query error: ${message}`);
    process.exit(1);
  }
}

/**
 * Format bytes as human-readable string (e.g. 52.3MB).
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}${units[i]}`;
}

/**
 * `genie db backup` — pg_dump → .genie/snapshot.sql.gz
 */
async function dbBackupCommand(): Promise<void> {
  const available = await isAvailable();
  if (!available) {
    console.error('Database is not running. Start it with: genie db status');
    process.exit(1);
  }

  try {
    const result = backup();
    const compressed = formatBytes(result.compressedBytes);
    const uncompressed = result.uncompressedBytes > 0 ? `, ${formatBytes(result.uncompressedBytes)} uncompressed` : '';
    console.log(`✓ Backup created: ${result.path} (${compressed}${uncompressed})`);
    await shutdown();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Backup failed: ${message}`);
    process.exit(1);
  }
}

/**
 * Prompt for confirmation on stdin. Returns true if user types y/yes.
 */
function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/**
 * `genie db restore [file]` — rebuild DB from snapshot.
 */
async function dbRestoreCommand(file: string | undefined, options: { yes?: boolean }): Promise<void> {
  const snapshotPath = file ?? getSnapshotPath();

  const available = await isAvailable();
  if (!available) {
    console.error('Database is not running. Start it with: genie db status');
    process.exit(1);
  }

  if (!options.yes) {
    const ok = await confirm('This will replace all data in the genie database. Continue? [y/N] ');
    if (!ok) {
      console.log('Restore cancelled.');
      return;
    }
  }

  try {
    // Close our connection pool before dropping the DB
    await shutdown();
    restore(file);
    console.log(`✓ Database restored from: ${snapshotPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Restore failed: ${message}`);
    process.exit(1);
  }
}

/**
 * `genie db prune-events` — delete old runtime events beyond retention period.
 */
async function dbPruneEventsCommand(options: { olderThan: string; dryRun?: boolean }): Promise<void> {
  const ms = parseDuration(options.olderThan);
  const intervalSec = Math.floor(ms / 1000);

  const available = await isAvailable();
  if (!available) {
    console.error('Database is not running. Start it with: genie db status');
    process.exit(1);
  }

  try {
    const sql = await getConnection();

    if (options.dryRun) {
      const rows = await sql`
        SELECT count(*) AS cnt
        FROM genie_runtime_events
        WHERE created_at < now() - make_interval(secs => ${intervalSec})
      `;
      const count = Number(rows[0].cnt);
      console.log(`Would delete ${count} event${count === 1 ? '' : 's'} older than ${options.olderThan}.`);
    } else {
      const result = await sql`
        DELETE FROM genie_runtime_events
        WHERE created_at < now() - make_interval(secs => ${intervalSec})
      `;
      const count = Number(result.count);
      console.log(`Deleted ${count} event${count === 1 ? '' : 's'} older than ${options.olderThan}.`);
    }

    await shutdown();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Prune failed: ${message}`);
    process.exit(1);
  }
}

// ============================================================================
// Registration
// ============================================================================

export function registerDbCommands(program: Command): void {
  const db = program.command('db').description('Database management (pgserve)');

  db.command('status').description('Show pgserve health, port, data dir, and table counts').action(dbStatusCommand);

  db.command('migrate').description('Run pending database migrations').action(dbMigrateCommand);

  db.command('query <sql>').description('Execute arbitrary SQL and print results').action(dbQueryCommand);

  db.command('url')
    .description('Print postgres connection URL for direct access')
    .option('--quiet', 'Print URL only, no trailing newline (for scripts)')
    .action(async (options: { quiet?: boolean }) => {
      // Probe so isSocketMode() reflects the live connection, not the default
      // sentinel before the first connect. `db url` can run before any other
      // genie command in this process (e.g. wrapped in `psql $(genie db url)`).
      await isAvailable();
      let url: string;
      if (isSocketMode()) {
        // libpq URI form for Unix socket: postgresql:///<db>?host=<dir>
        const socketDir = resolvePgserveSocketDir();
        url = `postgresql:///postgres?host=${socketDir}`;
      } else {
        const port = getActivePort();
        url = `postgres://postgres:postgres@127.0.0.1:${port}/genie`;
      }
      if (options.quiet) {
        process.stdout.write(url);
      } else {
        console.log(url);
      }
      await shutdown();
    });

  db.command('prune-events')
    .description('Prune old runtime events beyond retention period')
    .option('--older-than <duration>', 'Delete events older than (e.g., 30d, 7d)', '14d')
    .option('--dry-run', 'Show count without deleting')
    .action(dbPruneEventsCommand);

  db.command('backup').description('Dump database to .genie/snapshot.sql.gz').action(dbBackupCommand);

  db.command('restore [file]')
    .description('Restore database from snapshot (default: .genie/snapshot.sql.gz)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(dbRestoreCommand);

  // v1 → v2 data migration (one-shot, idempotent)
  registerDbMigrateV1Command(db);

  // List all pgserve databases on this host
  registerDbLsCommand(db);
}
