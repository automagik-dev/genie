/**
 * genie tui — entry point (plain .ts, no JSX)
 *
 * When run inside the TUI tmux session (GENIE_TUI_PANE=left), renders the
 * OpenTUI nav panel. When run standalone, creates the tmux session with
 * left (nav) + right (Claude Code) split, then attaches.
 */

import { attachTuiSession, cleanup, createTuiSession, hasTmux, isInsideTuiSession } from './tmux.js';

interface TuiLaunchOptions {
  dev?: boolean;
  /** Workspace root path — enables workspace mode */
  workspaceRoot?: string;
  /** Pre-select this agent on initial render */
  initialAgent?: string;
}

export async function launchTui(options: TuiLaunchOptions = {}): Promise<void> {
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

  // Build env vars for workspace mode
  const envVars = ['GENIE_TUI_PANE=left', `GENIE_TUI_RIGHT=${rightPane}`];
  if (options.workspaceRoot) envVars.push(`GENIE_TUI_WORKSPACE=${options.workspaceRoot}`);
  if (options.initialAgent) envVars.push(`GENIE_TUI_AGENT=${options.initialAgent}`);
  // Write a launch script to avoid send-keys quoting hell with long env var strings
  const { execSync } = await import('node:child_process');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tuiTmuxCmd } = await import('./tmux.js');

  const genieHome = process.env.GENIE_HOME ?? join(process.env.HOME ?? '/tmp', '.genie');
  mkdirSync(genieHome, { recursive: true });
  const scriptPath = join(genieHome, 'tui-launch.sh');
  const runCmd = options.dev ? `bun --watch ${genieBin}` : `${bunPath} ${genieBin}`;
  writeFileSync(scriptPath, `#!/bin/sh\nexport ${envVars.join('\nexport ')}\nexec ${runCmd}\n`, { mode: 0o755 });

  execSync(tuiTmuxCmd(`send-keys -t '${leftPane}' 'sh ${scriptPath}' Enter`), {
    stdio: 'ignore',
  });

  // Attach (blocking)
  attachTuiSession();

  // Cleanup after detach
  cleanup(session);
}
