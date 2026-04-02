/**
 * Import command — restore genie data from a schema-versioned JSON export.
 *
 * Commands:
 *   genie import <file> [--fail|--merge|--overwrite] [--groups <list>]
 *
 * Features:
 *   - Schema version validation
 *   - Conflict detection with 3 resolution modes
 *   - FK-ordered transactional insert (4 dependency levels)
 *   - Self-referential table handling (tasks.parent_id, messages.reply_to_id)
 *   - Audit logging on success
 *   - Selective import via --groups filter
 */

import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import type postgres from 'postgres';
import type { ConflictMode } from '../lib/export-format.js';
import { GROUP_TABLES, validateExportDocument } from '../lib/export-format.js';
import { SELF_REFERENTIAL_COLUMNS, getPrimaryKey, sortByImportOrder } from '../lib/import-order.js';

/** Canonical set of tables that can appear in an export/import document. */
const VALID_TABLES = new Set(Object.values(GROUP_TABLES).flat());

/** Throws if the table name is not in the export schema whitelist. */
export function assertValidTable(name: string): void {
  if (!VALID_TABLES.has(name)) {
    throw new Error(`Invalid table name: "${name}" is not in the schema whitelist`);
  }
}

type Sql = postgres.Sql;

/** Regex for valid SQL identifiers: starts with letter or underscore, then alphanumerics/underscores. */
const VALID_COLUMN_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validates a column name to prevent SQL injection via malicious JSON keys.
 * Rejects any name that isn't a plain alphanumeric identifier.
 */
export function assertValidColumnName(name: string): void {
  if (!VALID_COLUMN_RE.test(name)) {
    throw new Error(
      `Invalid column name: "${name.slice(0, 60)}" contains disallowed characters. Column names must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.`,
    );
  }
}

// ============================================================================
// Lazy loaders
// ============================================================================

async function getSql(): Promise<Sql> {
  const { getConnection } = await import('../lib/db.js');
  return getConnection();
}

async function getActorName(): Promise<string> {
  const { getActor } = await import('../lib/audit.js');
  return getActor();
}

async function detectTables(sql: Sql, tables: string[]): Promise<{ available: string[]; skipped: string[] }> {
  const { filterAvailableTables } = await import('../lib/table-detect.js');
  return filterAvailableTables(sql, tables);
}

// ============================================================================
// Conflict detection
// ============================================================================

async function detectConflicts(
  sql: Sql,
  table: string,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return [];
  assertValidTable(table);
  const pk = getPrimaryKey(table);

  if (pk.length === 1) {
    const key = pk[0];
    const ids = rows.map((r) => r[key]);
    const existing = await sql.unsafe(`SELECT ${key} FROM ${table} WHERE ${key} = ANY($1)`, [ids] as never[]);
    const existingSet = new Set((existing as Record<string, unknown>[]).map((r) => String(r[key])));
    return rows.filter((r) => existingSet.has(String(r[key])));
  }

  // Composite key — check each row individually
  const conflicts: Record<string, unknown>[] = [];
  for (const row of rows) {
    const conditions = pk.map((col, i) => `${col} = $${i + 1}`).join(' AND ');
    const values = pk.map((col) => row[col]) as never[];
    const existing = await sql.unsafe(`SELECT 1 FROM ${table} WHERE ${conditions} LIMIT 1`, values);
    if ((existing as unknown[]).length > 0) conflicts.push(row);
  }
  return conflicts;
}

// ============================================================================
// Insert helpers
// ============================================================================

interface PreparedRow {
  columns: string[];
  values: unknown[];
  quotedCols: string;
  placeholders: string;
}

