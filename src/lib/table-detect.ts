/**
 * Table detection — check which tables exist in the connected database.
 *
 * Used by export/import to gracefully skip tables that don't exist
 * (e.g., KhalOS-specific tables on a pure genie install).
 */

import type postgres from 'postgres';

type Sql = postgres.Sql;

/**
 * Get all user tables in the current schema (excludes system tables and migration tracker).
 */
async function getAvailableTables(sql: Sql): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_type = 'BASE TABLE'
      AND table_name NOT LIKE '_genie_%'
    ORDER BY table_name
  `;
  return rows.map((r) => r.table_name);
}

/**
 * Filter a list of requested tables to only those that exist.
 * Returns { available, skipped } so callers can log what was skipped.
 */
export async function filterAvailableTables(
  sql: Sql,
  requested: string[],
): Promise<{ available: string[]; skipped: string[] }> {
  const existing = new Set(await getAvailableTables(sql));
  const available: string[] = [];
  const skipped: string[] = [];
  for (const table of requested) {
    if (existing.has(table)) {
      available.push(table);
    } else {
      skipped.push(table);
    }
  }
  return { available, skipped };
}
