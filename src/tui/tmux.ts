/**
 * TUI tmux integration — session/pane/window management.
 *
 * Stub for Group 2: exports session lifecycle shells.
 * Group 5 will implement split layout, nested attach, tab bar, keybindings.
 */

import { execSync } from 'node:child_process';

const TUI_SESSION = 'genie-tui';
const NAV_WIDTH = 30;

/**
 * Check if tmux is available on the system.
 */
export function hasTmux(): boolean {
  try {
    execSync('tmux -V', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if we're currently inside a tmux session.
 */
export function insideTmux(): boolean {
  return !!process.env.TMUX;
}

/**
 * Create the genie-tui tmux session with left (Ink) + right (agent) split.
 * Group 5 implements the actual split/attach logic.
 */
export async function createTuiSession(): Promise<void> {
  // Stub — Group 5 will implement
  void TUI_SESSION;
  void NAV_WIDTH;
}

/**
 * Attach a project's tmux session into the right pane.
 */
export async function attachProject(_sessionName: string): Promise<void> {
  // Stub — Group 5 will implement
}

/**
 * Switch the right pane to a different project session.
 */
export async function switchRightPane(_sessionName: string): Promise<void> {
  // Stub — Group 5 will implement
}

/**
 * Clean up: unbind keys, kill the genie-tui session.
 */
export async function cleanup(): Promise<void> {
  // Stub — Group 5 will implement
}
