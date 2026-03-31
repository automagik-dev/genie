/**
 * Wish Resolution — resolve namespace/slug references to concrete paths.
 *
 * Convention: `{namespace}/{slug}` where namespace = repo basename.
 * Repos live at /home/genie/workspace/repos/{namespace}.
 * WISH.md lives at {repo}/.genie/wishes/{slug}/WISH.md.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepoSession } from './tmux.js';

const REPOS_BASE = '/home/genie/workspace/repos';

// ============================================================================
// Types
// ============================================================================

export interface WishRef {
  namespace?: string;
  slug: string;
}

export interface ResolvedWish {
  repo: string;
  wishPath: string;
  session: string;
  slug: string;
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse a wish reference string into namespace and slug.
 *
 * Formats:
 *   "namespace/slug"  → { namespace: "namespace", slug: "slug" }
 *   "slug"            → { slug: "slug" }
 *
 * Only the first `/` is used as delimiter — slugs may not contain `/`.
 */
export function parseWishRef(ref: string): WishRef {
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new Error('Wish reference cannot be empty');
  }

  const slashIndex = trimmed.indexOf('/');
  if (slashIndex === -1) {
    return { slug: trimmed };
  }

  const namespace = trimmed.slice(0, slashIndex);
  const slug = trimmed.slice(slashIndex + 1);

  if (!namespace) {
    throw new Error(`Invalid wish reference "${ref}": namespace is empty`);
  }
  if (!slug) {
    throw new Error(`Invalid wish reference "${ref}": slug is empty`);
  }
  if (slug.includes('/')) {
    throw new Error(`Invalid wish reference "${ref}": slug cannot contain "/"`);
  }

  return { namespace, slug };
}

// ============================================================================
// Resolution
// ============================================================================

/**
 * Resolve a wish reference to a concrete repo path, wish path, and tmux session.
 *
 * @param ref - Wish reference in "namespace/slug" or "slug" format
 * @returns Resolved wish with repo, wishPath, session, and slug
 * @throws If repo not found, wish not found, or bare slug without namespace
 */
export async function resolveWish(ref: string): Promise<ResolvedWish> {
  const parsed = parseWishRef(ref);

  if (!parsed.namespace) {
    // Bare slug — check cwd first
    const cwdWishPath = join(process.cwd(), '.genie', 'wishes', parsed.slug, 'WISH.md');
    if (existsSync(cwdWishPath)) {
      const repo = process.cwd();
      const session = await resolveRepoSession(repo);
      return {
        repo,
        wishPath: cwdWishPath,
        session,
        slug: parsed.slug,
      };
    }

    throw new Error(
      `Wish "${parsed.slug}" not found in current directory. Use namespace/slug format (e.g., genie/${parsed.slug}) to specify the repo.`,
    );
  }

  // Namespace provided — resolve repo
  const repo = join(REPOS_BASE, parsed.namespace);
  if (!existsSync(repo)) {
    throw new Error(`Repository "${parsed.namespace}" not found at ${repo}. Available repos are in ${REPOS_BASE}.`);
  }

  // Verify WISH.md exists
  const wishPath = join(repo, '.genie', 'wishes', parsed.slug, 'WISH.md');
  if (!existsSync(wishPath)) {
    throw new Error(`Wish "${parsed.slug}" not found in repo "${parsed.namespace}". Expected: ${wishPath}`);
  }

  const session = await resolveRepoSession(repo);

  return {
    repo,
    wishPath,
    session,
    slug: parsed.slug,
  };
}
