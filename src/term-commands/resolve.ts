/**
 * term resolve <target> - Diagnostic command for target resolution
 *
 * Dry-run that shows how a target would be resolved without side effects.
 * Useful for debugging orchestration issues.
 */

import { resolveTarget } from '../lib/target-resolver.js';

export interface ResolveOptions {
  json?: boolean;
}

export async function resolveCommand(target: string, options: ResolveOptions = {}): Promise<void> {
  try {
    const result = await resolveTarget(target, {
      checkLiveness: true,
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`Target:      ${target}`);
    console.log(`Resolved via: ${result.resolvedVia}`);
    console.log(`Pane ID:     ${result.paneId}`);
    if (result.session) {
      console.log(`Session:     ${result.session}`);
    }
    if (result.workerId) {
      console.log(`Worker ID:   ${result.workerId}`);
    }
    if (result.paneIndex !== undefined) {
      console.log(`Pane index:  ${result.paneIndex}`);
    }
  } catch (error: any) {
    console.error(error.message);
    process.exit(1);
  }
}
