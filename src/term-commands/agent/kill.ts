/**
 * genie agent kill <name> — Force kill an agent by name.
 * Migrated from top-level `genie kill` in agents.ts.
 */

import type { Command } from 'commander';
import { handleWorkerKill } from '../agents.js';

export function registerAgentKill(parent: Command): void {
  parent
    .command('kill <name>')
    .description('Force kill an agent by name')
    .action(async (name: string) => {
      try {
        await handleWorkerKill(name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