function prepareRow(
  row: Record<string, unknown>,
  table: string,
  selfRefUpdates: { pk: unknown; value: unknown }[],
): PreparedRow {
  const selfRefCol = SELF_REFERENTIAL_COLUMNS[table];
  const entries = Object.entries(row);
  const columns = entries.map(([k]) => k);
  const values = entries.map(([, v]) => v);

  // Validate all column names before they touch SQL (defense against injection via JSON keys)
  for (const col of columns) {
    assertValidColumnName(col);
  }

  // Null out self-referential column for first pass
  if (selfRefCol && row[selfRefCol] != null) {
    const idx = columns.indexOf(selfRefCol);
    if (idx !== -1) {
      const originalSelfRef = values[idx];
      values[idx] = null;
      const pk = getPrimaryKey(table);
      selfRefUpdates.push({
        pk: pk.length === 1 ? row[pk[0]] : pk.map((k) => row[k]),
        value: originalSelfRef,
      });
    }
  }

  return {
    columns,
    values,
    quotedCols: columns.map((c) => `"${c}"`).join(', '),
    placeholders: values.map((_, i) => `$${i + 1}`).join(', '),
  };
}

async function insertOneRow(
  tx: Sql,
  table: string,
  row: Record<string, unknown>,
  prepared: PreparedRow,
  mode: ConflictMode,
): Promise<void> {
  assertValidTable(table);
  const { quotedCols, placeholders, values } = prepared;
  const pk = getPrimaryKey(table);

  if (mode === 'overwrite') {
    const pkCondition = pk.map((col, i) => `"${col}" = $${values.length + i + 1}`).join(' AND ');
    const pkValues = pk.map((col) => row[col]) as never[];
    await tx.unsafe(`DELETE FROM ${table} WHERE ${pkCondition}`, pkValues);
    await tx.unsafe(`INSERT INTO ${table} (${quotedCols}) VALUES (${placeholders})`, values as never[]);
  } else if (mode === 'merge') {
    const onConflict = pk.map((c) => `"${c}"`).join(', ');
    await tx.unsafe(
      `INSERT INTO ${table} (${quotedCols}) VALUES (${placeholders}) ON CONFLICT (${onConflict}) DO NOTHING`,
      values as never[],
    );
  } else {
    await tx.unsafe(`INSERT INTO ${table} (${quotedCols}) VALUES (${placeholders})`, values as never[]);
  }
}

async function updateSelfRefs(tx: Sql, table: string, updates: { pk: unknown; value: unknown }[]): Promise<void> {
  assertValidTable(table);
  const selfRefCol = SELF_REFERENTIAL_COLUMNS[table];
  const pk = getPrimaryKey(table);
  if (pk.length !== 1) return;
  for (const { pk: pkVal, value } of updates) {
    await tx.unsafe(`UPDATE ${table} SET "${selfRefCol}" = $1 WHERE "${pk[0]}" = $2`, [value, pkVal] as never[]);
  }
}

async function insertRows(
  tx: Sql,
  table: string,
  rows: Record<string, unknown>[],
  mode: ConflictMode,
): Promise<number> {
  if (rows.length === 0) return 0;

  const selfRefUpdates: { pk: unknown; value: unknown }[] = [];

  for (const row of rows) {
    const prepared = prepareRow(row, table, selfRefUpdates);
    await insertOneRow(tx, table, row, prepared, mode);
  }

  if (selfRefUpdates.length > 0) {
    await updateSelfRefs(tx, table, selfRefUpdates);
  }

  return rows.length;
}

// ============================================================================
// Main import logic
// ============================================================================

