/**
 * TUI tmux runtime helpers — attach, navigate, pane management.
 *
 * Session creation is handled by `genie serve` (see serve.ts).
 * This module only provides runtime operations for the TUI client.
 */

import { execSync, spawnSync } from 'node:child_process';

const SESSION_NAME = 'genie-tui';
/** TUI's own tmux socket — isolates the nav+split from everything else */
const TMUX_SOCKET = 'genie-tui';
/** Genie's agent tmux socket — where all agents/teams/sessions live. */
const GENIE_AGENT_SOCKET = 'genie';
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

/** Ensure a tmux session exists on the agent server, creating it if needed */
function ensureAgentSession(sessionName: string): void {
  const agentTmux = `tmux -L ${GENIE_AGENT_SOCKET}`;
  try {
    execSync(`${agentTmux} has-session -t '${sessionName}' 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    try {
      execSync(`${agentTmux} new-session -d -s '${sessionName}'`, { stdio: 'ignore' });
    } catch {
      // race: another process created it
    }
  }
}

/** Switch right pane to a specific session window on the genie agent server */
export function attachProjectWindow(rightPane: string, targetSession: string, windowIndex?: number): void {
  // Guard: never attach the TUI session to itself (causes infinite loop)
  if (targetSession === SESSION_NAME) return;
  const pane = resolveRightPane(rightPane);
  ensureAgentSession(targetSession);
  if (windowIndex !== undefined) {
    try {
      const agentTmux = `tmux -L ${GENIE_AGENT_SOCKET}`;
      execSync(`${agentTmux} select-window -t '${targetSession}:${windowIndex}'`, { stdio: 'ignore' });
    } catch {
      // window may not exist
    }
  }
  try {
    // Attach to sessions on the genie agent server.
    // Use a wrapper script that clears probe artifacts:
    // 1. Sleep briefly so tmux finishes its terminal capability detection
    // 2. Clear screen to hide probe escape sequences
    // 3. Attach to the agent session
    const agentTmux = `tmux -L ${GENIE_AGENT_SOCKET}`;
    const attachCmd = `sleep 0.1 && printf '\\033[2J\\033[H' && TMUX='' ${agentTmux} attach-session -t '${targetSession}'`;
    execSync(`${TMUX} respawn-pane -k -t ${pane} "sh -c \\"${attachCmd}\\""`, {
      stdio: 'ignore',
    });
  } catch {
    // pane doesn't exist
  }
}

/** Attach to the TUI session (blocking call) */
export function attachTuiSession(): void {
  spawnSync('tmux', ['-L', TMUX_SOCKET, '-f', GENIE_TMUX_CONF, 'attach-session', '-t', SESSION_NAME], {
    stdio: 'inherit',
  });
}
