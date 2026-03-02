import * as tmux from '../lib/tmux.js';
import { getTerminalConfig } from '../lib/genie-config.js';
import { resolveTarget, formatResolvedLabel } from '../lib/target-resolver.js';

export interface ExecOptions {
  quiet?: boolean;
  timeout?: number;
}

export async function executeInSession(
  target: string,
  command: string,
  options: ExecOptions = {}
): Promise<void> {
  try {
    // Use target resolver (DEC-1 from wish-26)
    const resolved = await resolveTarget(target);
    const paneId = resolved.paneId;
    const resolvedLabel = formatResolvedLabel(resolved, target);

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
