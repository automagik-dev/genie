import * as tmux from '../lib/tmux.js';

export async function executeInSession(target: string, command: string): Promise<void> {
  // Parse target: "session:window" or just "session"
  const [sessionName, windowName] = target.includes(':')
    ? target.split(':')
    : [target, 'shell'];

  try {
    // Find or create session
    let session = await tmux.findSessionByName(sessionName);
    if (!session) {
      console.error(`Session "${sessionName}" not found, creating...`);
      session = await tmux.createSession(sessionName);
      if (!session) {
        console.error(`Failed to create session "${sessionName}"`);
        process.exit(1);
      }
    }

    // Find or create window
    let windows = await tmux.listWindows(session.id);
    let targetWindow = windows.find(w => w.name === windowName);
    if (!targetWindow) {
      console.error(`Window "${windowName}" not found, creating...`);
      targetWindow = await tmux.createWindow(session.id, windowName);
      if (!targetWindow) {
        console.error(`Failed to create window "${windowName}"`);
        process.exit(1);
      }
    }

    // Get pane
    const panes = await tmux.listPanes(targetWindow.id);
    if (!panes || panes.length === 0) {
      console.error(`No panes found in window "${windowName}"`);
      process.exit(1);
    }

    // Run command synchronously using wait-for (no polling, no ugly markers)
    const { output, exitCode } = await tmux.runCommandSync(panes[0].id, command);

    // Output the result
    if (output) {
      console.log(output);
    }

    process.exit(exitCode);
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