function parseExportFile(filePath: string) {
  const raw = readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${filePath}`);
  }
  const validation = validateExportDocument(parsed);
  if (!validation.valid) {
    throw new Error(`Invalid export document: ${validation.error}`);
  }
  return validation.doc;
}

async function filterTablesByGroup(allTables: string[], groupFilter?: string[]): Promise<string[]> {
  if (!groupFilter || groupFilter.length === 0) return allTables;
  const { GROUP_TABLES } = await import('../lib/export-format.js');
  const allowedTables = new Set<string>();
  for (const group of groupFilter) {
    const tables = GROUP_TABLES[group as keyof typeof GROUP_TABLES];
    if (tables) {
      for (const t of tables) allowedTables.add(t);
    } else {
      console.warn(`Warning: Unknown group "${group}", skipping`);
    }
  }
  return allTables.filter((t) => allowedTables.has(t));
}

async function checkConflicts(sql: Sql, tables: string[], data: Record<string, unknown[]>): Promise<void> {
  for (const table of tables) {
    const rows = data[table] as Record<string, unknown>[];
    if (!rows || rows.length === 0) continue;
    const conflicts = await detectConflicts(sql, table, rows);
    if (conflicts.length > 0) {
      const pk = getPrimaryKey(table);
      const ids = conflicts
        .slice(0, 5)
        .map((r) => pk.map((k) => r[k]).join(','))
        .join('; ');
      throw new Error(
        `Conflict in table "${table}": ${conflicts.length} existing row(s) (e.g., ${ids}). Use --merge or --overwrite to resolve.`,
      );
    }
  }
}

async function runImport(filePath: string, mode: ConflictMode, groupFilter?: string[]): Promise<void> {
  const doc = parseExportFile(filePath);

  let tablesToImport = await filterTablesByGroup(Object.keys(doc.data), groupFilter);
  if (tablesToImport.length === 0) {
    console.log('No tables to import.');
    return;
  }

  tablesToImport = sortByImportOrder(tablesToImport);

  const sql = await getSql();
  const { available } = await detectTables(sql, tablesToImport);
  const skippedTables = tablesToImport.filter((t) => !available.includes(t));
  tablesToImport = available;

  if (skippedTables.length > 0) {
    console.log(`Skipping tables not in database: ${skippedTables.join(', ')}`);
  }

  if (mode === 'fail') {
    await checkConflicts(sql, tablesToImport, doc.data);
  }

  let totalInserted = 0;
  const tableStats: Record<string, number> = {};

  // biome-ignore lint/suspicious/noExplicitAny: postgres.js TransactionSql loses call signatures via Omit
  await sql.begin(async (tx: any) => {
    for (const table of tablesToImport) {
      const rows = doc.data[table] as Record<string, unknown>[];
      if (!rows || rows.length === 0) continue;
      const count = await insertRows(tx as unknown as Sql, table, rows, mode);
      tableStats[table] = count;
      totalInserted += count;
    }
  });

  const actor = await getActorName();
  const { recordAuditEvent } = await import('../lib/audit.js');
  await recordAuditEvent('import', filePath, 'import_complete', actor, {
    mode,
    tables: tableStats,
    totalRows: totalInserted,
    skippedTables,
    sourceVersion: doc.version,
    sourceDate: doc.exportedAt,
  });

  // Report
  console.log(`Import complete: ${totalInserted} rows across ${Object.keys(tableStats).length} tables`);
  for (const [table, count] of Object.entries(tableStats)) {
    if (count > 0) console.log(`  ${table}: ${count} rows`);
  }
  if (skippedTables.length > 0) {
    console.log(`Skipped (not in DB): ${skippedTables.join(', ')}`);
  }
}

// ============================================================================
// Registration
// ============================================================================

export function registerImportCommands(program: Command): void {
  program
    .command('import <file>')
    .description('Import genie data from JSON export')
    .option('--fail', 'Abort on any conflict (default)')
    .option('--merge', 'Skip existing rows, import new ones')
    .option('--overwrite', 'Replace existing rows with imported data')
    .option('--groups <list>', 'Comma-separated groups to import (e.g., boards,tags)')
    .action(
      async (file: string, options: { fail?: boolean; merge?: boolean; overwrite?: boolean; groups?: string }) => {
        try {
          // Determine conflict mode
          let mode: ConflictMode = 'fail';
          if (options.overwrite) mode = 'overwrite';
          else if (options.merge) mode = 'merge';

          const groupFilter = options.groups?.split(',').map((g) => g.trim());

          await runImport(file, mode, groupFilter);
        } catch (error) {
          console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
          process.exit(1);
        }
      },
    );
}
