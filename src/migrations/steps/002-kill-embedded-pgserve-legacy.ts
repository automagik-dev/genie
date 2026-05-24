/**
 * Migration 002 — kill legacy embedded pgserve listening on a non-canonical port.
 *
 * Detection: a postgres process owned by the current user is listening on a
 * port OTHER than the one the canonical pgserve actually binds, AND that
 * canonical pgserve is reachable, AND no user-intent override
 * (env var GENIE_KEEP_LEGACY_PG=1).
 *
 * The canonical port is DISCOVERED from the autopg/pgserve binary at runtime —
 * never hardcoded. The canonical backbone moved 8432 → 5432 in the
 * autopg-v3 / socket-singleton cutover; a hardcoded 8432 here would (a) be a
 * no-op on healthy 5432 hosts and, worse, (b) during a mixed window where a
 * stray legacy postmaster is still live on 8432 alongside canonical 5432,
 * mistake 8432 for canonical and STOP the real 5432 backbone. Discovering the
 * port fixes both. When no canonical binary is installed / it can't report a
 * port, this migration is a safe no-op: we never stop a postmaster we cannot
 * positively distinguish from canonical.
 *
 * Fix: send graceful pg_ctl stop to the legacy process; if that fails,
 * SIGTERM. Migration 001 (must run first) ensures genie-serve no longer
 * spawns it, so it stays dead.
 */

import { execFileSync, execSync } from 'node:child_process';

import { resolvePgserveBinary } from '../../lib/canonical-pgserve-binary.js';
import type { MigrationContext } from '../discover.js';

export const id = '002-kill-embedded-pgserve-legacy';
export const description = 'Stop legacy embedded pgserve on non-canonical ports when canonical is healthy';

interface ListeningPg {
  pid: number;
  port: number;
}

let canonicalPortCache: number | null | undefined;

/**
 * Resolve the port the canonical pgserve actually binds by asking the
 * autopg/pgserve binary (`<bin> status --json` → `.port`). Memoized for the
 * duration of the migration run. Returns null when no canonical binary is
 * installed or it doesn't report a numeric port.
 */
function resolveCanonicalPort(): number | null {
  if (canonicalPortCache !== undefined) return canonicalPortCache;
  const bin = resolvePgserveBinary();
  if (!bin) {
    canonicalPortCache = null;
    return null;
  }
  try {
    const out = execFileSync(bin, ['status', '--json'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const port = Number((JSON.parse(out) as { port?: unknown }).port);
    canonicalPortCache = Number.isFinite(port) ? port : null;
  } catch {
    canonicalPortCache = null;
  }
  return canonicalPortCache;
}

/** Test-only: clear the memoized canonical port. */
export function _resetCanonicalPortCache(): void {
  canonicalPortCache = undefined;
}

function listListeningPgserve(): ListeningPg[] {
  try {
    const out = execSync('ss -tlnp', { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    const out_lines = out.split('\n');
    const found: ListeningPg[] = [];
    const seen = new Set<number>();
    for (const line of out_lines) {
      // Match "127.0.0.1:<port>" with users:(("postgres",pid=<n>,...))
      const portMatch = line.match(/127\.0\.0\.1:(\d+)\s/);
      const procMatch = line.match(/users:\(\("postgres",pid=(\d+)/);
      if (portMatch && procMatch) {
        const pid = Number.parseInt(procMatch[1], 10);
        const port = Number.parseInt(portMatch[1], 10);
        if (!seen.has(pid)) {
          seen.add(pid);
          found.push({ pid, port });
        }
      }
    }
    return found;
  } catch {
    return [];
  }
}

function canonicalReachable(port: number): boolean {
  try {
    execSync(`pg_isready -h 127.0.0.1 -p ${port}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure selection: given the discovered canonical port and the set of listening
 * postmasters, return the legacy one to stop (any port that is NOT canonical),
 * or undefined. A null canonical port means "cannot identify canonical" → never
 * select anything. Extracted for deterministic unit testing.
 */
export function selectLegacyEmbedded(canonicalPort: number | null, listening: ListeningPg[]): ListeningPg | undefined {
  if (canonicalPort === null) return undefined;
  return listening.find((p) => p.port !== canonicalPort);
}

function findLegacyEmbedded(): ListeningPg | undefined {
  if (process.env.GENIE_KEEP_LEGACY_PG === '1') return undefined;
  const canonicalPort = resolveCanonicalPort();
  if (canonicalPort === null) return undefined;
  if (!canonicalReachable(canonicalPort)) return undefined;
  return selectLegacyEmbedded(canonicalPort, listListeningPgserve());
}

export async function check(_ctx: MigrationContext): Promise<boolean> {
  return findLegacyEmbedded() !== undefined;
}

export async function apply(ctx: MigrationContext): Promise<void> {
  const target = findLegacyEmbedded();
  if (!target) {
    ctx.log('no legacy embedded found at apply time (race resolved)');
    return;
  }
  ctx.log(`stopping legacy embedded pgserve PID ${target.pid} (port ${target.port})`);
  // Try pg_ctl stop via discovered data dir from the process
  try {
    // Process cmdline to find -D <dataDir>
    const cmdline = execSync(`cat /proc/${target.pid}/cmdline | tr '\\0' ' '`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    const dataMatch = cmdline.match(/-D\s+(\S+)/);
    if (dataMatch) {
      execSync(`pg_ctl -D ${dataMatch[1]} -m fast stop`, { stdio: 'pipe' });
      ctx.log(`pg_ctl stop OK (data dir: ${dataMatch[1]})`);
      return;
    }
  } catch (err) {
    ctx.warn(`pg_ctl stop failed: ${(err as Error).message} — falling back to SIGTERM`);
  }
  // Fallback: SIGTERM the master process
  try {
    process.kill(target.pid, 'SIGTERM');
    ctx.log(`SIGTERM sent to PID ${target.pid}`);
  } catch (err) {
    throw new Error(`could not stop legacy embedded PID ${target.pid}: ${(err as Error).message}`);
  }
}

export async function validate(_ctx: MigrationContext): Promise<void> {
  // Allow up to 5s for shutdown
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (findLegacyEmbedded() === undefined) return;
    // small sleep
    Bun.sleepSync(200);
  }
  const remaining = findLegacyEmbedded();
  if (remaining) {
    throw new Error(`legacy embedded still listening on port ${remaining.port} (PID ${remaining.pid}) after 5s`);
  }
}
