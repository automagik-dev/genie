/**
 * `genie migrate` — apply pending host-migrations.
 *
 * Subcommands:
 *   genie migrate              — apply all pending in order, idempotent
 *   genie migrate --dry-run    — list pending without executing
 *   genie migrate --status     — show applied / pending / failed table
 *   genie migrate --quiet      — suppress per-step OK lines (used by postinstall)
 *
 * See: src/migrations/index.ts (orchestrator)
 */

import { status as listStatus, migrate } from '../migrations/index.js';

export interface MigrateCommandOptions {
  dryRun?: boolean;
  quiet?: boolean;
  status?: boolean;
}

export async function migrateCommand(options: MigrateCommandOptions = {}): Promise<void> {
  if (options.status) {
    const rows = listStatus();
    if (rows.length === 0) {
      process.stdout.write('No migrations discovered.\n');
      return;
    }
    process.stdout.write('id                              status     appliedAt                 from\n');
    process.stdout.write('------------------------------- ---------- ------------------------ ------------\n');
    for (const r of rows) {
      const id = r.id.padEnd(31);
      const st = r.status.padEnd(10);
      const at = (r.appliedAt || '-').padEnd(24);
      const from = r.appliedFrom || '-';
      process.stdout.write(`${id} ${st} ${at} ${from}\n`);
    }
    return;
  }

  const result = await migrate({ quiet: options.quiet, dryRun: options.dryRun });
  process.exit(result.ok ? 0 : 1);
}
