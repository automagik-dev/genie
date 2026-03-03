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

    // Use paste-buffer for reliable text injection (atomic, no key-name issues).
    // Falls back to send-keys only for single special keys without Enter.
    await tmux.pasteToPane(paneId, keys, withEnter);

    console.log(`Keys sent to ${resolvedLabel}${withEnter ? ' (with Enter)' : ''}`);
  } catch (error: any) {
    console.error(`Error sending keys: ${error.message}`);
    process.exit(1);
  }
}
