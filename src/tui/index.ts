/**
 * genie tui — entry point (plain .ts, no JSX)
 *
 * When run inside the TUI tmux session (GENIE_TUI_PANE=left), renders the
 * OpenTUI nav panel. When run standalone, creates the tmux session with
 * left (nav) + right (Claude Code) split, then attaches.
 */

import { attachTuiSession, cleanup, createTuiSession, hasTmux, isInsideTuiSession } from './tmux.js';

export async function launchTui(options: { dev?: boolean } = {}): Promise<void> {
  // If already inside the TUI pane, render OpenTUI directly
  if (isInsideTuiSession()) {
    const { renderNav } = await import('./render.js');
    await renderNav();
    return;
  }

  // Standalone launch: create tmux session + attach
  if (!hasTmux()) {
    console.error('Error: tmux is required for genie tui');
    return;
  }

  const { session, leftPane, rightPane } = createTuiSession();

  // Send the nav command to the left pane
  const bunPath = process.execPath || 'bun';
  const genieBin = process.argv[1] || 'genie';

  // Run the TUI nav renderer in the left pane
  // Uses GENIE_TUI_PANE=left to trigger renderer mode (not a subcommand)
  const { execSync } = await import('node:child_process');
  const { genieTmuxCmd } = await import('../lib/tmux-wrapper.js');
  if (options.dev) {
    execSync(
      genieTmuxCmd(
        `send-keys -t '${leftPane}' "GENIE_TUI_PANE=left GENIE_TUI_RIGHT=${rightPane} bun --watch ${genieBin}" Enter`,
      ),
      { stdio: 'ignore' },
    );
  } else {
    execSync(
      genieTmuxCmd(
        `send-keys -t '${leftPane}' "GENIE_TUI_PANE=left GENIE_TUI_RIGHT=${rightPane} ${bunPath} ${genieBin}" Enter`,
      ),
      { stdio: 'ignore' },
    );
  }

  // Attach (blocking)
  attachTuiSession();

  // Cleanup after detach
  cleanup(session);
}
