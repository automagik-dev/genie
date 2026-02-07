import * as tmux from '../lib/tmux.js';
import { getTerminalConfig } from '../lib/genie-config.js';

export interface ExecOptions {
  quiet?: boolean;
  timeout?: number;
  pane?: string;
}

export async function executeInSession(
  target: string,
  command: string,
  options: ExecOptions = {}
): Promise<void> {
  // Parse target: "session:window" or just "session"
  const [sessionName, windowName] = target.includes(':')
    ? target.split(':')
    : [target, undefined];

  try {
    let paneId: string;

    if (options.pane) {
      // Direct pane targeting (like term send --pane)
      paneId = options.pane.startsWith('%') ? options.pane : `%${options.pane}`;
      // Still validate session exists
      const session = await tmux.findSessionByName(sessionName);
      if (!session) {
        console.error(`Session "${sessionName}" not found`);
        process.exit(1);
      }
    } else {
      // Find session (don't create - exec should target existing sessions)
      const session = await tmux.findSessionByName(sessionName);
      if (!session) {
        console.error(`Session "${sessionName}" not found`);
        process.exit(1);
      }

      const windows = await tmux.listWindows(session.id);
      if (!windows || windows.length === 0) {
        console.error(`No windows found in session "${sessionName}"`);
        process.exit(1);
      }

      let targetWindow;
      if (windowName) {
        // Specific window requested via "session:window" syntax
        targetWindow = windows.find(w => w.name === windowName);
        if (!targetWindow) {
          console.error(`Window "${windowName}" not found in session "${sessionName}"`);
          process.exit(1);
        }
      } else {
        // Use first window (active window)
        targetWindow = windows[0];
      }

      const panes = await tmux.listPanes(targetWindow.id);
      if (!panes || panes.length === 0) {
        console.error(`No panes found in window "${targetWindow.name}"`);
        process.exit(1);
      }

      paneId = panes[0].id;
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

    process.exit(exitCode);
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
