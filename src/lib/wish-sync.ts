/**
 * Wish Sync — sync .genie/wishes/ from filesystem to PG for cross-repo querying.
 *
 * WISH.md files are the source of truth. PG is the index.
 * Sync is idempotent — multiple runs don't create duplicates.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getConnection } from './db.js';

const REPOS_BASE = '/home/genie/workspace/repos';

// ============================================================================
// Status Parsing
// ============================================================================

/**
 * Parse the Status field from a WISH.md markdown table.
 * Looks for `| **Status** | <value> |` pattern.
 */
export function parseWishStatus(content: string): string {
  const match = content.match(/\|\s*\*\*Status\*\*\s*\|\s*([^|]+)/i);
  if (match) return match[1].trim();
  return 'DRAFT';
}

// ============================================================================
// Filesystem Scanning
// ============================================================================

interface DiscoveredWish {
  slug: string;
  repo: string;
  namespace: string;
  status: string;
  filePath: string;
}

/**
 * Scan a single repo for wishes in .genie/wishes/\*\/WISH.md.
 */
function scanRepoWishes(repoPath: string): DiscoveredWish[] {
  const wishesDir = join(repoPath, '.genie', 'wishes');
  if (!existsSync(wishesDir)) return [];

  const results: DiscoveredWish[] = [];
  const namespace = basename(repoPath);

  try {
    const entries = readdirSync(wishesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wishPath = join(wishesDir, entry.name, 'WISH.md');
      if (!existsSync(wishPath)) continue;

      try {
        const content = readFileSync(wishPath, 'utf-8');
        results.push({
          slug: entry.name,
          repo: repoPath,
          namespace,
          status: parseWishStatus(content),
          filePath: wishPath,
        });
      } catch {
        // Unreadable file — skip
      }
    }
  } catch {
    // Can't read wishes dir — skip
  }

  return results;
}

/**
 * Discover all wishes across all repos in REPOS_BASE, or a single repo.
 */
function discoverWishes(repoPath?: string): DiscoveredWish[] {
  if (repoPath) return scanRepoWishes(repoPath);

  if (!existsSync(REPOS_BASE)) return [];

  const results: DiscoveredWish[] = [];
  try {
    const entries = readdirSync(REPOS_BASE, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      results.push(...scanRepoWishes(join(REPOS_BASE, entry.name)));
    }
  } catch {
    // Can't read repos base — return empty
  }

  return results;
}

// ============================================================================
// PG Sync
// ============================================================================

/**
 * Sync wishes from filesystem to PG.
 * Upserts discovered wishes — idempotent.
 *
 * @param repoPath - If provided, only sync wishes from this repo. Otherwise scan all repos.
 */
export async function syncWishes(repoPath?: string): Promise<number> {
  const wishes = discoverWishes(repoPath);
  if (wishes.length === 0) return 0;

  const sql = await getConnection();

  for (const wish of wishes) {
    await sql`
      INSERT INTO wishes (slug, repo, namespace, status, file_path)
      VALUES (${wish.slug}, ${wish.repo}, ${wish.namespace}, ${wish.status}, ${wish.filePath})
      ON CONFLICT (slug, repo) DO UPDATE SET
        namespace = EXCLUDED.namespace,
        status = EXCLUDED.status,
        file_path = EXCLUDED.file_path,
        updated_at = now()
    `;
  }

  return wishes.length;
}

// ============================================================================
// Queries
// ============================================================================

interface WishRow {
  id: number;
  slug: string;
  repo: string;
  namespace: string | null;
  status: string;
  file_path: string;
  created_at: string;
  updated_at: string;
}

/**
 * List wishes from PG with optional filters.
 */
export async function listWishes(filters?: {
  repo?: string;
  status?: string;
  namespace?: string;
}): Promise<WishRow[]> {
  const sql = await getConnection();

  if (filters?.repo && filters?.status) {
    return sql`SELECT * FROM wishes WHERE repo = ${filters.repo} AND status = ${filters.status} ORDER BY updated_at DESC`;
  }
  if (filters?.repo) {
    return sql`SELECT * FROM wishes WHERE repo = ${filters.repo} ORDER BY updated_at DESC`;
  }
  if (filters?.status) {
    return sql`SELECT * FROM wishes WHERE status = ${filters.status} ORDER BY updated_at DESC`;
  }
  if (filters?.namespace) {
    return sql`SELECT * FROM wishes WHERE namespace = ${filters.namespace} ORDER BY updated_at DESC`;
  }

  return sql`SELECT * FROM wishes ORDER BY updated_at DESC`;
}

/**
 * Get a single wish by slug, optionally scoped to a repo.
 */
export async function getWish(slug: string, repo?: string): Promise<WishRow | null> {
  const sql = await getConnection();

  const rows = repo
    ? await sql`SELECT * FROM wishes WHERE slug = ${slug} AND repo = ${repo} LIMIT 1`
    : await sql`SELECT * FROM wishes WHERE slug = ${slug} ORDER BY updated_at DESC LIMIT 1`;

  return rows.length > 0 ? (rows[0] as WishRow) : null;
}
