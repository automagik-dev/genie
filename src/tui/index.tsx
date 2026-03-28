/**
 * genie tui — main entry point.
 *
 * Launches the Ink-based TUI app. In --dev mode, re-execs with bun --watch.
 * Group 2 scaffold: renders Ink app then exits.
 * Later groups add tmux split, live data, keybindings.
 */

import { render } from 'ink';
import React from 'react';
import App from './app.js';
import type { TuiOptions } from './types.js';

export async function launchTui(options: TuiOptions): Promise<void> {
  // Dev mode: re-exec with bun --watch for auto-reload
  if (options.dev) {
    const { execSync } = await import('node:child_process');
    const entryFile = new URL(import.meta.url).pathname || __filename;
    try {
      execSync(`bun --watch ${entryFile}`, { stdio: 'inherit' });
    } catch {
      // bun --watch exits with non-zero on Ctrl+C
    }
    return;
  }

  const { waitUntilExit } = render(React.createElement(App));
  await waitUntilExit();
}
