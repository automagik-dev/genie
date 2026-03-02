import * as tmux from '../lib/tmux.js';
import { resolveTarget, formatResolvedLabel } from '../lib/target-resolver.js';

export interface SendOptions {
  enter?: boolean;
}

export async function sendKeysToSession(
  target: string,
  keys: string,
  options: SendOptions = {}
): Promise<void> {
  try {
    // Use target resolver (DEC-1 from wish-26)
    const resolved = await resolveTarget(target);
    const paneId = resolved.paneId;
    const resolvedLabel = formatResolvedLabel(resolved, target);

    // Default: enter is true (append Enter key)
    const withEnter = options.enter !== false;

    // Escape single quotes for shell
    const escapedKeys = keys.replace(/'/g, "'\\''");

    if (withEnter) {
      await tmux.executeTmux(`send-keys -t '${paneId}' '${escapedKeys}' Enter`);
    } else {
      await tmux.executeTmux(`send-keys -t '${paneId}' '${escapedKeys}'`);
    }

    console.log(`Keys sent to ${resolvedLabel}${withEnter ? ' (with Enter)' : ''}`);
  } catch (error: any) {
    console.error(`Error sending keys: ${error.message}`);
    process.exit(1);
  }
}
