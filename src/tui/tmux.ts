/**
 * TUI tmux runtime helpers — attach, navigate, pane management.
 *
 * Session creation is handled by `genie serve` (see serve.ts).
 * This module only provides runtime operations for the TUI client.
 */

import { execSync, spawnSync } from 'node:child_process';
import { tmuxBin } from '../lib/ensure-tmux.js';

const SESSION_NAME = 'genie-tui';
const TMUX_SOCKET = 'genie-tui';
const GENIE_AGENT_SOCKET = 'genie';
const TUI_TMUX_CONF = (() => {
  const { existsSync } = require('node:fs') as typeof import('node:fs');
  const home = process.env.GENIE_HOME ?? `${process.env.HOME}/.genie`;
  const tuiConf = `${home}/tui-tmux.conf`;
  return existsSync(tuiConf) ? tuiConf : '/dev/null';
})();
const TMUX = `${tmuxBin()} -L ${TMUX_SOCKET} -f ${TUI_TMUX_CONF}`;

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

/** Switch right pane to a specific agent session. NEVER kills the pane. */
export function attachProjectWindow(rightPane: string, targetSession: string, windowIndex?: number): void {
  if (targetSession === SESSION_NAME) return;
  const pane = resolveRightPane(rightPane);
  const agentTmux = `${tmuxBin()} -L ${GENIE_AGENT_SOCKET}`;

  // Ensure agent session exists
  try {
    execSync(`${agentTmux} has-session -t '${targetSession}' 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    return; // No session — don't create empty ones, don't kill the pane
  }

  if (windowIndex !== undefined) {
    try {
      execSync(`${agentTmux} select-window -t '${targetSession}:${windowIndex}'`, { stdio: 'ignore' });
    } catch {}
  }

  // Hide green status bar
  try {
    execSync(`${agentTmux} set-option -t '${targetSession}' status off 2>/dev/null`, { stdio: 'ignore' });
  } catch {}

  // respawn-pane with a loop wrapper — the pane process is bash running a loop,
  // so if the attach ends (agent exit, detach), the loop retries and the pane survives.
  try {
    const cmd = `while true; do TMUX='' ${agentTmux} attach-session -t '${targetSession}' 2>/dev/null; sleep 0.3; done`;
    execSync(`${TMUX} respawn-pane -k -t ${pane} "bash -c '${cmd}'"`, { stdio: 'ignore' });
  } catch {}

  // Restore focus to left pane
  try {
    execSync(`${TMUX} select-pane -t ${SESSION_NAME}:0.0`, { stdio: 'ignore' });
  } catch {}
}

export function attachTuiSession(): void {
  spawnSync(tmuxBin(), ['-L', TMUX_SOCKET, '-f', TUI_TMUX_CONF, 'attach-session', '-t', SESSION_NAME], {
    stdio: 'inherit',
  });
}
