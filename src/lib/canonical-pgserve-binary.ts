/**
 * Canonical pgserve binary resolver.
 *
 * The autopg-distribution-cutover-finalize wish (autopg repo) renamed the
 * published v3 binary from `pgserve` to `autopg`. Both binaries expose an
 * identical command surface (`install`, `port`, `url`, `status`, `restart`);
 * only the on-disk name differs. Genie consumers (install.ts, db.ts) used
 * to hardcode `'pgserve'` everywhere — that broke `genie install` on every
 * v3 host that only had `autopg` on PATH, and pointed users at the obsolete
 * `bun add -g pgserve@^2` recovery command. This module is the single
 * resolver every consumer routes through.
 *
 * Resolution policy:
 *   - Prefer `autopg` (v3 canonical) when present.
 *   - Fall back to `pgserve` (v2 legacy) for hosts mid-cutover.
 *   - Return null when neither is on PATH — caller surfaces an actionable
 *     install hint via {@link canonicalPgserveInstallHint}.
 *
 * The pm2 process-name layer is orthogonal: v3 supervises under
 * `autopg-server`, v2 under `pgserve`. The `PGSERVE_PM2_PROCESS_NAMES`
 * constant in install.ts already checks both.
 */

import { execFileSync } from 'node:child_process';

export const CANONICAL_PGSERVE_BINARY = 'autopg';
export const LEGACY_PGSERVE_BINARY = 'pgserve';

let cached: string | null | undefined;

function which(cmd: string): string | null {
  try {
    const result = execFileSync('which', [cmd], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the canonical pgserve binary on this host. Memoized — the first
 * call probes PATH; subsequent calls return the cached answer. Tests can
 * invalidate via {@link _resetPgserveBinaryCache}.
 */
export function resolvePgserveBinary(): string | null {
  if (cached !== undefined) return cached;
  if (which(CANONICAL_PGSERVE_BINARY)) {
    cached = CANONICAL_PGSERVE_BINARY;
    return cached;
  }
  if (which(LEGACY_PGSERVE_BINARY)) {
    cached = LEGACY_PGSERVE_BINARY;
    return cached;
  }
  cached = null;
  return cached;
}

/**
 * Copy-paste recovery commands for the "binary not found" path. Points at
 * the autopg v3 installer; ordered so the operator runs them top-to-bottom.
 */
export function canonicalPgserveInstallHint(): string[] {
  return [
    '  curl -fsSL https://raw.githubusercontent.com/automagik-dev/autopg/main/install.sh | bash',
    '  genie install',
  ];
}

/** Reset memoization. Test-only. */
export function _resetPgserveBinaryCache(): void {
  cached = undefined;
}
