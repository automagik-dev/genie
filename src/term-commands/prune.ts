/**
 * genie prune — bulk cleanup of stale or exhausted registry entries.
 *
 * Subcommands/flags:
 *   genie prune --zombies           Archive exhausted dead-pane zombies
 *   genie prune --zombies --dry-run List zombies that would be archived
 *   genie prune --ttl-hours <n>     Override the default 24h TTL
 *
 * A "dead-pane zombie" is an agent whose reconciler audit trail tagged
 * it `reason=dead_pane_zombie` (tmux pane vanished mid-run) AND whose
 * auto-resume budget was subsequently exhausted (auto_resume=false).
 * Once that happens the row is inert: it never resumes and clutters
 * `genie ls`. See issue #1293.
 */

import type { Command } from 'commander';
import { archiveExhaustedZombies, listExhaustedZombies } from '../lib/agent-registry.js';
import { isAvailable, shutdown } from '../lib/db.js';

interface PruneOptions {
  zombies?: boolean;
  dryRun?: boolean;
  ttlHours?: number;
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value} (expected a positive integer)`);
  }
  return parsed;
}

async function runDryRun(ttlHours: number): Promise<void> {
  const zombies = await listExhaustedZombies(ttlHours);
  if (zombies.length === 0) {
    console.log(`No exhausted zombies older than ${ttlHours}h.`);
    return;
  }
  const plural = zombies.length === 1 ? '' : 's';
  console.log(`Would archive ${zombies.length} zombie agent${plural} older than ${ttlHours}h:`);
  for (const z of zombies) {
    console.log(`  ${z.id}  (last state change: ${z.lastStateChange})`);
  }
}

async function runArchive(ttlHours: number): Promise<void> {
  const ids = await archiveExhaustedZombies(ttlHours);
  if (ids.length === 0) {
    console.log(`No exhausted zombies older than ${ttlHours}h. Nothing to archive.`);
    return;
  }
  const plural = ids.length === 1 ? '' : 's';
  console.log(`Archived ${ids.length} zombie agent${plural} older than ${ttlHours}h:`);
  for (const id of ids) {
    console.log(`  ${id}`);
  }
}

async function pruneCommand(options: PruneOptions): Promise<void> {
  if (!options.zombies) {
    console.error('Error: no prune target specified. Use `--zombies`.');
    console.error('See `genie prune --help` for available targets.');
    process.exit(2);
  }

  const ttlHours = options.ttlHours ?? 24;

  if (!(await isAvailable())) {
    console.error('Database is not running. Start it with: genie db status');
    process.exit(1);
  }

  try {
    await (options.dryRun ? runDryRun(ttlHours) : runArchive(ttlHours));
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
    .option('--zombies', 'Archive dead-pane zombies whose auto-resume retries are exhausted')
    .option('--dry-run', 'List targets that would be affected without mutating')
    .option('--ttl-hours <hours>', 'Minimum age in hours before a zombie is eligible for archive (default: 24)', (v) =>
      parsePositiveInt(v, '--ttl-hours'),
    )
    .action(pruneCommand);
}
