/**
 * genie prune — bulk cleanup of stale or exhausted registry entries.
 *
 * Targets (mutually exclusive — pick one per invocation):
 *   --zombies   Reconciler-tagged dead-pane zombies (24h default TTL).
 *               Conservative: only matches rows with audit reason
 *               'dead_pane_zombie' or 'stale_spawn_dead_pane'.
 *   --errored   Any exhausted error-state row regardless of reason
 *               (1h default TTL). Opt-in sweep — set auto_resume=true
 *               on rows you want to keep visible past the TTL.
 *
 * Flags:
 *   --dry-run            List targets without mutating
 *   --ttl-hours <n>      Override the mode default
 *
 * See issue #1293 for the original zombie cleanup story.
 */

import type { Command } from 'commander';
import {
  archiveAllExhaustedErrored,
  archiveExhaustedZombies,
  listAllExhaustedErrored,
  listExhaustedZombies,
} from '../lib/agent-registry.js';
import { isAvailable, shutdown } from '../lib/db.js';

interface PruneOptions {
  zombies?: boolean;
  errored?: boolean;
  dryRun?: boolean;
  ttlHours?: number;
}

type PruneMode = 'zombies' | 'errored';

const DEFAULT_TTL_HOURS: Record<PruneMode, number> = {
  zombies: 24,
  errored: 1,
};

const TARGET_LABEL: Record<PruneMode, string> = {
  zombies: 'zombie agent',
  errored: 'errored agent',
};

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value} (expected a positive integer)`);
  }
  return parsed;
}

async function listTargets(mode: PruneMode, ttlHours: number): Promise<Array<{ id: string; lastStateChange: string }>> {
  return mode === 'zombies' ? listExhaustedZombies(ttlHours) : listAllExhaustedErrored(ttlHours);
}

async function archiveTargets(mode: PruneMode, ttlHours: number): Promise<string[]> {
  return mode === 'zombies' ? archiveExhaustedZombies(ttlHours) : archiveAllExhaustedErrored(ttlHours);
}

async function runDryRun(mode: PruneMode, ttlHours: number): Promise<void> {
  const rows = await listTargets(mode, ttlHours);
  if (rows.length === 0) {
    console.log(`No exhausted ${TARGET_LABEL[mode]}s older than ${ttlHours}h.`);
    return;
  }
  const plural = rows.length === 1 ? '' : 's';
  console.log(`Would archive ${rows.length} ${TARGET_LABEL[mode]}${plural} older than ${ttlHours}h:`);
  for (const r of rows) {
    console.log(`  ${r.id}  (last state change: ${r.lastStateChange})`);
  }
}

async function runArchive(mode: PruneMode, ttlHours: number): Promise<void> {
  const ids = await archiveTargets(mode, ttlHours);
  if (ids.length === 0) {
    console.log(`No exhausted ${TARGET_LABEL[mode]}s older than ${ttlHours}h. Nothing to archive.`);
    return;
  }
  const plural = ids.length === 1 ? '' : 's';
  console.log(`Archived ${ids.length} ${TARGET_LABEL[mode]}${plural} older than ${ttlHours}h:`);
  for (const id of ids) {
    console.log(`  ${id}`);
  }
}

function resolveMode(options: PruneOptions): PruneMode {
  if (options.zombies && options.errored) {
    console.error('Error: --zombies and --errored are mutually exclusive.');
    process.exit(2);
  }
  if (options.zombies) return 'zombies';
  if (options.errored) return 'errored';
  console.error('Error: no prune target specified. Use `--zombies` or `--errored`.');
  console.error('See `genie prune --help` for available targets.');
  process.exit(2);
}

async function pruneCommand(options: PruneOptions): Promise<void> {
  const mode = resolveMode(options);
  const ttlHours = options.ttlHours ?? DEFAULT_TTL_HOURS[mode];

  if (!(await isAvailable())) {
    console.error('Database is not running. Start it with: genie db status');
    process.exit(1);
  }

  try {
    await (options.dryRun ? runDryRun(mode, ttlHours) : runArchive(mode, ttlHours));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Prune failed: ${message}`);
    process.exit(1);
  } finally {
    await shutdown().catch(() => {});
  }
}

export function registerPruneCommands(program: Command): void {
  program
    .command('prune')
    .description('Bulk cleanup of stale or exhausted registry entries')
    .option('--zombies', 'Archive reconciler-tagged dead-pane zombies (24h default TTL)')
    .option(
      '--errored',
      'Archive any exhausted error-state agent regardless of reason (1h default TTL; set auto_resume=true to keep a row visible)',
    )
    .option('--dry-run', 'List targets that would be affected without mutating')
    .option('--ttl-hours <hours>', 'Override the mode default TTL in hours (24 for --zombies, 1 for --errored)', (v) =>
      parsePositiveInt(v, '--ttl-hours'),
    )
    .action(pruneCommand);
}
