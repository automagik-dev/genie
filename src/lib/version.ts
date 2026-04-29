/**
 * Version — reads from package.json at runtime so `genie update` reflects the
 * new version.
 *
 * Closes #1464.
 *
 * Previous resolver tried fixed `..` / `../..` relative paths from
 * `import.meta.dir` and used the FIRST package.json that existed. That broke
 * in worktree contexts: when the binary runs from
 * `<repo>/.worktrees/<name>/dist/genie.js`, the `../..` candidate resolves to
 * `<repo>/package.json` (the *parent* repo, often a different version) before
 * the `..` candidate would have found `<repo>/.worktrees/<name>/package.json`
 * (the actual binary's package). On a dogfood box this surfaced as
 * `genie --version` reporting 4.260428.16 while the worktree itself was
 * 4.260428.19.
 *
 * Fix: walk UP from the binary's location and return the version of the
 * FIRST package.json whose `name === "@automagik/genie"`. This guarantees
 * we identify our own package no matter how deep the binary lives.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const FALLBACK_VERSION = '0.0.0-unknown';
const PACKAGE_NAME = '@automagik/genie';
/** Hard cap on how many parent dirs we walk before giving up. Bounded
 *  to prevent runaway scans on filesystems with no genie root reachable. */
const MAX_WALK_DEPTH = 10;

interface PackageJson {
  name?: string;
  version?: string;
}

function readPackageJson(path: string): PackageJson | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as PackageJson;
  } catch {
    return null;
  }
}

function readVersionFromPackageJson(): string {
  const startDir = dirname(import.meta.dir ?? __dirname);

  // Walk up from the binary's location, return the first package.json whose
  // `name` matches ours. This is worktree-aware: a binary in
  // <repo>/.worktrees/<name>/dist will find <repo>/.worktrees/<name>/package.json
  // (1 level up) before continuing to <repo>/package.json (3 levels up) —
  // and only the first one whose name matches counts as ours.
  let current = startDir;
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    const candidate = resolve(current, 'package.json');
    const pkg = readPackageJson(candidate);
    if (pkg?.name === PACKAGE_NAME && pkg.version) {
      return pkg.version;
    }
    const parent = dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }

  // Fallback: same walk but accept ANY package.json with a version field.
  // This catches edge cases like running directly from a tarball where
  // `name` may be unset, and preserves the prior resolver's lenience.
  current = startDir;
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    const candidate = resolve(current, 'package.json');
    const pkg = readPackageJson(candidate);
    if (pkg?.version) return pkg.version;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return FALLBACK_VERSION;
}

export const VERSION = readVersionFromPackageJson();
