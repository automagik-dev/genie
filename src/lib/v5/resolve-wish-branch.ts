/**
 * Shared `wish/<slug>[-<group>]` branch resolution — the ONE implementation
 * every consumer uses. The board (`mcp-tools.ts`) resolves against genie.db
 * slugs; the SessionStart hook resolves against the same list read from
 * genie.db, falling back to the wish-file scan's slugs when the db is
 * unreadable. A second implementation is the drift class hooks-v2 exists to
 * kill, so this module is PURE: caller-supplied slugs, no sqlite import, no
 * filesystem, no environment — the esbuild hook bundle inlines it without ever
 * touching `bun:sqlite` (the hook runs as `node …/session-context.cjs`, where
 * `bun:sqlite` does not exist).
 */

export interface ResolvedWishBranch {
  wish: string;
  group: string | null;
}

/**
 * Resolve a `wish/<slug>[-<group>]` branch into `{ wish, group }`. Both slug and
 * group may contain hyphens, so a raw last-dash split is ambiguous
 * (`wish/genie-mcp` is the `genie-mcp` wish with no group, NOT a `genie` wish
 * with an `mcp` group). Disambiguate against the known slugs, most-authoritative
 * first:
 *   1. exact known slug → top-level branch, group = null;
 *   2. longest known slug that is a prefix + `-<group>` (group unverified);
 *   3. no known wish (brand-new branch) → last-dash heuristic, else whole rest.
 * Returns `null` only when the branch is not a `wish/…` branch.
 *
 * The caller supplies `knownSlugs` longest-first (`listWishSlugs` orders it; the
 * hook re-sorts its merged db/file slug list). There is no
 * verified-launch-worktree step: wish-group rows are production-dead (no
 * writer), so a `<slug>-<group>` branch can never be confirmed against a live
 * group — the group is taken at face value from the branch name.
 */
export function resolveWishBranch(knownSlugs: readonly string[], branch: string): ResolvedWishBranch | null {
  const rest = branch.startsWith('wish/') ? branch.slice('wish/'.length) : null;
  if (!rest) return null;
  // 1. Exact known slug → top-level branch (no group).
  if (knownSlugs.includes(rest)) return { wish: rest, group: null };
  // 2. Longest known slug that is a prefix (group unverified) → best guess.
  for (const slug of knownSlugs) {
    if (rest.startsWith(`${slug}-`)) {
      const group = rest.slice(slug.length + 1);
      if (group) return { wish: slug, group };
    }
  }
  // 3. No known wish yet → last-dash heuristic, else the whole rest as the wish.
  const dash = rest.lastIndexOf('-');
  if (dash > 0 && dash < rest.length - 1) return { wish: rest.slice(0, dash), group: rest.slice(dash + 1) };
  return { wish: rest, group: null };
}
