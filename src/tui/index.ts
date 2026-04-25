/**
 * genie tui — renderer entry point (plain .ts, no JSX).
 *
 * This module ONLY renders the TUI nav panel. It is called when
 * GENIE_TUI_PANE=left, meaning we're inside the tmux pane that
 * `genie serve` already created.
 *
 * Session creation and tmux server management live in serve.ts.
 * Attach logic (check serve → auto-start → attach) lives in genie.ts.
 * The TUI never creates tmux servers or sessions.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * JS-level breadcrumb to ~/.genie/logs/tui-crash.log. Belt-and-suspenders
 * companion to the shell-level `exec 2>>` redirect in tui-launch.sh — covers
 * the case where launchTui() is invoked via `bun dist/genie.js` directly
 * (e.g. dev/CI) rather than through the wrapper. See #1390.
 *
 * Failures here MUST NOT throw — diagnostic plumbing should never break the
 * TUI launch path.
 */
function recordTuiLaunchBreadcrumb(): void {
  try {
    const logsDir = join(homedir(), '.genie', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const ts = new Date().toISOString();
    const line = `--- tui-launch ${ts} pid=${process.pid} platform=${process.platform} arch=${process.arch} ---\n`;
    appendFileSync(join(logsDir, 'tui-crash.log'), line, { mode: 0o644 });
  } catch {
    // intentionally swallowed
  }
}

/**
 * Render the TUI nav panel.
 * Called from genie.ts when GENIE_TUI_PANE=left.
 */
export async function launchTui(): Promise<void> {
  recordTuiLaunchBreadcrumb();
  const { renderNav } = await import('./render.js');
  await renderNav();
}
