/**
 * genie task reset <slug>#<group> — Reset an in-progress group back to ready.
 * Absorbed from top-level `genie reset` in state.ts.
 */

import type { Command } from 'commander';
import * as wishState from '../../lib/wish-state.js';
import { parseRef } from '../state.js';

export function registerTaskReset(parent: Command): void {
  parent
    .command('reset <ref>')
    .description('Reset an in-progress group back to ready (format: <slug>#<group>)')
    .action(async (ref: string) => {
      try {
        const { slug, group } = parseRef(ref);
        const result = await wishState.resetGroup(slug, group);
        console.log(`🔄 Group "${group}" reset to ready in wish "${slug}"`);
        if (result.status === 'ready') {
          console.log('   Status: ready (assignee cleared)');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`❌ ${message}`);
        process.exit(1);
      }
    });
}
