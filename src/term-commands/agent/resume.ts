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
    // Internal flag used by the scheduler auto-resume path to prevent the resume
    // handler from wiping `resumeAttempts` (the scheduler increments it just
    // before invoking this CLI). Omit for manual invocations — default behavior
    // still resets the counter to give the operator a fresh retry budget.
    .option('--no-reset-attempts', 'Preserve resumeAttempts counter (scheduler auto-resume use)')
    .action(async (name: string | undefined, options: { all?: boolean; resetAttempts?: boolean }) => {
      try {
        // Commander maps `--no-reset-attempts` to `resetAttempts: false`.
        await handleWorkerResume(name, {
          all: options.all,
          noResetAttempts: options.resetAttempts === false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
