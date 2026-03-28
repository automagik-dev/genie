/**
 * genie tui — main entry point.
 *
 * Launches the TUI with tmux split layout:
 *   - Left pane (30 cols): Ink nav tree
 *   - Right pane (rest): nested tmux attach to project sessions
 *
 * In --dev mode, re-execs with bun --watch for auto-reload.
 */

import { execSync } from 'node:child_process';
import { render } from 'ink';
import React from 'react';
import App from './app.js';
import { cleanup, createTuiSession, hasTmux } from './tmux.js';
import type { TuiOptions } from './types.js';

export async function launchTui(options: TuiOptions): Promise<void> {
  // Dev mode: re-exec with bun --watch for auto-reload
  if (options.dev) {
    const entryFile = new URL(import.meta.url).pathname || __filename;
    try {
      execSync(`bun --watch ${entryFile}`, { stdio: 'inherit' });
    } catch {
      // bun --watch exits with non-zero on Ctrl+C
    }
    return;
  }

  // Pre-flight: tmux required
  if (!hasTmux()) {
    console.error('Error: tmux is required for genie tui. Install it and try again.');
    process.exit(1);
  }

  // If already inside the genie-tui session (left pane), run the Ink app directly
  if (process.env.GENIE_TUI_PANE === 'left') {
    const { waitUntilExit } = render(React.createElement(App));
    await waitUntilExit();
    return;
  }

  // Outside tmux (or in another session) — create the tmux layout and attach
  try {
    const { session, leftPane } = await createTuiSession();

    // Launch the Ink app inside the left pane
    const selfPath = process.argv[1] || 'genie';
    const tuiCmd = `GENIE_TUI_PANE=left ${selfPath} tui`;
    execSync(`tmux send-keys -t '${leftPane}' '${tuiCmd}' Enter`, {
      stdio: 'pipe',
    });

    // Attach to the session (this blocks until the session ends)
    try {
      execSync(`tmux attach-session -t '${session}'`, { stdio: 'inherit' });
    } catch {
      // Normal exit when session is killed
    }
  } finally {
    // Always clean up
    await cleanup();
  }
}
