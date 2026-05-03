/**
 * Genie host migrations — versioned, applied-once-per-host.
 *
 * Discover migrations in steps/ → filter pending vs already-applied →
 * run check → apply → validate per step, record to store. Same pattern
 * as DB migrations (drizzle, alembic) but for HOST state (pm2 env,
 * embedded pgserve, config drifts).
 *
 * Auto-runs on `bun add -g @automagik/genie@latest` via postinstall hook
 * (scripts/postinstall-migrations.js). Manual `genie migrate` is the
 * explicit escape hatch.
 *
 * See: .genie/wishes/genie-host-migrations/WISH.md
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type MigrationContext, type MigrationModule, discoverMigrations, loadMigrationModule } from './discover.js';
import { type StepResult, runMigration } from './runner.js';
import { type MigrationRecord, getApplied } from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface MigrateOptions {
  quiet?: boolean;
  dryRun?: boolean;
}

export interface MigrateResult {
  ok: boolean;
  results: StepResult[];
  summary: string;
}

function getGenieVersion(): string {
  try {
    // genie cli installed structure: <root>/dist/genie.js + <root>/package.json
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function migrate(options: MigrateOptions = {}): Promise<MigrateResult> {
  const { quiet = false, dryRun = false } = options;
  const log = (msg: string) => {
    if (!quiet) process.stderr.write(`${msg}\n`);
  };
  const warn = (msg: string) => process.stderr.write(`${msg}\n`);
  const ctx: MigrationContext = { log, warn, dryRun };

  const version = getGenieVersion();
  log(`genie host-migrations starting (version=${version}, dryRun=${dryRun})`);

  const discovered = discoverMigrations();
  if (discovered.length === 0) {
    return { ok: true, results: [], summary: 'no migrations discovered' };
  }

  const results: StepResult[] = [];
  for (const item of discovered) {
    let mod: MigrationModule;
    try {
      mod = await loadMigrationModule(item.filePath);
    } catch (err) {
      const msg = (err as Error).message;
      warn(`[${item.id}] FAIL during load: ${msg}`);
      results.push({ id: item.id, status: 'FAIL', detail: `load threw: ${msg}` });
      continue;
    }
    const r = await runMigration(mod, ctx, version);
    results.push(r);
  }

  const failed = results.filter((r) => r.status === 'FAIL');
  const summary = `genie host-migrations complete: ${results.length - failed.length}/${results.length} OK`;
  log(summary);
  if (failed.length > 0) {
    warn(`Failed migrations: ${failed.map((r) => r.id).join(', ')}`);
    warn('Re-run `genie migrate` after addressing the above.');
    return { ok: false, results, summary };
  }
  return { ok: true, results, summary };
}

export interface StatusEntry {
  id: string;
  status: 'APPLIED' | 'PENDING' | 'FAILED';
  appliedAt?: string;
  appliedFrom?: string;
  detail?: string;
}

export function status(): StatusEntry[] {
  const discovered = discoverMigrations();
  const applied = getApplied();
  const out: StatusEntry[] = [];
  for (const item of discovered) {
    const rec: MigrationRecord | undefined = applied.get(item.id);
    if (!rec) {
      out.push({ id: item.id, status: 'PENDING' });
    } else {
      out.push({
        id: item.id,
        status: rec.status === 'APPLIED' ? 'APPLIED' : 'FAILED',
        appliedAt: rec.appliedAt,
        appliedFrom: rec.appliedFrom,
        detail: rec.detail,
      });
    }
  }
  return out;
}

export { discoverMigrations, loadMigrationModule } from './discover.js';
