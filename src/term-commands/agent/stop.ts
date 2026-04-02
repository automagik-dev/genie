/**
 * genie agent stop <name> — Stop an agent (preserves session for resume).
 * Migrated from top-level `genie stop` in agents.ts.
 */

import type { Command } from 'commander';
import { handleWorkerStop } from '../agents.js';

export function registerAgentStop(parent: Command): void {
  parent
    .command('stop <name>')
    .description('Stop an agent (preserves session for resume)')
    .action(async (name: string) => {
      try {
        await handleWorkerStop(name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
