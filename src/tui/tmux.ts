/** TUI-specific tmux management — session, splits, tabs, keybindings */

import { execSync, spawnSync } from 'node:child_process';
import { tmuxStyle } from './theme.js';

const SESSION_NAME = 'genie-tui';
const KEY_TABLE = 'genie-tui';
const NAV_WIDTH = 30;
/** TUI's own tmux socket — isolates the nav+split from everything else */
const TMUX_SOCKET = 'genie-tui';
/**
 * Genie's agent tmux socket — where all agents/teams/sessions live.
 * The TUI's right pane attaches to sessions on THIS server.
 * TODO: migrate all of genie (spawn, daemon, etc) to use -L genie. For now, agents run on default server.
 */
const GENIE_AGENT_SOCKET = ''; // empty = default server (until full migration)
/**
 * Genie's shipped tmux config — scripts/tmux/genie.tmux.conf installed to ~/.genie/tmux.conf
 * on genie setup/update. Falls back to /dev/null if not found (still works with applyTmuxStyle).
 */
const GENIE_TMUX_CONF = (() => {
  const { existsSync } = require('node:fs') as typeof import('node:fs');
  const candidates = [
    `${process.env.GENIE_HOME ?? `${process.env.HOME}/.genie`}/tmux.conf`,
    `${process.env.HOME}/.tmux.conf`,
  ];
  return candidates.find((p) => existsSync(p)) ?? '/dev/null';
})();
/** Prefix for all tmux commands — dedicated socket + genie config (ignores user's global tmux) */
const TMUX = `tmux -L ${TMUX_SOCKET} -f ${GENIE_TMUX_CONF}`;

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
    execSync(`${TMUX} kill-session -t ${SESSION_NAME} 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // doesn't exist
  }

  execSync(`${TMUX} new-session -d -s ${SESSION_NAME} -x ${cols} -y ${rows} -e GENIE_TUI_PANE=left`, {
    stdio: 'ignore',
  });
  execSync(`${TMUX} split-window -h -t ${SESSION_NAME}:0 -l ${cols - NAV_WIDTH - 1}`, { stdio: 'ignore' });

  const panes = execSync(`${TMUX} list-panes -t ${SESSION_NAME}:0 -F '#{pane_id}'`, { encoding: 'utf-8' })
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
    execSync(`${TMUX} display-message -t ${rightPane} -p ''`, { stdio: 'ignore' });
    return rightPane;
  } catch {
    try {
      const panes = execSync(`${TMUX} list-panes -t ${SESSION_NAME}:0 -F '#{pane_id}'`, { encoding: 'utf-8' })
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
    execSync(`${TMUX} has-session -t '${sessionName}' 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    try {
      execSync(`${TMUX} new-session -d -s '${sessionName}'`, { stdio: 'ignore' });
    } catch {
      // race: another process created it
    }
  }
}

/** Switch right pane to a specific session window */
export function attachProjectWindow(rightPane: string, targetSession: string, windowIndex?: number): void {
  // Guard: never attach the TUI session to itself (causes infinite loop)
  if (targetSession === SESSION_NAME) return;
  const pane = resolveRightPane(rightPane);
  ensureSession(targetSession);
  if (windowIndex !== undefined) {
    try {
      execSync(`${TMUX} select-window -t '${targetSession}:${windowIndex}'`, { stdio: 'ignore' });
    } catch {
      // window may not exist
    }
  }
  try {
    // Attach to sessions on the AGENT server (default for now, -L genie after migration)
    const agentTmux = GENIE_AGENT_SOCKET ? `tmux -L ${GENIE_AGENT_SOCKET}` : 'tmux';
    execSync(`${TMUX} respawn-pane -k -t ${pane} "TMUX='' ${agentTmux} attach-session -t '${targetSession}'"`, {
      stdio: 'ignore',
    });
  } catch {
    // pane doesn't exist
  }
}

/**
 * Set up TUI keybindings in a dedicated key table (not global root).
 * Uses a custom key table "genie-tui" so bindings only apply inside the TUI session.
 * The session hooks switch-client into this table on focus.
 */
