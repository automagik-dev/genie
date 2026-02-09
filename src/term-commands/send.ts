import * as tmux from '../lib/tmux.js';
import { resolveTarget, formatResolvedLabel } from '../lib/target-resolver.js';

export interface SendOptions {
  enter?: boolean;
  /** @deprecated Use target addressing instead: term send bd-42 'msg' */
  pane?: string;
}

/**
 * Show deprecation warning when --pane flag is used alongside target addressing.
 */
function warnPaneDeprecation(target: string): void {
  console.error(
    `\x1b[33m` +
    `Warning: --pane is deprecated. Use target addressing instead: term send ${target} 'msg'` +
    `\x1b[0m`
  );
}

export async function sendKeysToSession(
  target: string,
  keys: string,
  options: SendOptions = {}
): Promise<void> {
  try {
    let paneId: string;
    let resolvedLabel = target;

    if (options.pane) {
      // Deprecated --pane escape hatch: honor but warn
      warnPaneDeprecation(target);
      paneId = options.pane.startsWith('%') ? options.pane : `%${options.pane}`;

      // Still need to verify target exists as a session for backwards compat
      const session = await tmux.findSessionByName(target);
      if (!session) {
        console.error(`Session "${target}" not found`);
        process.exit(1);
      }
      resolvedLabel = `${target} (pane ${paneId})`;
    } else {
      // Use target resolver (DEC-1 from wish-26)
      const resolved = await resolveTarget(target);
      paneId = resolved.paneId;
      resolvedLabel = formatResolvedLabel(resolved, target);
    }

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
