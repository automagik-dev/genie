/**
 * Database migration runner for genie.
 *
 * Reads SQL files from src/db/migrations/ in lexicographic order.
 * Tracks applied migrations in the `_genie_migrations` table.
 *
 * Usage:
 *   import { runMigrations, getMigrationStatus } from './db-migrations.js';
 *   await runMigrations(sql);   // apply all pending
 *   await getMigrationStatus(sql); // list applied + pending
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type postgres from 'postgres';

type Sql = postgres.Sql;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MigrationRecord {
  name: string;
  applied_at: string | null; // ISO timestamp if applied, null if pending
}

interface MigrationStatus {
  applied: MigrationRecord[];
  pending: MigrationRecord[];
}

interface MigrationFile {
  name: string;
  sql: string;
}

// ---------------------------------------------------------------------------
// Migration file loading
// ---------------------------------------------------------------------------

/** Resolve the migrations directory relative to this module. */
function getMigrationsDir(): string {
  // import.meta.dir → src/lib/ in dev, dist/ when bundled
  // Migrations live at src/db/migrations/ → ../db/migrations relative to src/lib/
  return join(import.meta.dir, '..', 'db', 'migrations');
}

/** Resolve migrations dir relative to the package root (for bundled/global installs). */
function getPackageRootMigrationsDir(): string {
  // In a bundled build, import.meta.dir points to dist/.
  // The package root is one level up from dist/, and migrations are at src/db/migrations/.
  // Also handles: import.meta.dir = src/lib/ → ../../src/db/migrations (redundant but harmless).
  return join(dirname(import.meta.dir), 'src', 'db', 'migrations');
}

/**
 * Load all .sql migration files sorted by name.
 * Searches multiple candidate directories to handle dev, bundled, and global-install layouts.
 */
async function loadMigrationFiles(): Promise<MigrationFile[]> {
  const candidates = [
    getMigrationsDir(), // dev: src/lib/../db/migrations
    getPackageRootMigrationsDir(), // bundled: dist/../src/db/migrations
    join(process.cwd(), 'src', 'db', 'migrations'), // legacy fallback
  ];

  for (const dir of candidates) {
    try {
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      if (files.length === 0) continue;

      const migrations: MigrationFile[] = [];
      for (const file of files) {
        const content = await Bun.file(join(dir, file)).text();
        migrations.push({
          name: file.replace(/\.sql$/, ''),
          sql: content,
        });
      }
      return migrations;
    } catch {
      // directory not found — try next candidate
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Bootstrap — ensure _genie_migrations table exists
// ---------------------------------------------------------------------------

async function ensureMigrationsTable(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _genie_migrations (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all pending migrations in order.
 * Each migration runs in its own transaction. If a migration fails,
 * subsequent migrations are skipped and the error is thrown.
 */
export async function runMigrations(sql: Sql): Promise<MigrationRecord[]> {
  await ensureMigrationsTable(sql);

  const files = await loadMigrationFiles();
  if (files.length === 0) return [];

  // Get already-applied migrations
  const applied = await sql<{ name: string }[]>`
    SELECT name FROM _genie_migrations ORDER BY name
  `;
  const appliedSet = new Set(applied.map((r) => r.name));

  const pending = files.filter((f) => !appliedSet.has(f.name));
  const results: MigrationRecord[] = [];

  for (const migration of pending) {
    await sql.begin(async (tx) => {
      await tx.unsafe(migration.sql);
      await tx.unsafe('INSERT INTO _genie_migrations (name) VALUES ($1)', [migration.name]);
    });
    results.push({ name: migration.name, applied_at: new Date().toISOString() });
  }

  return results;
}

/**
 * Get the status of all migrations — which are applied and which are pending.
 */
export async function getMigrationStatus(sql: Sql): Promise<MigrationStatus> {
  await ensureMigrationsTable(sql);

  const files = await loadMigrationFiles();

  const applied = await sql<{ name: string; applied_at: Date }[]>`
    SELECT name, applied_at FROM _genie_migrations ORDER BY name
  `;
  const appliedMap = new Map(applied.map((r) => [r.name, r.applied_at.toISOString()]));

  const appliedRecords: MigrationRecord[] = [];
  const pendingRecords: MigrationRecord[] = [];

  for (const file of files) {
    const appliedAt = appliedMap.get(file.name);
    if (appliedAt) {
      appliedRecords.push({ name: file.name, applied_at: appliedAt });
    } else {
      pendingRecords.push({ name: file.name, applied_at: null });
    }
  }

  return { applied: appliedRecords, pending: pendingRecords };
}
