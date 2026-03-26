/**
 * Agent Cache — Maintains agent-directory.json as a cache of app_store agents.
 *
 * Also provides generic CRUD helpers for the `app_store` table (register,
 * remove, update, get, list). The cache file is a denormalised snapshot
 * written to GENIE_HOME so that non-PG consumers (hooks, shell scripts)
 * can read agent metadata without a database connection.
 *
 * Best-effort: DB failures never block the CLI.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getActor, recordAuditEvent } from './audit.js';
import { getConnection, isAvailable } from './db.js';

// ============================================================================
// Constants
// ============================================================================

const GENIE_HOME = process.env.GENIE_HOME ?? join(homedir(), '.genie');
const CACHE_FILE = 'agent-directory.json';
const CACHE_BACKUP = 'agent-directory.json.bak';

// ============================================================================
// Types
// ============================================================================

/** Denormalised cache entry written to agent-directory.json. */
interface CacheEntry {
  name: string;
  dir: string;
  repo?: string;
  promptMode: string;
  model?: string;
  roles?: string[];
  registeredAt: string;
}

/** Row shape returned by SELECT * FROM app_store. */
export interface StoreRow {
  id: string;
  name: string;
  item_type: string;
  version: string;
  description: string | null;
  author_name: string | null;
  author_url: string | null;
  git_url: string | null;
  install_path: string | null;
  manifest: Record<string, unknown>;
  approval_status: string;
  tags: string[];
  category: string | null;
  license: string | null;
  dependencies: string[];
  installed_at: string;
  updated_at: string;
}

/** Insert payload for registerItemInStore. */
interface StoreInsert {
  name: string;
  itemType: string;
  version?: string;
  description?: string;
  authorName?: string;
  authorUrl?: string;
  gitUrl?: string;
  installPath?: string;
  manifest?: Record<string, unknown>;
  tags?: string[];
  category?: string;
  license?: string;
  dependencies?: string[];
}

// ============================================================================
// Cache regeneration
// ============================================================================

/**
 * Rebuild agent-directory.json from all `item_type = 'agent'` rows in app_store.
 *
 * Silently returns if the database is unavailable — the stale cache (if any)
 * remains on disk until the next successful regeneration.
 */
export async function regenerateAgentCache(): Promise<void> {
  try {
    if (!(await isAvailable())) return;

    const sql = await getConnection();
    const rows = await sql`
      SELECT name, install_path, manifest, installed_at
      FROM app_store
      WHERE item_type = 'agent'
      ORDER BY name
    `;

    const entries: CacheEntry[] = rows.map((r: Record<string, unknown>) => {
      const manifest = (r.manifest ?? {}) as Record<string, unknown>;
      const entry: CacheEntry = {
        name: r.name as string,
        dir: (r.install_path as string) ?? '',
        promptMode: (manifest.promptMode as string) ?? 'append',
        registeredAt: r.installed_at ? new Date(r.installed_at as string).toISOString() : new Date().toISOString(),
      };
      if (manifest.repo) entry.repo = manifest.repo as string;
      if (manifest.model) entry.model = manifest.model as string;
      if (Array.isArray(manifest.roles) && manifest.roles.length > 0) {
        entry.roles = manifest.roles as string[];
      }
      return entry;
    });

    writeFileSync(join(GENIE_HOME, CACHE_FILE), JSON.stringify(entries, null, 2));
  } catch {
    // Best effort — never block the CLI on cache regeneration failure
  }
}

// ============================================================================
// One-time migration from JSON → PG
// ============================================================================

/**
 * Migrate the legacy agent-directory.json into the app_store table.
 *
 * Idempotent: skips if the backup file already exists (meaning migration
 * already ran) or if the source file is missing (nothing to migrate).
 * Uses ON CONFLICT (name) DO NOTHING so partially-completed runs are safe.
 */
export async function migrateAgentDirectory(): Promise<void> {
  const sourcePath = join(GENIE_HOME, CACHE_FILE);
  const backupPath = join(GENIE_HOME, CACHE_BACKUP);

  // Already migrated or nothing to migrate
  if (existsSync(backupPath) || !existsSync(sourcePath)) return;

  try {
    const raw = readFileSync(sourcePath, 'utf-8');
    const entries: CacheEntry[] = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length === 0) return;

    const sql = await getConnection();

    for (const entry of entries) {
      const manifest: Record<string, unknown> = {};
      if (entry.promptMode) manifest.promptMode = entry.promptMode;
      if (entry.model) manifest.model = entry.model;
      if (entry.roles) manifest.roles = entry.roles;
      if (entry.repo) manifest.repo = entry.repo;

      await sql`
        INSERT INTO app_store (name, item_type, version, install_path, manifest)
        VALUES (${entry.name}, 'agent', '0.0.0', ${entry.dir ?? null}, ${sql.json(manifest)})
        ON CONFLICT (name) DO NOTHING
      `;
    }

    renameSync(sourcePath, backupPath);

    await recordAuditEvent('item', 'migration', 'agent_directory_migrated', getActor(), {
      count: entries.length,
    });
  } catch {
    // Best effort — migration can be retried on the next run
  }
}

