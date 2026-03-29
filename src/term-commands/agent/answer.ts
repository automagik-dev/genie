/**
 * genie agent answer <name> <choice> — Answer a question for an agent.
 * Migrated from top-level `genie answer` in orchestrate.ts.
 */

import type { Command } from 'commander';
import { answerQuestion } from '../orchestrate.js';

export function registerAgentAnswer(parent: Command): void {
  parent
    .command('answer <name> <choice>')
    .description('Answer a question for an agent (use "text:..." for text input)')
    .action(async (name: string, choice: string) => {
      try {
        await answerQuestion(name, choice);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
