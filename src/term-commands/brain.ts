/**
 * genie brain — delegate to @automagik/genie-brain (enterprise).
 *
 * This is the integration point. genie CLI dynamically imports brain
 * and passes all args through. If brain isn't installed, prints
 * install instructions and continues gracefully.
 *
 * Brain is NEVER a hard dependency. genie works exactly the same
 * without it. Zero behavior change for OSS users.
 */

import type { Command } from 'commander';

export function registerBrainCommands(program: Command): void {
  program
    .command('brain')
    .description('Knowledge graph engine (enterprise)')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (_options: Record<string, unknown>, cmd: Command) => {
      // Collect all args after "brain"
      const args = cmd.args;

      try {
        // Dynamic import — no hard dependency
        // @ts-expect-error — brain is enterprise-only, not in genie's deps
        const brain = await import('@automagik/genie-brain');

        if (brain.execute) {
          await brain.execute(args);
        } else {
          console.error('Brain module loaded but execute() not found.');
          console.error('Update @automagik/genie-brain to latest version.');
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);

        // Module not found — print install instructions
        if (msg.includes('Cannot find') || msg.includes('not found') || msg.includes('MODULE_NOT_FOUND')) {
          console.log('');
          console.log('  Brain is an enterprise module. Install it:');
          console.log('');
          console.log('    bun add @automagik/genie-brain');
          console.log('');
          console.log('  Or use standalone:');
          console.log('');
          console.log('    npx @automagik/genie-brain <command>');
          console.log('');
        } else {
          // Brain is installed but hit a runtime error
          console.error(`Brain error: ${msg}`);
        }
      }
    });
}
