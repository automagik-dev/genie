/**
 * Migration 001 — bake DATABASE_URL into pm2 genie-serve env block.
 *
 * Closes the upgrade-path hole left by commit 5567e202 (`fix(install):
 * bake DATABASE_URL env into ecosystem config when canonical pgserve is
 * detected`). That fix only kicks in on fresh `genie install`. Hosts
 * installed before the fix have a pm2 process `genie-serve` with no
 * env block and silently spawn their own embedded pgserve instead of
 * connecting to the canonical one.
 *
 * Detection: pm2 process `genie-serve` exists AND its env lacks
 * `DATABASE_URL` AND canonical pgserve is registered (port 8432
 * reachable).
 *
 * Fix: set DATABASE_URL via `pm2 set genie-serve:DATABASE_URL <url>` then
 * `pm2 restart genie-serve --update-env`. Genie-serve at next boot
 * connects to canonical and stops spawning the legacy embedded.
 */

import { execSync } from 'node:child_process';

import type { MigrationContext } from '../discover.js';

export const id = '001-pm2-env-databaseurl-bake';
export const description = 'Bake DATABASE_URL into pm2 genie-serve env when canonical pgserve registered';

const CANONICAL_PORT = 8432;

interface Pm2Process {
  pm_id: number;
  name: string;
  pm2_env?: { env?: Record<string, string> };
}

function pm2ListJson(): Pm2Process[] {
  try {
    const out = execSync('pm2 jlist', { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return JSON.parse(out) as Pm2Process[];
  } catch {
    return [];
  }
}

function findGenieServe(): Pm2Process | undefined {
  return pm2ListJson().find((p) => p.name === 'genie-serve');
}

function canonicalPgserveReachable(): boolean {
  try {
    execSync(`pg_isready -h 127.0.0.1 -p ${CANONICAL_PORT}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function buildCanonicalUrl(): string {
  // Mirrors the URL shape baked by `genie install` post-5567e202:
  // postgresql://postgres:postgres@127.0.0.1:<port>/<db>
  // The DB name is per-app fingerprint; genie defaults to 'postgres' when
  // the host hasn't run autopg create-app — install sets the real name.
  // For the migration we use the pgserve discovery URL.
  return `postgresql://postgres:postgres@127.0.0.1:${CANONICAL_PORT}/postgres`;
}

export async function check(_ctx: MigrationContext): Promise<boolean> {
  const proc = findGenieServe();
  if (!proc) return false; // no genie-serve under pm2 → nothing to fix
  const envHas = proc.pm2_env?.env?.DATABASE_URL;
  if (envHas) return false; // already baked
  if (!canonicalPgserveReachable()) return false; // canonical not up → can't safely set URL
  return true;
}

export async function apply(ctx: MigrationContext): Promise<void> {
  const url = buildCanonicalUrl();
  ctx.log(`setting pm2 env genie-serve:DATABASE_URL = ${url}`);
  execSync(`pm2 set genie-serve:DATABASE_URL ${JSON.stringify(url)}`, { stdio: 'pipe' });
  ctx.log('restarting genie-serve --update-env');
  execSync('pm2 restart genie-serve --update-env', { stdio: 'pipe' });
}

export async function validate(_ctx: MigrationContext): Promise<void> {
  const proc = findGenieServe();
  if (!proc) throw new Error('genie-serve missing from pm2 after restart');
  const url = proc.pm2_env?.env?.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL still not baked into pm2 env after apply');
  if (!url.includes(`:${CANONICAL_PORT}/`)) {
    throw new Error(`DATABASE_URL points to non-canonical port: ${url}`);
  }
}
