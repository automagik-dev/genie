import * as tmux from '../lib/tmux.js';
import { getTerminalConfig } from '../lib/genie-config.js';
import { resolveTarget, formatResolvedLabel } from '../lib/target-resolver.js';

export interface ExecOptions {
  quiet?: boolean;
  timeout?: number;
  /** @deprecated Use target addressing instead: term exec bd-42 'cmd' */
  pane?: string;
}

/**
 * Show deprecation warning when --pane flag is used.
 */
function warnPaneDeprecation(target: string): void {
  console.error(
    `\x1b[33m` +
    `Warning: --pane is deprecated. Use target addressing instead: term exec ${target} 'cmd'` +
    `\x1b[0m`
  );
}

export async function executeInSession(
  target: string,
  command: string,
  options: ExecOptions = {}
): Promise<void> {
  try {
    let paneId: string;
    let resolvedLabel = target;

    if (options.pane) {
      // Deprecated --pane escape hatch: honor but warn
      warnPaneDeprecation(target);
      paneId = options.pane.startsWith('%') ? options.pane : `%${options.pane}`;

      // Parse target for session validation (backwards compat with old session:window syntax)
      const [sessionName] = target.includes(':') ? target.split(':') : [target];
      const session = await tmux.findSessionByName(sessionName);
      if (!session) {
        console.error(`Session "${sessionName}" not found`);
        process.exit(1);
      }
      resolvedLabel = `${target} (pane ${paneId})`;
    } else {
      // Use target resolver (DEC-1 from wish-26)
      const resolved = await resolveTarget(target);
      paneId = resolved.paneId;
      resolvedLabel = formatResolvedLabel(resolved, target);
    }

    // Use config default if no timeout specified
    const termConfig = getTerminalConfig();
    const timeout = options.timeout ?? termConfig.execTimeout;

    // Run command synchronously using wait-for (no polling, no ugly markers)
    const { output, exitCode } = await tmux.runCommandSync(
      paneId,
      command,
      timeout
    );

    // Output the result (unless quiet mode)
    if (output && !options.quiet) {
      console.log(output);
    }

    // Log resolution confirmation to stderr (so stdout stays clean for exec output)
    if (!options.quiet) {
      console.error(`Executed in ${resolvedLabel}`);
    }

    process.exit(exitCode);
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
