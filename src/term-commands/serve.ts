/**
 * genie serve — Infrastructure owner.
 *
 * Starts everything genie needs:
 *   - pgserve (database)
 *   - tmux -L genie server (agent sessions)
 *   - Agent sessions from workspace manifest
 *   - tmux -L genie-tui server (TUI display)
 *   - Scheduler, event-router, inbox-watcher
 *   - PID file at .genie/serve.pid
 *
 * Subcommands:
 *   genie serve           — start foreground (default)
 *   genie serve --daemon  — start background
 *   genie serve stop      — stop everything
 *   genie serve status    — show service health
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';

// ============================================================================
// Paths
// ============================================================================

function genieHome(): string {
  return process.env.GENIE_HOME ?? join(homedir(), '.genie');
}

function servePidPath(): string {
  return join(genieHome(), 'serve.pid');
}

function genieTmuxConf(): string {
  const candidates = [join(genieHome(), 'tmux.conf')];
  return candidates.find((p) => existsSync(p)) ?? '/dev/null';
}

function tuiTmuxConf(): string {
  const candidates = [join(genieHome(), 'tui-tmux.conf')];
  return candidates.find((p) => existsSync(p)) ?? '/dev/null';
}

// ============================================================================
// PID helpers
// ============================================================================

function readServePid(): number | null {
  const path = servePidPath();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8').trim();
  const pid = Number.parseInt(raw, 10);
  if (Number.isNaN(pid) || pid <= 0) return null;
  return pid;
}

function writeServePid(pid: number): void {
  mkdirSync(genieHome(), { recursive: true });
  writeFileSync(servePidPath(), String(pid), 'utf-8');
}

function removeServePid(): void {
  const path = servePidPath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {}
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// tmux helpers
// ============================================================================

const GENIE_SOCKET = 'genie';
const TUI_SOCKET = 'genie-tui';

function tmuxCmd(socket: string, conf: string, subcmd: string): string {
  return `tmux -L ${socket} -f ${conf} ${subcmd}`;
}

function genieTmux(subcmd: string): string {
  return tmuxCmd(GENIE_SOCKET, genieTmuxConf(), subcmd);
}

function tuiTmux(subcmd: string): string {
  return tmuxCmd(TUI_SOCKET, tuiTmuxConf(), subcmd);
}

/** Check if a tmux server is running on a socket */
function isTmuxServerRunning(socket: string, conf: string): boolean {
  try {
    execSync(tmuxCmd(socket, conf, 'list-sessions'), { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Start the genie agent tmux server and create sessions for all agents */
function startAgentTmuxServer(agents: string[]): void {
  const conf = genieTmuxConf();

  // Start server with a bootstrap session (tmux needs at least one)
  if (!isTmuxServerRunning(GENIE_SOCKET, conf)) {
    execSync(genieTmux('new-session -d -s _bootstrap'), { stdio: 'ignore' });
  }

  // Create a session per agent
  for (const agent of agents) {
    try {
      execSync(genieTmux(`has-session -t '${agent}'`), { stdio: 'ignore' });
    } catch {
      // Session doesn't exist — create it
      try {
        execSync(genieTmux(`new-session -d -s '${agent}'`), { stdio: 'ignore' });
      } catch {
        // race or naming conflict
      }
    }
  }

  // Kill the bootstrap session if we have real agent sessions
  if (agents.length > 0) {
    try {
      execSync(genieTmux('kill-session -t _bootstrap'), { stdio: 'ignore' });
    } catch {
      // already gone or was the only session
    }
  }
}

const TUI_SESSION = 'genie-tui';
const NAV_WIDTH = 30;
const KEY_TABLE = 'genie-tui';

/** Theme colors for TUI tmux styling */
const TUI_STYLE = {
  activeBorder: '#7c3aed',
  inactiveBorder: '#414868',
};

/** Apply visual theme to TUI session */
function applyTuiStyle(): void {
  const cmds = [
    `set-option -t ${TUI_SESSION} pane-border-style 'fg=${TUI_STYLE.inactiveBorder}'`,
    `set-option -t ${TUI_SESSION} pane-active-border-style 'fg=${TUI_STYLE.activeBorder}'`,
    `set-option -t ${TUI_SESSION} mouse off`,
    `set-option -t ${TUI_SESSION} status off`,
    `set-option -t ${TUI_SESSION} pane-border-status off`,
  ];
  for (const cmd of cmds) {
    try {
      execSync(tuiTmux(cmd), { stdio: 'ignore' });
    } catch {}
  }
}

/** Set up keybindings in a dedicated key table for TUI */
function setupTuiKeybindings(): void {
  try {
    execSync(
      tuiTmux(`bind-key -T ${KEY_TABLE} Tab select-pane -t ${TUI_SESSION}:0.1 \\; switch-client -T ${KEY_TABLE}`),
      { stdio: 'ignore' },
    );
    execSync(
      tuiTmux(
        `bind-key -T ${KEY_TABLE} C-b if-shell "[ $(tmux -L ${TUI_SOCKET} display-message -p '#\\{pane_width\\}' -t ${TUI_SESSION}:0.0) -gt 5 ]" "resize-pane -t ${TUI_SESSION}:0.0 -x 0" "resize-pane -t ${TUI_SESSION}:0.0 -x ${NAV_WIDTH}" \\; switch-client -T ${KEY_TABLE}`,
      ),
      { stdio: 'ignore' },
    );
    execSync(
      tuiTmux(`bind-key -T ${KEY_TABLE} C-t send-keys -t ${TUI_SESSION}:0.1 C-b c \\; switch-client -T ${KEY_TABLE}`),
      { stdio: 'ignore' },
    );
    execSync(tuiTmux(`bind-key -T ${KEY_TABLE} C-q run-shell "tmux -L ${TUI_SOCKET} kill-session -t ${TUI_SESSION}"`), {
      stdio: 'ignore',
    });
    execSync(
      tuiTmux(`bind-key -T ${KEY_TABLE} 'C-\\\\' run-shell "tmux -L ${TUI_SOCKET} kill-session -t ${TUI_SESSION}"`),
      { stdio: 'ignore' },
    );
    execSync(tuiTmux(`set-hook -t ${TUI_SESSION} client-session-changed "switch-client -T ${KEY_TABLE}"`), {
      stdio: 'ignore',
    });
  } catch {}
}

/**
 * Start the TUI tmux server with full session setup:
 * left pane (nav) + right pane (agent display).
 * If session already exists (serve restart), reuse it.
 */
function startTuiTmuxServer(): { leftPane: string; rightPane: string } {
  // Check if session already exists
  try {
    execSync(tuiTmux(`has-session -t ${TUI_SESSION}`), { stdio: 'ignore' });
    // Session exists — reuse it
    const panes = execSync(tuiTmux(`list-panes -t ${TUI_SESSION}:0 -F '#{pane_id}'`), { encoding: 'utf-8' })
      .trim()
      .split('\n');
    return { leftPane: panes[0], rightPane: panes[1] || panes[0] };
  } catch {
    // Session doesn't exist — create it
  }

  const cols = 120;
  const rows = 40;

  execSync(tuiTmux(`new-session -d -s ${TUI_SESSION} -x ${cols} -y ${rows} -e GENIE_TUI_PANE=left`), {
    stdio: 'ignore',
  });
  execSync(tuiTmux(`split-window -h -t ${TUI_SESSION}:0 -l ${cols - NAV_WIDTH - 1}`), { stdio: 'ignore' });

  const panes = execSync(tuiTmux(`list-panes -t ${TUI_SESSION}:0 -F '#{pane_id}'`), { encoding: 'utf-8' })
    .trim()
    .split('\n');

  applyTuiStyle();
  setupTuiKeybindings();

  return { leftPane: panes[0], rightPane: panes[1] || panes[0] };
}

/**
 * Send TUI launch script to left pane.
 * Writes ~/.genie/tui-launch.sh with workspace env vars, sends it to the pane.
 */
function sendTuiLaunchScript(leftPane: string, rightPane: string, workspaceRoot?: string): void {
  const home = genieHome();
  const bunPath = process.execPath || 'bun';
  const genieBin = process.argv[1] || 'genie';
  const scriptPath = join(home, 'tui-launch.sh');

  const envVars = ['GENIE_TUI_PANE=left', `GENIE_TUI_RIGHT=${rightPane}`];
  if (workspaceRoot) envVars.push(`GENIE_TUI_WORKSPACE=${workspaceRoot}`);

  const content = `#!/bin/sh\nexport ${envVars.join('\nexport ')}\nexec ${bunPath} ${genieBin}\n`;
  writeFileSync(scriptPath, content, { mode: 0o755 });

  try {
    execSync(tuiTmux(`send-keys -t '${leftPane}' '${scriptPath}' Enter`), { stdio: 'ignore' });
  } catch {}
}

/** Kill a tmux server by socket */
function killTmuxServer(socket: string, conf: string): void {
  try {
    execSync(tmuxCmd(socket, conf, 'kill-server'), { stdio: 'ignore' });
  } catch {
    // not running
  }
}

/** List sessions on the genie agent socket */
function listAgentSessions(): string[] {
  try {
    const out = execSync(genieTmux("list-sessions -F '#{session_name}'"), { encoding: 'utf-8' });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// ============================================================================
// Workspace agent scanning
// ============================================================================

/** Scan for agents from workspace.json and filesystem */
function discoverAgents(): string[] {
  try {
    const { findWorkspace, scanAgents } = require('../lib/workspace.js') as typeof import('../lib/workspace.js');
    const ws = findWorkspace();
    if (!ws) return [];
    return scanAgents(ws.root);
  } catch {
    return [];
  }
}

// ============================================================================
// Service management
// ============================================================================

interface DaemonHandles {
  schedulerHandle: { stop: () => void; done: Promise<void> } | null;
}

const handles: DaemonHandles = { schedulerHandle: null };

/** Start all services in foreground mode */
async function startForeground(): Promise<void> {
  const existingPid = readServePid();
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(`genie serve already running (PID ${existingPid})`);
    process.exit(0);
  }
  if (existingPid) removeServePid();

  process.env.GENIE_IS_DAEMON = '1';
  writeServePid(process.pid);

  console.log(`genie serve starting (PID ${process.pid})`);

  // 1. Start pgserve
  console.log('  Starting pgserve...');
  try {
    const { ensurePgserve } = await import('../lib/db.js');
    const port = await ensurePgserve();
    console.log(`  pgserve ready on port ${port}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  pgserve failed: ${msg}`);
  }

  // 2. Start genie agent tmux server + agent sessions
  const agents = discoverAgents();
  console.log(`  Starting tmux -L ${GENIE_SOCKET} server...`);
  startAgentTmuxServer(agents);
  const sessions = listAgentSessions();
  console.log(`  Agent sessions: ${sessions.length > 0 ? sessions.join(', ') : '(none)'}`);

  // 3. Start TUI tmux server with split layout
  console.log(`  Starting tmux -L ${TUI_SOCKET} server...`);
  const { leftPane, rightPane } = startTuiTmuxServer();

  // 4. Send launch script to left pane (discovers workspace from serve cwd)
  const ws = (() => {
    try {
      const { findWorkspace } = require('../lib/workspace.js') as typeof import('../lib/workspace.js');
      return findWorkspace();
    } catch {
      return null;
    }
  })();
  sendTuiLaunchScript(leftPane, rightPane, ws?.root);
  console.log('  TUI server ready (session: genie-tui)');

  // 4. Start scheduler + event-router + inbox-watcher
  console.log('  Starting scheduler daemon...');
  try {
    const { startDaemon } = await import('../lib/scheduler-daemon.js');
    handles.schedulerHandle = startDaemon();
    console.log('  Scheduler started (includes event-router + inbox-watcher)');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Scheduler failed: ${msg}`);
  }

  console.log('\ngenie serve is running. Press Ctrl+C to stop.');

  // Signal handlers for graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down genie serve...');
    handles.schedulerHandle?.stop();
    killTmuxServer(TUI_SOCKET, tuiTmuxConf());
    killTmuxServer(GENIE_SOCKET, genieTmuxConf());
    removeServePid();
    console.log('genie serve stopped.');
  };

  process.on('SIGTERM', () => {
    shutdown();
    process.exit(143);
  });
  process.on('SIGINT', () => {
    shutdown();
    process.exit(130);
  });

  // Wait for scheduler to finish (blocks forever until signal)
  if (handles.schedulerHandle) {
    await handles.schedulerHandle.done;
  } else {
    // No scheduler — just keep alive
    await new Promise(() => {});
  }

  removeServePid();
}

/** Start as a background daemon */
async function startBackground(): Promise<void> {
  const existingPid = readServePid();
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(`genie serve already running (PID ${existingPid})`);
    process.exit(0);
  }
  if (existingPid) removeServePid();

  const bunPath = process.execPath ?? 'bun';
  const genieBin = process.argv[1] ?? 'genie';

  const child = spawn(bunPath, [genieBin, 'serve', '--foreground'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, GENIE_IS_DAEMON: '1' },
  });

  child.unref();

  if (child.pid) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (isProcessAlive(child.pid)) {
      console.log(`genie serve started (PID ${child.pid})`);
    } else {
      console.error('Error: genie serve exited immediately.');
      process.exit(1);
    }
  } else {
    console.error('Error: failed to spawn genie serve');
    process.exit(1);
  }
}

/** Stop genie serve and all child services */
async function stopServe(): Promise<void> {
  const pid = readServePid();

  if (!pid) {
    console.log('genie serve is not running (no PID file).');
    return;
  }

  if (!isProcessAlive(pid)) {
    console.log(`Stale PID file (PID ${pid} not running). Cleaning up.`);
    removeServePid();
    // Still kill tmux servers in case they're orphaned
    killTmuxServer(TUI_SOCKET, tuiTmuxConf());
    killTmuxServer(GENIE_SOCKET, genieTmuxConf());
    return;
  }

  console.log(`Stopping genie serve (PID ${pid})...`);

  // Send SIGTERM to the process group
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }

  // Wait up to 10s for graceful shutdown
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (isProcessAlive(pid)) {
    console.log('Did not stop within 10s. Sending SIGKILL.');
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }

  // Clean up tmux servers
  killTmuxServer(TUI_SOCKET, tuiTmuxConf());
  killTmuxServer(GENIE_SOCKET, genieTmuxConf());

  removeServePid();
  console.log('genie serve stopped.');
}

/** Check pgserve health and print status */
async function printPgserveStatus(): Promise<void> {
  try {
    const { isAvailable, getActivePort } = await import('../lib/db.js');
    const dbOk = await isAvailable();
    console.log(`  pgserve:    ${dbOk ? `healthy (port ${getActivePort()})` : 'unreachable'}`);
  } catch {
    console.log('  pgserve:    unavailable');
  }
}

/** Print tmux server statuses */
function printTmuxStatus(): void {
  const agentRunning = isTmuxServerRunning(GENIE_SOCKET, genieTmuxConf());
  const sessions = agentRunning ? listAgentSessions() : [];
  console.log(`  tmux -L ${GENIE_SOCKET}: ${agentRunning ? `running (${sessions.length} sessions)` : 'stopped'}`);
  if (sessions.length > 0) {
    console.log(`              ${sessions.join(', ')}`);
  }

  const tuiRunning = isTmuxServerRunning(TUI_SOCKET, tuiTmuxConf());
  console.log(`  tmux -L ${TUI_SOCKET}: ${tuiRunning ? 'running' : 'stopped'}`);
}

/** Print scheduler and inbox status */
async function printDaemonStatus(serveRunning: boolean): Promise<void> {
  try {
    const schedulerPidPath = join(genieHome(), 'scheduler.pid');
    if (existsSync(schedulerPidPath)) {
      const sPid = Number.parseInt(readFileSync(schedulerPidPath, 'utf-8').trim(), 10);
      const sAlive = !Number.isNaN(sPid) && isProcessAlive(sPid);
      console.log(`  scheduler:  ${sAlive ? `running (PID ${sPid})` : 'stopped'}`);
    } else if (serveRunning) {
      console.log('  scheduler:  integrated (in-process)');
    } else {
      console.log('  scheduler:  stopped');
    }
  } catch {
    console.log('  scheduler:  unknown');
  }

  try {
    const { getInboxPollIntervalMs } = await import('../lib/inbox-watcher.js');
    const pollMs = getInboxPollIntervalMs();
    if (pollMs === 0) {
      console.log('  inbox:      disabled');
    } else {
      console.log(`  inbox:      ${serveRunning ? 'watching' : 'stopped'} (poll ${pollMs / 1000}s)`);
    }
  } catch {
    console.log('  inbox:      unavailable');
  }
}

/** Show service health */
async function statusServe(): Promise<void> {
  const pid = readServePid();
  const running = pid !== null && isProcessAlive(pid);

  console.log('\nGenie Serve');
  console.log('─'.repeat(50));
  console.log(`  Status:     ${running ? 'running' : 'stopped'}`);

  if (running && pid) {
    console.log(`  PID:        ${pid}`);
  }

  await printPgserveStatus();
  printTmuxStatus();
  await printDaemonStatus(running);

  console.log(`  PID file:   ${servePidPath()}`);
  console.log('');
}

// ============================================================================
// Registration
// ============================================================================

interface ServeStartOptions {
  daemon?: boolean;
  foreground?: boolean;
}

export function registerServeCommands(program: Command): void {
  const serve = program.command('serve').description('Start all genie infrastructure (pgserve, tmux, scheduler)');

  serve
    .command('start', { isDefault: true })
    .description('Start genie serve')
    .option('--daemon', 'Run in background')
    .option('--foreground', 'Run in foreground (default)')
    .action(async (options: ServeStartOptions) => {
      if (options.daemon) {
        await startBackground();
      } else {
        await startForeground();
      }
    });

  serve
    .command('stop')
    .description('Stop genie serve and all services')
    .action(async () => {
      await stopServe();
    });

  serve
    .command('status')
    .description('Show service health')
    .action(async () => {
      await statusServe();
    });
}
