/**
 * `genie dispatch` command group — framework-skill dispatch primitives.
 *
 * Hosts the three live dispatchers relocated from the top level:
 *   genie dispatch brainstorm <agent> <slug>  — spawn agent with DRAFT.md
 *   genie dispatch wish       <agent> <slug>  — spawn agent with DESIGN.md
 *   genie dispatch review     <agent> <ref>   — spawn agent with review scope
 *
 * Behavior is preserved 1:1 — only the command path changes. Underlying
 * handler functions (`brainstormCommand`, `wishCommand`, `reviewCommand`)
 * are exported from `dispatch.ts` and invoked here unchanged.
 *
 * Final fate of these primitives (keep / rework / delete) belongs to the
 * separate framework-skills brainstorm track.
 */

import type { Command } from 'commander';
import { brainstormCommand, reviewCommand, wishCommand } from './dispatch.js';

export function registerDispatchGroupCommands(program: Command): void {
  const dispatch = program
    .command('dispatch')
    .description('Framework skill dispatch primitives (brainstorm/wish/review)');

  dispatch
    .command('brainstorm <agent> <slug>')
    .description('Spawn agent with brainstorm DRAFT.md context')
    .action(async (agent: string, slug: string) => {
      await brainstormCommand(agent, slug);
    });

  dispatch
    .command('wish <agent> <slug>')
    .description('Spawn agent with wish DESIGN.md context')
    .action(async (agent: string, slug: string) => {
      await wishCommand(agent, slug);
    });

  dispatch
    .command('review <agent> <ref>')
    .description('Spawn agent with review scope for a wish group (format: <slug>#<group>)')
    .action(async (agent: string, ref: string) => {
      await reviewCommand(agent, ref);
    });
}
