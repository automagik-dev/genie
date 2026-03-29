/**
 * genie agent resume [name] — Resume a suspended/failed agent.
 * Migrated from top-level `genie resume` in agents.ts.
 */

import type { Command } from 'commander';
import { handleWorkerResume } from '../agents.js';

export function registerAgentResume(parent: Command): void {
  parent
    .command('resume [name]')
    .description('Resume a suspended/failed agent with its Claude session')
    .option('--all', 'Resume all eligible agents')
    .action(async (name: string | undefined, options: { all?: boolean }) => {
      try {
        await handleWorkerResume(name, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
