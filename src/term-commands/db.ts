/**
 * Database commands — CLI interface for pgserve management.
 *
 * Commands:
 *   genie db status  — show pgserve health, port, data dir, table counts, migration status
 *   genie db migrate — run pending migrations, show results
 *   genie db query   — execute arbitrary SQL, print results as table
 */

import type { Command } from 'commander';
import { getMigrationStatus, runMigrations } from '../lib/db-migrations.js';
import { getActivePort, getConnection, getDataDir, isAvailable, shutdown } from '../lib/db.js';
import { padRight } from '../lib/term-format.js';

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
 * `genie db status` — show pgserve health, connection details, table counts.
 */
async function dbStatusCommand(): Promise<void> {
  const port = getActivePort();
  const dataDir = getDataDir();

  console.log('\nGenie Database Status');
  console.log('─'.repeat(50));
  console.log(`  Port:     ${port}`);
  console.log('  Host:     127.0.0.1');
  console.log(`  Data dir: ${dataDir}`);

  const available = await isAvailable();
  if (!available) {
    console.log('  Status:   stopped');
    console.log('\n  pgserve is not running. It will auto-start on first use.');
    console.log('');
    return;
  }

  console.log('  Status:   running');

  try {
    const sql = await getConnection();

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
    .action((options: { quiet?: boolean }) => {
      const port = getActivePort();
      const url = `postgres://postgres:postgres@127.0.0.1:${port}/genie`;
      if (options.quiet) {
        process.stdout.write(url);
      } else {
        console.log(url);
      }
    });
}
