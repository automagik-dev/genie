/**
 * genie agent list — List registered agents with runtime status.
 * Migrated from top-level `genie ls` in agents.ts.
 */

import type { Command } from 'commander';
import { handleLsCommand } from '../agents.js';

export function registerAgentList(parent: Command): void {
  parent
    .command('list')
    .alias('ls')
    .description('List registered agents with runtime status')
    .option('--json', 'Output as JSON')
    .option('--source <name>', 'Filter by executor metadata source (e.g. omni)')
    .option('--all', 'Include archived agents (hidden by default)')
    .action(async (options: { json?: boolean; source?: string; all?: boolean }) => {
      try {
        await handleLsCommand(options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
