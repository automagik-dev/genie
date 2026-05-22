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
import { EMBEDDED_MIGRATIONS } from '../db/migrations.generated.js';

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
  return join(dirname(import.meta.dir), 'src', 'db', 'migrations');
}

/**
 * Load all .sql migrations sorted by name.
 *
 * Primary source: `EMBEDDED_MIGRATIONS` — static `with { type: 'text' }`
 * imports that `bun build --compile` embeds into the binary. The previous
 * readdirSync/Bun.file() approach read from disk relative to
 * import.meta.dir, which inside the compiled executable resolves to an
 * empty/absent `/$bunfs/...` path → zero migrations → "Applied: 0" on a
 * fresh DB → schema never created (the bug that blocked native
 * genie → pgserve-v3 migration).
 *
 * The on-disk scan is kept ONLY as a dev fallback (running from source
 * with an unbuilt manifest); the embedded list is authoritative whenever
 * present, which is always true in a shipped binary.
 */
async function loadMigrationFiles(): Promise<MigrationFile[]> {
  if (EMBEDDED_MIGRATIONS.length > 0) {
    return EMBEDDED_MIGRATIONS.map((m) => ({ name: m.name, sql: m.sql })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }

  // Dev-only fallback: source checkout whose manifest hasn't been generated.
  const candidates = [
    getMigrationsDir(), // dev: src/lib/../db/migrations
    getPackageRootMigrationsDir(), // bundled: dist/../src/db/migrations
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
  if (pending.length === 0) return [];

  // Defensive: ensure _genie_migrations_id_seq is sane before INSERTing.
  // Hosts that restored from a pg_dump may have the sequence stuck at its
  // initial value while the table holds rows with high explicit ids; the
  // next IDENTITY-generated id would collide with an existing PK. We
  // observed this on khal-os 2026-05-22 where the sequence was at 48 with
  // 63 rows applied, blocking every PG-touching CLI command with
  // `duplicate key value violates unique constraint "_genie_migrations_pkey"`.
  // The canonical fix is `rebalanceIdentitySequences` (run by `restore()`
  // post-pg_dump cutover), but a defensive `setval()` here unblocks any
  // host that already drifted — without forcing them to re-restore.
  await sql.unsafe(`SELECT setval(
    '_genie_migrations_id_seq',
    GREATEST(COALESCE((SELECT MAX(id) FROM _genie_migrations), 0), 1),
    COALESCE((SELECT MAX(id) FROM _genie_migrations), 0) > 0
  )`);

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
