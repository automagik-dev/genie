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
  if (process.env.TMUX) {
    // Already inside a tmux session — switch-client avoids nested attach
    runTuiTmux(['switch-client', '-t', SESSION_NAME], 'inherit');
  } else {
    runTuiTmux(['attach-session', '-t', SESSION_NAME], 'inherit');
  }
}

/** Find the next numeric suffix for a role name by listing tmux windows in the agent's session. */
function nextRoleSuffix(baseName: string): number {
  const sessionName = baseName.replace(/\//g, '-');
  // Use `=` prefix to force literal session-name match. Without it, tmux
  // interprets values like `@46` as window-id syntax (`@N`) instead of
  // session names, causing "can't find window" errors for anonymously-named
  // sessions created by `genie spawn --new-window`.
  const output = spawnSync(
    TMUX_BIN,
    ['-L', GENIE_AGENT_SOCKET, 'list-windows', '-t', `=${sessionName}`, '-F', '#{window_name}'],
    {
      encoding: 'utf-8',
    },
  );
  const names = output.status === 0 ? output.stdout.trim().split('\n') : [];
  // Count existing windows + check for existing suffixed roles
  let max = names.length + 1;
  const re = new RegExp(`^${baseName}-(\\d+)$`);
  for (const n of names) {
    const m = n.match(re);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10) + 1);
  }
  return max;
}

/** Spawn a fresh parallel worker of the same agent type via `genie spawn`. */
export function newAgentWindow(agentName: string): void {
  // Reconcile stale spawns first to clear dead workers that block the duplicate guard
  void (async () => {
    try {
      const { reconcileStaleSpawns } = await import('../lib/agent-registry.js');
      await reconcileStaleSpawns();
    } catch {
      // best-effort
    }

    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const { join, resolve } = require('node:path') as typeof import('node:path');
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    const bunPath = process.execPath || 'bun';
    const genieBin = process.argv[1];
    const wsRoot = process.env.GENIE_TUI_WORKSPACE;

    let cwd: string | undefined;
    if (wsRoot) {
      const parentName = agentName.includes('/') ? agentName.slice(0, agentName.indexOf('/')) : agentName;
      const agentDir = resolve(join(wsRoot, 'agents', parentName));
      if (existsSync(agentDir)) cwd = agentDir;
    }

    const suffix = nextRoleSuffix(agentName);
    const role = `${agentName}-${suffix}`;
    const sessionName = agentName.replace(/\//g, '-');
    const args = ['spawn', agentName, '--role', role, '--session', sessionName, '--new-window'];
    const child =
      genieBin && genieBin !== 'genie'
        ? spawn(bunPath, [genieBin, ...args], { detached: true, stdio: 'ignore', cwd })
        : spawn('genie', args, { detached: true, stdio: 'ignore', cwd });
    child.unref();
  })();
}
