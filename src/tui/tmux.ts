/** TUI-specific tmux management — session, splits, tabs, keybindings */

import { execSync, spawnSync } from 'node:child_process';
import { tmuxStyle } from './theme.js';

const SESSION_NAME = 'genie-tui';
const KEY_TABLE = 'genie-tui';
const NAV_WIDTH = 30;

/** Check if tmux is available */
export function hasTmux(): boolean {
  try {
    execSync('which tmux', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Check if we're already inside the genie-tui session */
export function isInsideTuiSession(): boolean {
  return process.env.GENIE_TUI_PANE === 'left';
}

/** Create the outer TUI tmux session with left/right split */
export function createTuiSession(): { session: string; leftPane: string; rightPane: string } {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;

  try {
    execSync(`tmux kill-session -t ${SESSION_NAME} 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // doesn't exist
  }

  execSync(`tmux new-session -d -s ${SESSION_NAME} -x ${cols} -y ${rows} -e GENIE_TUI_PANE=left`, { stdio: 'ignore' });
  execSync(`tmux split-window -h -t ${SESSION_NAME}:0 -l ${cols - NAV_WIDTH - 1}`, { stdio: 'ignore' });

  const panes = execSync(`tmux list-panes -t ${SESSION_NAME}:0 -F '#{pane_id}'`, { encoding: 'utf-8' })
    .trim()
    .split('\n');

  const leftPane = panes[0];
  const rightPane = panes[1] || panes[0];

  applyTmuxStyle(SESSION_NAME);
  setupKeybindings(SESSION_NAME);

  return { session: SESSION_NAME, leftPane, rightPane };
}

/**
 * Resolve the right pane ID — self-healing if the pane was killed/recreated.
 * Falls back to re-discovering from the session layout.
 */
function resolveRightPane(rightPane: string): string {
  try {
    execSync(`tmux display-message -t ${rightPane} -p ''`, { stdio: 'ignore' });
    return rightPane;
  } catch {
    try {
      const panes = execSync(`tmux list-panes -t ${SESSION_NAME}:0 -F '#{pane_id}'`, { encoding: 'utf-8' })
        .trim()
        .split('\n');
      return panes[1] || panes[0];
    } catch {
      return rightPane;
    }
  }
}

/** Ensure a tmux session exists, creating it if needed */
function ensureSession(sessionName: string): void {
  try {
    execSync(`tmux has-session -t '${sessionName}' 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    try {
      execSync(`tmux new-session -d -s '${sessionName}'`, { stdio: 'ignore' });
    } catch {
      // race: another process created it
    }
  }
}

/** Attach a project's tmux session in the right pane (nested) */
export function attachProject(rightPane: string, targetSession: string): void {
  const pane = resolveRightPane(rightPane);
  ensureSession(targetSession);
  try {
    execSync(`tmux respawn-pane -k -t ${pane} "TMUX='' tmux attach-session -t '${targetSession}'"`, {
      stdio: 'ignore',
    });
  } catch {
    // pane doesn't exist
  }
}

/** Switch right pane to a different project session */
export function switchRightPane(rightPane: string, targetSession: string): void {
  attachProject(rightPane, targetSession);
}

/**
 * Set up TUI keybindings in a dedicated key table (not global root).
 * Uses a custom key table "genie-tui" so bindings only apply inside the TUI session.
 * The session hooks switch-client into this table on focus.
 */
function setupKeybindings(session: string): void {
  try {
    // Define bindings in the genie-tui key table (session-scoped, not global)
    execSync(`tmux bind-key -T ${KEY_TABLE} Tab select-pane -t ${session}:0.+ \\; switch-client -T ${KEY_TABLE}`, {
      stdio: 'ignore',
    });

    execSync(
      `tmux bind-key -T ${KEY_TABLE} C-b if-shell "[ $(tmux display-message -p '#{pane_width}' -t ${session}:0.0) -gt 5 ]" "resize-pane -t ${session}:0.0 -x 0" "resize-pane -t ${session}:0.0 -x ${NAV_WIDTH}" \\; switch-client -T ${KEY_TABLE}`,
      { stdio: 'ignore' },
    );

    execSync(`tmux bind-key -T ${KEY_TABLE} C-t send-keys -t ${session}:0.1 C-b c \\; switch-client -T ${KEY_TABLE}`, {
      stdio: 'ignore',
    });

    execSync(`tmux bind-key -T ${KEY_TABLE} 'C-\\' run-shell "tmux kill-session -t ${session}"`, {
      stdio: 'ignore',
    });

    // Auto-enter the key table when the session gets focus
    execSync(`tmux set-hook -t ${session} client-session-changed "switch-client -T ${KEY_TABLE}"`, { stdio: 'ignore' });

    // Also enter the key table immediately for the current client
    execSync(`tmux switch-client -T ${KEY_TABLE}`, { stdio: 'ignore' });
  } catch {
    // best-effort keybindings
  }
}

/** Apply 2050 palette to tmux chrome */
function applyTmuxStyle(session: string): void {
  try {
    const cmds = [
      `set-option -t ${session} pane-border-style 'fg=${tmuxStyle.inactiveBorder}'`,
      `set-option -t ${session} pane-active-border-style 'fg=${tmuxStyle.activeBorder}'`,
      `set-option -t ${session} status off`,
      `set-option -t ${session} mouse on`,
    ];
    for (const cmd of cmds) {
      execSync(`tmux ${cmd}`, { stdio: 'ignore' });
    }
  } catch {
    // best-effort
  }
}

/** Clean up: remove key table bindings and hooks, kill session */
export function cleanup(session: string = SESSION_NAME): void {
  try {
    // Unbind from the custom key table only (not global root)
    execSync(`tmux unbind-key -T ${KEY_TABLE} Tab 2>/dev/null`, { stdio: 'ignore' });
    execSync(`tmux unbind-key -T ${KEY_TABLE} C-b 2>/dev/null`, { stdio: 'ignore' });
    execSync(`tmux unbind-key -T ${KEY_TABLE} C-t 2>/dev/null`, { stdio: 'ignore' });
    execSync(`tmux unbind-key -T ${KEY_TABLE} 'C-\\' 2>/dev/null`, { stdio: 'ignore' });
    // Remove session hook
    execSync(`tmux set-hook -u -t ${session} client-session-changed 2>/dev/null`, { stdio: 'ignore' });
    execSync(`tmux kill-session -t ${session} 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // best-effort
  }
}

/** Attach to the TUI session (blocking call) */
export function attachTuiSession(): void {
  spawnSync('tmux', ['attach-session', '-t', SESSION_NAME], { stdio: 'inherit' });
}

/** List windows in a session (for activity detection) */
export function listSessionWindows(session: string): Array<{ name: string; index: number; active: boolean }> {
  try {
    const output = execSync(
      `tmux list-windows -t ${session} -F '#{window_name}:#{window_index}:#{?window_active,1,0}' 2>/dev/null`,
      { encoding: 'utf-8' },
    ).trim();
    if (!output) return [];
    return output.split('\n').map((line) => {
      const [name, idx, active] = line.split(':');
      return { name, index: Number.parseInt(idx, 10), active: active === '1' };
    });
  } catch {
    return [];
  }
}