// ============================================================================
// CRUD helpers for app_store
// ============================================================================

/**
 * Insert a new item into the app_store. Returns the generated id.
 *
 * Throws if an item with the same name already exists — callers should
 * check beforehand or use `--force` to remove + re-insert.
 */
export async function registerItemInStore(item: StoreInsert): Promise<string> {
  const sql = await getConnection();

  const rows = await sql`
    INSERT INTO app_store (
      name, item_type, version, description,
      author_name, author_url, git_url, install_path,
      manifest, tags, category, license, dependencies
    ) VALUES (
      ${item.name},
      ${item.itemType},
      ${item.version ?? '0.0.0'},
      ${item.description ?? null},
      ${item.authorName ?? null},
      ${item.authorUrl ?? null},
      ${item.gitUrl ?? null},
      ${item.installPath ?? null},
      ${sql.json(item.manifest ?? {})},
      ${item.tags ?? []},
      ${item.category ?? null},
      ${item.license ?? null},
      ${item.dependencies ?? []}
    )
    RETURNING id
  `;

  if (rows.length === 0) {
    throw new Error(`Failed to insert item "${item.name}" — no id returned.`);
  }

  return rows[0].id as string;
}

/**
 * Delete an item from the app_store by name.
 *
 * @returns true if an item was deleted, false if no matching item was found.
 */
export async function removeItemFromStore(name: string): Promise<boolean> {
  const sql = await getConnection();
  const result = await sql`DELETE FROM app_store WHERE name = ${name}`;
  return result.count > 0;
}

/**
 * Update an existing item in the app_store by name.
 * Only provided fields are updated; updated_at is always set to now().
 *
 * @returns true if the item was updated, false if no matching item was found.
 */
export async function updateItemInStore(name: string, updates: Partial<StoreInsert>): Promise<boolean> {
  const sql = await getConnection();

  const s: Record<string, unknown> = {};
  if (updates.name !== undefined) s.name = updates.name;
  if (updates.itemType !== undefined) s.item_type = updates.itemType;
  if (updates.version !== undefined) s.version = updates.version;
  if (updates.description !== undefined) s.description = updates.description;
  if (updates.authorName !== undefined) s.author_name = updates.authorName;
  if (updates.authorUrl !== undefined) s.author_url = updates.authorUrl;
  if (updates.gitUrl !== undefined) s.git_url = updates.gitUrl;
  if (updates.installPath !== undefined) s.install_path = updates.installPath;
  if (updates.manifest !== undefined) s.manifest = sql.json(updates.manifest);
  if (updates.tags !== undefined) s.tags = updates.tags;
  if (updates.category !== undefined) s.category = updates.category;
  if (updates.license !== undefined) s.license = updates.license;
  if (updates.dependencies !== undefined) s.dependencies = updates.dependencies;

  if (Object.keys(s).length === 0) return false;

  s.updated_at = sql`now()`;
  const result = await sql`UPDATE app_store SET ${sql(s)} WHERE name = ${name}`;
  return result.count > 0;
}

/**
 * Fetch a single item from the app_store by name.
 *
 * @returns the row or null if not found.
 */
export async function getItemFromStore(name: string): Promise<StoreRow | null> {
  const sql = await getConnection();
  const rows = await sql`SELECT * FROM app_store WHERE name = ${name}`;
  return rows.length > 0 ? (rows[0] as unknown as StoreRow) : null;
}

/**
 * List items from the app_store, optionally filtered by item_type.
 *
 * @param itemType - When provided, only rows matching this type are returned.
 * @returns rows ordered by name.
 */
export async function listItemsFromStore(itemType?: string): Promise<StoreRow[]> {
  const sql = await getConnection();

  const rows = itemType
    ? await sql`SELECT * FROM app_store WHERE item_type = ${itemType} ORDER BY name`
    : await sql`SELECT * FROM app_store ORDER BY name`;

  return rows as unknown as StoreRow[];
}
