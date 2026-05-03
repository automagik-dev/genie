/**
 * Migration 002 — kill legacy embedded pgserve listening on a non-canonical port.
 *
 * Detection: a postgres process owned by the current user is listening on
 * a port other than canonical 8432, AND canonical pgserve responds on
 * 8432, AND no obvious user-intent override (env var GENIE_KEEP_LEGACY_PG=1).
 *
 * Fix: send graceful pg_ctl stop to the legacy process; if that fails,
 * SIGTERM. Migration 001 (must run first) ensures genie-serve no longer
 * spawns it, so it stays dead.
 */

import { execSync } from 'node:child_process';

import type { MigrationContext } from '../discover.js';

export const id = '002-kill-embedded-pgserve-legacy';
export const description = 'Stop legacy embedded pgserve on non-canonical ports when canonical is healthy';

const CANONICAL_PORT = 8432;

interface ListeningPg {
  pid: number;
  port: number;
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

function canonicalReachable(): boolean {
  try {
    execSync(`pg_isready -h 127.0.0.1 -p ${CANONICAL_PORT}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function findLegacyEmbedded(): ListeningPg | undefined {
  if (process.env.GENIE_KEEP_LEGACY_PG === '1') return undefined;
  if (!canonicalReachable()) return undefined;
  return listListeningPgserve().find((p) => p.port !== CANONICAL_PORT);
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
