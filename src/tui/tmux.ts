/**
 * TUI tmux runtime helpers — attach, navigate, pane management.
 *
 * TUI session lives on the DEFAULT tmux server (no -L flag).
 * Agent sessions live on the genie server (-L genie).
 * This module bridges the two for the right-pane attach.
 */

import { execSync, spawnSync } from 'node:child_process';

const SESSION_NAME = 'genie-tui';
/** Genie's agent tmux socket — where all agents/teams/sessions live. */
const GENIE_AGENT_SOCKET = 'genie';

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
    // Respawn right pane with a while-true loop so it survives agent exit.
    // When the inner attach ends (agent exits or detach), the loop re-attaches.
    // If the session is destroyed, attach fails quickly and retries after sleep.
    // Selecting a different agent calls respawn-pane -k again, killing this loop.
    const attachCmd = `tmux -L ${GENIE_AGENT_SOCKET} attach-session -t '${targetSession}'`;
    execSync(`tmux respawn-pane -k -t ${pane} "TMUX='' while true; do ${attachCmd} 2>/dev/null; sleep 0.5; done"`, {
      stdio: 'ignore',
    });
  } catch {
    // pane doesn't exist or command failed
  }
}

/** Attach to the TUI session on default tmux server (blocking call) */
export function attachTuiSession(): void {
  spawnSync('tmux', ['attach-session', '-t', SESSION_NAME], { stdio: 'inherit' });
}
