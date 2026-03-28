/** TUI-specific tmux management — session, splits, tabs, keybindings */

import { execSync, spawnSync } from 'node:child_process';
import { tmuxStyle } from './theme.js';

const SESSION_NAME = 'genie-tui';
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

  // Kill any existing session
  try {
    execSync(`tmux kill-session -t ${SESSION_NAME} 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // doesn't exist
  }

  // Create session with left pane (will run OpenTUI nav)
  execSync(`tmux new-session -d -s ${SESSION_NAME} -x ${cols} -y ${rows} -e GENIE_TUI_PANE=left`, { stdio: 'ignore' });

  // Split horizontally: left = nav (OpenTUI), right = Claude Code
  execSync(`tmux split-window -h -t ${SESSION_NAME}:0 -l ${cols - NAV_WIDTH - 1}`, { stdio: 'ignore' });

  // Get pane IDs
  const panes = execSync(`tmux list-panes -t ${SESSION_NAME}:0 -F '#{pane_id}'`, { encoding: 'utf-8' })
    .trim()
    .split('\n');

  const leftPane = panes[0];
  const rightPane = panes[1] || panes[0];

  // Style the session
  applyTmuxStyle(SESSION_NAME);

  // Set up keybindings
  setupKeybindings(SESSION_NAME);

  return { session: SESSION_NAME, leftPane, rightPane };
}

/** Attach a project's tmux session in the right pane (nested) */
export function attachProject(_session: string, rightPane: string, targetSession: string): void {
  // Send command to right pane to attach nested tmux
  execSync(
    `tmux send-keys -t ${rightPane} "TMUX='' tmux attach-session -t ${targetSession} 2>/dev/null || echo 'No session: ${targetSession}'" Enter`,
    { stdio: 'ignore' },
  );
}

/** Switch right pane to a different project session */
export function switchRightPane(rightPane: string, targetSession: string): void {
  // Kill current process in right pane and attach new session
  execSync(`tmux send-keys -t ${rightPane} C-c`, { stdio: 'ignore' });
  execSync(`tmux send-keys -t ${rightPane} "" Enter`, { stdio: 'ignore' });
  setTimeout(() => {
    attachProject(SESSION_NAME, rightPane, targetSession);
  }, 100);
}

/** Style the tab bar for inner sessions (windows as tabs) */
export function styleAsTabs(targetSession: string): void {
  try {
    const cmds = [
      `set-option -t ${targetSession} status on`,
      `set-option -t ${targetSession} status-position top`,
      `set-option -t ${targetSession} status-style 'bg=${tmuxStyle.statusBg},fg=${tmuxStyle.statusFg}'`,
      `set-option -t ${targetSession} window-status-format '#[bg=${tmuxStyle.inactiveTab},fg=${tmuxStyle.statusFg}] #W '`,
      `set-option -t ${targetSession} window-status-current-format '#[bg=${tmuxStyle.activeTab},fg=white,bold] #W '`,
      `set-option -t ${targetSession} status-left ''`,
      `set-option -t ${targetSession} status-right ''`,
    ];
    for (const cmd of cmds) {
      execSync(`tmux ${cmd}`, { stdio: 'ignore' });
    }
  } catch {
    // best-effort styling
  }
}

/** Set up TUI keybindings */
function setupKeybindings(session: string): void {
  try {
    // Tab: switch focus between left and right panes
    execSync(`tmux bind-key -n Tab select-pane -t ${session}:0.+`, { stdio: 'ignore' });

    // Ctrl+B: toggle nav width (0 <> NAV_WIDTH)
    execSync(
      `tmux bind-key -n C-b if-shell "[ $(tmux display-message -p '#{pane_width}' -t ${session}:0.0) -gt 5 ]" "resize-pane -t ${session}:0.0 -x 0" "resize-pane -t ${session}:0.0 -x ${NAV_WIDTH}"`,
      { stdio: 'ignore' },
    );

    // Ctrl+T: new window in inner session (right pane)
    execSync(`tmux bind-key -n C-t send-keys -t ${session}:0.1 C-b c`, { stdio: 'ignore' });

    // Ctrl+\: detach/quit
    execSync(`tmux bind-key -n 'C-\\' run-shell "tmux kill-session -t ${session}"`, { stdio: 'ignore' });
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

/** Clean up: unbind keys, kill session */
export function cleanup(session: string = SESSION_NAME): void {
  try {
    execSync('tmux unbind-key -n Tab 2>/dev/null', { stdio: 'ignore' });
    execSync('tmux unbind-key -n C-b 2>/dev/null', { stdio: 'ignore' });
    execSync('tmux unbind-key -n C-t 2>/dev/null', { stdio: 'ignore' });
    execSync("tmux unbind-key -n 'C-\\' 2>/dev/null", { stdio: 'ignore' });
    execSync(`tmux kill-session -t ${session} 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // best-effort
  }
}

/** Attach to the TUI session (blocking call) */
export function attachTuiSession(): void {
  spawnSync('tmux', ['attach-session', '-t', SESSION_NAME], { stdio: 'inherit' });
}

/** List windows in a session (for tab bar / activity detection) */
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

/** Get pane content (last N lines) for agent state detection */
export function capturePaneLines(paneId: string, lines = 5): string {
  try {
    return execSync(`tmux capture-pane -p -t '${paneId}' -S -${lines} -E - 2>/dev/null`, { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}
