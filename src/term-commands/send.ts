import * as tmux from '../lib/tmux.js';

export interface SendOptions {
  enter?: boolean;
  pane?: string;
}

export async function sendKeysToSession(
  sessionName: string,
  keys: string,
  options: SendOptions = {}
): Promise<void> {
  try {
    // Find session
    const session = await tmux.findSessionByName(sessionName);
    if (!session) {
      console.error(`❌ Session "${sessionName}" not found`);
      process.exit(1);
    }

    let paneId: string;

    // Use specified pane or find first pane
    if (options.pane) {
      paneId = options.pane.startsWith('%') ? options.pane : `%${options.pane}`;
    } else {
      // Get first window and pane
      const windows = await tmux.listWindows(session.id);
      if (!windows || windows.length === 0) {
        console.error(`❌ No windows found in session "${sessionName}"`);
        process.exit(1);
      }

      const panes = await tmux.listPanes(windows[0].id);
      if (!panes || panes.length === 0) {
        console.error(`❌ No panes found in session "${sessionName}"`);
        process.exit(1);
      }

      paneId = panes[0].id;
    }

    // Default: enter is true (append Enter key)
    const withEnter = options.enter !== false;

    // Escape single quotes for shell
    const escapedKeys = keys.replace(/'/g, "'\\''");

    if (withEnter) {
      // Send keys with Enter appended
      await tmux.executeTmux(`send-keys -t '${paneId}' '${escapedKeys}' Enter`);
    } else {
      // Send raw keys without Enter
      await tmux.executeTmux(`send-keys -t '${paneId}' '${escapedKeys}'`);
    }

    console.log(`✅ Keys sent to session "${sessionName}"${withEnter ? ' (with Enter)' : ''}`);
  } catch (error: any) {
    console.error(`❌ Error sending keys: ${error.message}`);
    process.exit(1);
  }
}
