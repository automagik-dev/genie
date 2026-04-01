/**
 * TUI tmux runtime helpers — attach, navigate, pane management.
 *
 * Session creation is handled by `genie serve` (see serve.ts).
 * This module only provides runtime operations for the TUI client.
 */

import { spawnSync } from 'node:child_process';
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
const TMUX_BIN = tmuxBin();

function runTuiTmux(args: string[], stdio: 'ignore' | 'inherit' = 'ignore') {
  return spawnSync(TMUX_BIN, ['-L', TMUX_SOCKET, '-f', TUI_TMUX_CONF, ...args], { stdio });
}

function runTuiTmuxOutput(args: string[]): string | null {
  const result = spawnSync(TMUX_BIN, ['-L', TMUX_SOCKET, '-f', TUI_TMUX_CONF, ...args], { encoding: 'utf-8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function runAgentTmux(args: string[], stdio: 'ignore' | 'inherit' = 'ignore') {
  return spawnSync(TMUX_BIN, ['-L', GENIE_AGENT_SOCKET, ...args], { stdio });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildAttachLoop(targetSession: string): string {
  const attachCommand = [TMUX_BIN, '-L', GENIE_AGENT_SOCKET, 'attach-session', '-t', targetSession]
    .map(shellQuote)
    .join(' ');
  return `while true; do TMUX='' ${attachCommand} 2>/dev/null; sleep 0.3; done`;
}

function resolveRightPane(rightPane: string): string {
  if (runTuiTmux(['display-message', '-t', rightPane, '-p', '']).status === 0) {
    return rightPane;
  }

  const panes = runTuiTmuxOutput(['list-panes', '-t', `${SESSION_NAME}:0`, '-F', '#{pane_id}'])?.split('\n') ?? [];
  return panes[1] || panes[0] || rightPane;
}

export function hasProjectSession(targetSession: string): boolean {
  return runAgentTmux(['has-session', '-t', targetSession]).status === 0;
}

/** Switch right pane to a specific agent session. NEVER kills the pane. */
export function attachProjectWindow(rightPane: string, targetSession: string, windowIndex?: number): void {
  if (targetSession === SESSION_NAME) return;
  const pane = resolveRightPane(rightPane);

  // Ensure agent session exists
  if (!hasProjectSession(targetSession)) return; // No session — don't create empty ones, don't kill the pane

  if (windowIndex !== undefined) {
    runAgentTmux(['select-window', '-t', `${targetSession}:${windowIndex}`]);
  }

  // Hide green status bar
  runAgentTmux(['set-option', '-t', targetSession, 'status', 'off']);

  // respawn-pane with a loop wrapper — the pane process is bash running a loop,
  // so if the attach ends (agent exit, detach), the loop retries and the pane survives.
  runTuiTmux(['respawn-pane', '-k', '-t', pane, 'sh', '-lc', buildAttachLoop(targetSession)]);

  // Restore focus to left pane
  runTuiTmux(['select-pane', '-t', `${SESSION_NAME}:0.0`]);
}

export function attachTuiSession(): void {
  runTuiTmux(['attach-session', '-t', SESSION_NAME], 'inherit');
}

/** Create a new claude window in an agent's session on the genie tmux server. */
export function newAgentWindow(sessionName: string): void {
  // Find the spawn script for this agent — it contains the full claude command with all flags
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const scriptsDir = join(process.env.GENIE_HOME ?? `${process.env.HOME}/.genie`, 'spawn-scripts');
  try {
    const scripts = readdirSync(scriptsDir);
    // Match spawn script by session name prefix (e.g., "genie-ceo-*.sh" for session "ceo")
    const prefix = `genie-${sessionName}-`;
    const script = scripts.find((f: string) => f.startsWith(prefix) && f.endsWith('.sh'));
    if (script) {
      runAgentTmux(['new-window', '-t', sessionName, 'sh', '-c', join(scriptsDir, script)]);
      return;
    }
  } catch {
    // scripts dir missing — fall back
  }
  // Fallback: create a plain window (better than nothing)
  runAgentTmux(['new-window', '-t', sessionName]);
}
