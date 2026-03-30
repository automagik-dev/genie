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

/**
 * Render the TUI nav panel.
 * Called from genie.ts when GENIE_TUI_PANE=left.
 */
export async function launchTui(): Promise<void> {
  const { renderNav } = await import('./render.js');
  await renderNav();
}