function setupKeybindings(session: string): void {
  try {
    // Define bindings in the genie-tui key table (session-scoped, not global)
    execSync(`${TMUX} bind-key -T ${KEY_TABLE} Tab select-pane -t ${session}:0.1 \\; switch-client -T ${KEY_TABLE}`, {
      stdio: 'ignore',
    });

    execSync(
      `${TMUX} bind-key -T ${KEY_TABLE} C-b if-shell "[ $(${TMUX} display-message -p '#{pane_width}' -t ${session}:0.0) -gt 5 ]" "resize-pane -t ${session}:0.0 -x 0" "resize-pane -t ${session}:0.0 -x ${NAV_WIDTH}" \\; switch-client -T ${KEY_TABLE}`,
      { stdio: 'ignore' },
    );

    execSync(
      `${TMUX} bind-key -T ${KEY_TABLE} C-t send-keys -t ${session}:0.1 C-b c \\; switch-client -T ${KEY_TABLE}`,
      {
        stdio: 'ignore',
      },
    );

    execSync(`${TMUX} bind-key -T ${KEY_TABLE} 'C-\\' run-shell "tmux -L ${TMUX_SOCKET} kill-session -t ${session}"`, {
      stdio: 'ignore',
    });

    // Ctrl+Q: kill entire TUI session (both panes die together)
    execSync(`${TMUX} bind-key -T ${KEY_TABLE} C-q run-shell "tmux -L ${TMUX_SOCKET} kill-session -t ${session}"`, {
      stdio: 'ignore',
    });

    // Auto-enter the key table when the session gets focus
    execSync(`${TMUX} set-hook -t ${session} client-session-changed "switch-client -T ${KEY_TABLE}"`, {
      stdio: 'ignore',
    });

    // Also enter the key table immediately for the current client
    execSync(`${TMUX} switch-client -T ${KEY_TABLE}`, { stdio: 'ignore' });
  } catch {
    // best-effort keybindings
  }
}

/** Apply visual theme to TUI session (config file handles terminal settings) */
function applyTmuxStyle(session: string): void {
  try {
    const cmds = [
      // Visual theme
      `set-option -t ${session} pane-border-style 'fg=${tmuxStyle.inactiveBorder}'`,
      `set-option -t ${session} pane-active-border-style 'fg=${tmuxStyle.activeBorder}'`,
      // TUI overrides — the config has mouse on + status bars, but TUI handles these itself
      `set-option -t ${session} mouse off`,
      `set-option -t ${session} status off`,
      `set-option -t ${session} pane-border-status off`,
    ];
    for (const cmd of cmds) {
      execSync(`${TMUX} ${cmd}`, { stdio: 'ignore' });
    }
  } catch {
    // best-effort
  }
}

/** Clean up: remove key table bindings and hooks, kill session */
export function cleanup(session: string = SESSION_NAME): void {
  try {
    // Unbind from the custom key table only (not global root)
    execSync(`${TMUX} unbind-key -T ${KEY_TABLE} Tab 2>/dev/null`, { stdio: 'ignore' });
    execSync(`${TMUX} unbind-key -T ${KEY_TABLE} C-b 2>/dev/null`, { stdio: 'ignore' });
    execSync(`${TMUX} unbind-key -T ${KEY_TABLE} C-t 2>/dev/null`, { stdio: 'ignore' });
    execSync(`${TMUX} unbind-key -T ${KEY_TABLE} 'C-\\' 2>/dev/null`, { stdio: 'ignore' });
    // Remove session hook
    execSync(`${TMUX} set-hook -u -t ${session} client-session-changed 2>/dev/null`, { stdio: 'ignore' });
    execSync(`${TMUX} kill-session -t ${session} 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // best-effort
  }
}

/** Attach to the TUI session (blocking call) */
export function attachTuiSession(): void {
  spawnSync('tmux', ['-L', TMUX_SOCKET, '-f', GENIE_TMUX_CONF, 'attach-session', '-t', SESSION_NAME], {
    stdio: 'inherit',
  });
}
