/**
 * genie serve — Infrastructure owner.
 *
 * Starts everything genie needs:
 *   - pgserve (database)
 *   - tmux -L genie server (agent sessions)
 *   - Agent sessions from workspace manifest
 *   - TUI session on default tmux server (unless --headless)
 *   - Scheduler, event-router, inbox-watcher
 *   - PID file at .genie/serve.pid
 *
 * Subcommands:
 *   genie serve             — start foreground with TUI (default)
 *   genie serve --headless  — start without TUI (services only)
 *   genie serve --daemon    — start background
 *   genie serve stop        — stop everything
 *   genie serve status      — show service health
 */

import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { palette } from '../../packages/genie-tokens';
import { ensureTmux, tmuxBin } from '../lib/ensure-tmux.js';
import { getProcessStartTime } from '../lib/process-identity.js';
import { genieTmuxCmd } from '../lib/tmux-wrapper.js';
import { isTuiDisabled, noticeTuiSkipped } from '../lib/tui-disable.js';

// ============================================================================
// Paths
// ============================================================================

function genieHome(): string {
  return process.env.GENIE_HOME ?? join(homedir(), '.genie');
}

function servePidPath(): string {
  return join(genieHome(), 'serve.pid');
}

// TUI uses default tmux server (no separate socket or config)

// ============================================================================
// PID helpers
// ============================================================================

/**
 * Result of parsing `~/.genie/serve.pid`.
 * `startTime === null` means the file is in the legacy single-PID format
 * (treat as stale) or the kernel lookup failed at write time.
 */
interface ServePidEntry {
  pid: number;
  startTime: string | null;
}

/**
 * Read `~/.genie/serve.pid`. Accepts both the new `{pid}:{startTime}` format
 * and the legacy single-PID format (returned with `startTime: null` so
 * callers treat it as stale — forces a one-time respawn on upgrade).
 */
function readServePid(): ServePidEntry | null {
  const path = servePidPath();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8').trim();
  if (raw === '') return null;

  const sepIdx = raw.indexOf(':');
  if (sepIdx < 0) {
    // Legacy single-PID format from an older install.
    const pid = Number.parseInt(raw, 10);
    if (Number.isNaN(pid) || pid <= 0) return null;
    return { pid, startTime: null };
  }

  const pidPart = raw.slice(0, sepIdx);
  const startTimePart = raw.slice(sepIdx + 1).trim();
  const pid = Number.parseInt(pidPart, 10);
  if (Number.isNaN(pid) || pid <= 0) return null;
  const startTime = startTimePart === '' || startTimePart === 'unknown' ? null : startTimePart;
  return { pid, startTime };
}

function writeServePid(pid: number): void {
  mkdirSync(genieHome(), { recursive: true });
  const startTime = getProcessStartTime(pid) ?? 'unknown';
  writeFileSync(servePidPath(), `${pid}:${startTime}`, 'utf-8');
}

/**
 * Remove `~/.genie/serve.pid` — but only if it still belongs to us. A new
 * serve may have raced in between our shutdown handler firing and this call;
 * unlinking its file would orphan the new daemon from autoStartDaemon's
 * identity check.
 */
function removeServePid(): void {
  const path = servePidPath();
  if (!existsSync(path)) return;
  try {
    const current = readServePid();
    if (current && current.pid !== process.pid) {
      // Another serve owns the file now — leave it alone.
      return;
    }
    unlinkSync(path);
  } catch {}
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

const TUI_SESSION = 'genie-tui';

/** TUI tmux config — minimal, no shell probes, no prefix key interference */
function tuiTmuxConf(): string {
  const candidates = [join(genieHome(), 'tui-tmux.conf')];
  return candidates.find((p) => existsSync(p)) ?? '/dev/null';
}

/** TUI tmux command — uses -L genie-tui socket + minimal TUI config */
function tuiTmux(subcmd: string): string {
  return `${tmuxBin()} -L genie-tui -f ${tuiTmuxConf()} ${subcmd}`;
}

/** Check if a tmux server is running on a socket */
function isGenieTmuxRunning(): boolean {
  try {
    execSync(genieTmuxCmd('list-sessions'), { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const NAV_WIDTH = 30;

/** Theme colors for TUI tmux styling */
const TUI_STYLE = {
  activeBorder: palette.borderActive,
  inactiveBorder: palette.border,
};

export function getTuiKeybindings(sessionName = TUI_SESSION): string[] {
  return [
    // Tab: toggle focus between left nav (pane 0) and right terminal (pane 1)
    `bind-key -T root Tab if-shell "[ '#{pane_index}' = '0' ]" "select-pane -t ${sessionName}:0.1" "select-pane -t ${sessionName}:0.0"`,
    // Ctrl+1 / Ctrl+2: explicit left/right focus, even when the right pane is running a nested agent session
    `bind-key -T root C-1 select-pane -t ${sessionName}:0.0`,
    `bind-key -T root C-2 select-pane -t ${sessionName}:0.1`,
    // Ctrl+B: toggle sidebar width (collapse/expand)
    `bind-key -T root C-b if-shell "[ $(tmux display-message -p '#\\{pane_width\\}' -t ${sessionName}:0.0) -gt 5 ]" "resize-pane -t ${sessionName}:0.0 -x 0" "resize-pane -t ${sessionName}:0.0 -x ${NAV_WIDTH}"`,
    // Ctrl+T: focus nav pane + pass through — TUI handles new agent window via useKeyboard
    `bind-key -T root C-t select-pane -t ${sessionName}:0.0 \\; send-keys -t ${sessionName}:0.0 C-t`,
    // Ctrl+D: detach from TUI (leave running)
    'bind-key -T root C-d detach-client',
    // Ctrl+Q: focus nav pane + pass through for quit confirmation popup
    `bind-key -T root C-q select-pane -t ${sessionName}:0.0 \\; send-keys -t ${sessionName}:0.0 C-q`,
  ];
}

export function getTuiQuitBindingArgs(sessionName = TUI_SESSION): string[] {
  return [
    'bind-key',
    '-T',
    'root',
    'C-q',
    'select-pane',
    '-t',
    `${sessionName}:0.0`,
    '\\;',
    'send-keys',
    '-t',
    `${sessionName}:0.0`,
    'C-q',
  ];
}

/** Apply visual theme to TUI session */
function applyTuiStyle(): void {
  const cmds = [
    `set-option -t ${TUI_SESSION} pane-border-style 'fg=${TUI_STYLE.inactiveBorder}'`,
    `set-option -t ${TUI_SESSION} pane-active-border-style 'fg=${TUI_STYLE.activeBorder}'`,
    ...(process.env.GENIE_TMUX_MOUSE !== 'off' ? [`set-option -t ${TUI_SESSION} mouse on`] : []),
    `set-option -t ${TUI_SESSION} status off`,
    `set-option -t ${TUI_SESSION} pane-border-status off`,
  ];
  for (const cmd of cmds) {
    try {
      execSync(tuiTmux(cmd), { stdio: 'ignore' });
    } catch {}
  }
}

/** Set up keybindings in root table so they work immediately */
function setupTuiKeybindings(): void {
  for (const cmd of getTuiKeybindings()) {
    try {
      if (cmd.startsWith('bind-key -T root C-q ')) {
        spawnSync(tmuxBin(), ['-L', 'genie-tui', '-f', tuiTmuxConf(), ...getTuiQuitBindingArgs()], {
          stdio: 'ignore',
        });
      } else {
        execSync(tuiTmux(cmd), { stdio: 'ignore' });
      }
    } catch {}
  }
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
    // Session exists — reuse it, but ensure the split is healthy
    const panes = execSync(tuiTmux(`list-panes -t ${TUI_SESSION}:0 -F '#{pane_id}'`), { encoding: 'utf-8' })
      .trim()
      .split('\n');

    if (panes.length >= 2) {
      // Both panes exist — clear the right pane so it doesn't show stale content
      // (e.g., a leftover TUI nav renderer from a crashed serve process)
      try {
        execSync(tuiTmux(`respawn-pane -k -t ${panes[1]} 'cat'`), { stdio: 'ignore' });
      } catch {}
      return { leftPane: panes[0], rightPane: panes[1] };
    }

    // Only 1 pane — re-create the split
    const cols =
      Number.parseInt(
        execSync(tuiTmux(`display-message -t ${TUI_SESSION}:0 -p '#{window_width}'`), { encoding: 'utf-8' }).trim(),
        10,
      ) || 120;
    execSync(tuiTmux(`split-window -h -t ${TUI_SESSION}:0 -l ${cols - NAV_WIDTH - 1}`), { stdio: 'ignore' });
    const refreshed = execSync(tuiTmux(`list-panes -t ${TUI_SESSION}:0 -F '#{pane_id}'`), { encoding: 'utf-8' })
      .trim()
      .split('\n');
    applyTuiStyle();
    setupTuiKeybindings();
    try {
      execSync(tuiTmux(`select-pane -t ${refreshed[0]}`), { stdio: 'ignore' });
    } catch {}
    return { leftPane: refreshed[0], rightPane: refreshed[1] || refreshed[0] };
  } catch {
    // Session doesn't exist — create it
  }

  const cols = 120;
  const rows = 40;

  execSync(tuiTmux(`new-session -d -s ${TUI_SESSION} -x ${cols} -y ${rows}`), {
    stdio: 'ignore',
  });
  execSync(tuiTmux(`split-window -h -t ${TUI_SESSION}:0 -l ${cols - NAV_WIDTH - 1}`), { stdio: 'ignore' });

  const panes = execSync(tuiTmux(`list-panes -t ${TUI_SESSION}:0 -F '#{pane_id}'`), { encoding: 'utf-8' })
    .trim()
    .split('\n');

  applyTuiStyle();
  setupTuiKeybindings();

  // Focus left pane (nav) so keyboard input goes to OpenTUI by default
  try {
    execSync(tuiTmux(`select-pane -t ${panes[0]}`), { stdio: 'ignore' });
  } catch {}

  return { leftPane: panes[0], rightPane: panes[1] || panes[0] };
}

/**
 * Send TUI launch script to left pane.
 * Writes ~/.genie/tui-launch.sh with workspace env vars, sends it to the pane.
 *
 * The wrapper redirects stderr to ~/.genie/logs/tui-crash.log so native panics
 * from @opentui/core's libopentui.dylib (which write directly to fd 2 from the
 * Zig FFI layer) survive the alt-screen reset on crash. Without this, the
 * panic message is overwritten when the terminal returns from raw mode and
 * the user sees a SIGTRAP exit with no diagnostic. See #1390.
 */
function sendTuiLaunchScript(leftPane: string, rightPane: string, workspaceRoot?: string): void {
  const home = genieHome();
  const bunPath = process.execPath || 'bun';
  const genieBin = process.argv[1] || 'genie';
  const scriptPath = join(home, 'tui-launch.sh');
  const logsDir = join(home, 'logs');
  const crashLog = join(logsDir, 'tui-crash.log');

  const envVars = ['GENIE_TUI_PANE=left', `GENIE_TUI_RIGHT=${rightPane}`];
  if (workspaceRoot) envVars.push(`GENIE_TUI_WORKSPACE=${workspaceRoot}`);

  const content = [
    '#!/bin/sh',
    `mkdir -p '${logsDir}'`,
    // fd-level redirect catches native (Zig/FFI) panics that write directly
    // to fd 2 — JS-level monkey patching cannot.
    `exec 2>> '${crashLog}'`,
    `printf -- '--- tui-launch %s pid=%s ---\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" >&2`,
    `export ${envVars.join('\nexport ')}`,
    `exec ${bunPath} ${genieBin}`,
    '',
  ].join('\n');
  writeFileSync(scriptPath, content, { mode: 0o755 });

  try {
    execSync(tuiTmux(`send-keys -t '${leftPane}' '${scriptPath}' Enter`), { stdio: 'ignore' });
  } catch {}
}

/** Kill the TUI tmux server */
function killTuiSession(): void {
  try {
    execSync(tuiTmux('kill-server'), { stdio: 'ignore' });
  } catch {
    // not running
  }
}

/** List sessions on the genie agent socket */
function listAgentSessions(): string[] {
  try {
    const out = execSync(genieTmuxCmd("list-sessions -F '#{session_name}'"), { encoding: 'utf-8' });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// ============================================================================
// Public helpers (used by genie.ts thin client)
// ============================================================================

/** Check if genie serve is currently running */
export function isServeRunning(): boolean {
  const entry = readServePid();
  return entry !== null && isProcessAlive(entry.pid);
}

/**
 * Auto-start genie serve in daemon mode and wait until ready.
 * Ready = PID file exists + PID alive + genie-tui session exists on default server.
 */
export async function autoStartServe(): Promise<void> {
  if (isServeRunning()) return;

  const bunPath = process.execPath ?? 'bun';
  const genieBin = process.argv[1] ?? 'genie';

  const { spawn: spawnChild } = await import('node:child_process');
  const child = spawnChild(bunPath, [genieBin, 'serve', '--foreground'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, GENIE_IS_DAEMON: '1' },
  });
  child.unref();

  // Poll for readiness: PID alive + genie-tui session exists
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (isServeRunning() && isTuiSessionReady()) return;
  }

  if (!isServeRunning()) {
    throw new Error('genie serve failed to start within 15s. Run `genie serve` manually.');
  }
}

/** Check if the genie-tui session exists on the TUI socket */
export function isTuiSessionReady(): boolean {
  try {
    execSync(tuiTmux(`has-session -t ${TUI_SESSION}`), { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the TUI tmux session exists and is ready for attachment.
 * If the TUI server died while serve is still running, recreate it.
 *
 * When `GENIE_TUI_DISABLE=1` / `--no-tui` is set, this is a no-op so we never
 * re-seed the launch script that re-invokes genie with `GENIE_TUI_PANE=left`
 * (which would trigger the OpenTUI kqueue spin in the pane).
 */
export function ensureTuiSession(workspaceRoot?: string): void {
  if (isTuiDisabled()) {
    noticeTuiSkipped('session ensure');
    return;
  }
  if (isTuiSessionReady()) return;
  const { leftPane, rightPane } = startTuiTmuxServer();
  sendTuiLaunchScript(leftPane, rightPane, workspaceRoot);
}

// ============================================================================
// Workspace agent scanning
// ============================================================================

// ============================================================================
// Service management
// ============================================================================

interface DaemonHandles {
  schedulerHandle: { stop: () => void; done: Promise<void> } | null;
  agentWatcher: { close: () => void } | null;
  brainHandle: { stop: () => Promise<void>; port: number } | null;
  omniApprovalHandler: { stop: () => Promise<void> } | null;
  omniBridge: { stop: () => Promise<void> } | null;
  detectorScheduler: { stop: () => void } | null;
  /** Derived-signal rule engine (invincible-genie / Group 2). */
  derivedSignals: { stop: () => Promise<void> } | null;
}

const handles: DaemonHandles = {
  schedulerHandle: null,
  agentWatcher: null,
  brainHandle: null,
  omniApprovalHandler: null,
  omniBridge: null,
  detectorScheduler: null,
  derivedSignals: null,
};

/** Sync agent directory from workspace and start file watcher. */
async function startAgentSync(): Promise<{ close: () => void } | null> {
  try {
    const { findWorkspace, genieHome } = require('../lib/workspace.js') as typeof import('../lib/workspace.js');
    const ws = findWorkspace();
    if (!ws) {
      // Loud failure — silent return used to hide the whole discovery subsystem
      // when serve booted from outside a workspace (or with a stale saved root).
      const { join } = require('node:path') as typeof import('node:path');
      const configPath = join(genieHome(), 'config.json');
      console.warn(`  Agent sync: DISABLED — no workspace found from cwd or ${configPath}`);
      console.warn('    Fix: `cd <workspace> && genie serve restart`, or run `genie init` to bootstrap one');
      return null;
    }

    const { syncAgentDirectory, watchAgentDirectory } = await import('../lib/agent-sync.js');
    const syncResult = await syncAgentDirectory(ws.root);
    const synced = syncResult.registered.length + syncResult.updated.length;
    if (synced > 0) {
      console.log(
        `  Agent sync: ${syncResult.registered.length} registered, ${syncResult.updated.length} updated (workspace: ${ws.root})`,
      );
    } else {
      console.log(`  Agent sync: up to date (workspace: ${ws.root})`);
    }
    if (syncResult.errors.length > 0) {
      console.warn(`  Agent sync: ${syncResult.errors.length} error(s) — these agents were NOT registered:`);
      for (const e of syncResult.errors) {
        console.warn(`    ${e.name}: ${e.error}`);
      }
    }

    const watcher = watchAgentDirectory(ws.root, {
      onSync: (name, action) => {
        console.log(`  [agent-watcher] ${name}: ${action}`);
      },
    });
    if (watcher) {
      console.log('  Agent watcher started (watching agents/ directory)');
    } else {
      console.warn('  Agent watcher: FAILED to start — new agents will not be auto-registered');
    }
    return watcher;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Agent sync failed: ${msg}`);
    return null;
  }
}

/** Start pgserve and register it in the service registry. */
async function startPgserve(): Promise<void> {
  console.log('  Starting pgserve...');
  try {
    const { ensurePgserve } = await import('../lib/db.js');
    const port = await ensurePgserve();
    console.log(`  pgserve ready on port ${port}`);
    try {
      const { registerService } = await import('../lib/service-registry.js');
      registerService('pgserve-owner', process.pid);
    } catch {
      // Registry not available — non-fatal
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  pgserve failed: ${msg}`);
  }
}

/** Start the scheduler daemon and register it. */
async function startScheduler(): Promise<void> {
  console.log('  Starting scheduler daemon...');
  try {
    const { startDaemon } = await import('../lib/scheduler-daemon.js');
    handles.schedulerHandle = startDaemon();
    console.log('  Scheduler started (includes event-router + inbox-watcher)');
    try {
      const { registerService } = await import('../lib/service-registry.js');
      registerService('scheduler', process.pid);
    } catch {
      // Registry not available — non-fatal
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Scheduler failed: ${msg}`);
  }

  // Derived-signal rule engine (invincible-genie / Group 2). Subscribes to
  // audit_events and emits second-order signals consumed by `genie status`.
  // Failure is non-fatal — without it, `genie status` still renders agents
  // and the health checklist; only the active-signals section goes empty.
  try {
    const { startDerivedSignalsEngine } = await import('../lib/derived-signals/index.js');
    handles.derivedSignals = await startDerivedSignalsEngine();
    console.log('  Derived-signal rule engine subscribed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Derived-signal engine failed: ${msg}`);
  }
}

/** Start all services in foreground mode.
 *  @param headless If true, skip TUI setup (services only: pgserve, scheduler, inbox-watcher).
 */
function claimServePidOrExit(): void {
  const existingEntry = readServePid();
  if (existingEntry && isProcessAlive(existingEntry.pid)) {
    console.log(`genie serve already running (PID ${existingEntry.pid})`);
    process.exit(0);
  }
  if (existingEntry) {
    // Stale PID file — unlink it directly (removeServePid only removes files
    // owned by process.pid, which wouldn't match here).
    forceRemoveServePid();
  }
}

function resolveServeMode(headless?: boolean): { skipTui: boolean; mode: 'headless' | 'no-tui' | 'full' } {
  // Hotfix: treat GENIE_TUI_DISABLE / --no-tui like --headless for TUI setup
  // so `genie serve` starts pgserve + scheduler + bridge but never seeds the
  // OpenTUI launch pane. Agent sessions (on `-L genie`) are unaffected.
  const tuiDisabled = isTuiDisabled();
  if (tuiDisabled && !headless) {
    noticeTuiSkipped('serve');
  }
  const skipTui = Boolean(headless) || tuiDisabled;
  const mode: 'headless' | 'no-tui' | 'full' = headless ? 'headless' : tuiDisabled ? 'no-tui' : 'full';
  return { skipTui, mode };
}

function resolveBrainPathFromWorkspace(): string | undefined {
  try {
    const { findWorkspace } = require('../lib/workspace.js') as typeof import('../lib/workspace.js');
    const ws = findWorkspace();
    if (ws?.root) {
      const bp = join(ws.root, 'brain');
      if (existsSync(bp) && existsSync(join(bp, 'brain.json'))) return bp;
    }
  } catch {
    // No workspace — skip
  }
  return undefined;
}

async function startBrainServerIfEnabled(): Promise<void> {
  // Gated by `brain.embedded` config (default: true). Set `brain.embedded=false`
  // in ~/.genie/config.json to opt out — power-users can then run `brain serve`
  // standalone with custom settings (port, brain-path, @next dev channel).
  const { loadGenieConfigSync } = await import('../lib/genie-config.js');
  const brainEmbedded = loadGenieConfigSync().brain.embedded;
  if (!brainEmbedded) {
    console.log('  Brain server: skipped (brain.embedded=false — managed externally)');
    return;
  }
  try {
    // Dynamic import — brain is optional. Silently skip if not installed.
    // @ts-expect-error — brain is enterprise-only, not in genie's deps
    const brain = await import('@khal-os/brain');
    if (!brain.startEmbeddedBrainServer) return;
    const { getActivePort } = await import('../lib/db.js');
    const pgPort = getActivePort();
    if (!pgPort) {
      console.log('  Brain server: pgserve not available (skipped)');
      return;
    }
    console.log('  Starting brain server...');
    const brainPath = resolveBrainPathFromWorkspace();
    if (!brainPath) {
      console.log('  Brain server: no brain/ found in workspace (skipped)');
      return;
    }
    const handle = await brain.startEmbeddedBrainServer({ brainPath, geniePgPort: pgPort });
    handles.brainHandle = { stop: handle.stop, port: handle.port };
    console.log(`  Brain server ready on port ${handle.port}`);
  } catch {
    // Brain not installed — fine, skip silently
  }
}

function logAgentSessionInfo(): void {
  const sessions = listAgentSessions();
  if (sessions.length > 0) {
    console.log(`  Agent server (-L genie): ${sessions.length} sessions`);
  } else {
    console.log('  Agent server (-L genie): no sessions yet (created on first spawn)');
  }
}

function startTuiSessionIfEnabled(skipTui: boolean): void {
  if (skipTui) return;
  console.log('  Setting up TUI session...');
  const { leftPane, rightPane } = startTuiTmuxServer();
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
}

async function startDetectorSchedulerSafely(): Promise<void> {
  // Read-only sweep of registered DetectorModules every 60s ± 5s. No auto-fix,
  // no state mutation. Importing built-in.ts pulls every production pattern
  // (1-8) into the registry before the scheduler's first tick.
  try {
    await import('../detectors/built-in.js');
    const { start: startDetectorScheduler } = await import('../serve/detector-scheduler.js');
    const { listDetectors } = await import('../detectors/index.js');
    handles.detectorScheduler = startDetectorScheduler();
    const registered = listDetectors().map((d) => d.id);
    console.log(
      `  Detector scheduler started (measurement only, 60s ± 5s cadence) — registered: [${registered.join(', ')}]`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Detector scheduler: failed — ${msg}`);
  }
}

async function startExecutorReadEndpointSafely(): Promise<void> {
  // Non-fatal: if the port is busy or Bun.serve errors, the endpoint logs and
  // skips. Direct-SQL consumers fall back to `executors_reader` role.
  try {
    const { startExecutorReadEndpoint, getExecutorReadPort } = await import('../lib/executor-read.js');
    const ok = await startExecutorReadEndpoint();
    if (ok) console.log(`  Executor read endpoint ready on port ${getExecutorReadPort()}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Executor read endpoint: failed — ${msg}`);
  }
}

async function startOmniApprovalHandlerSafely(): Promise<void> {
  try {
    const { startOmniApprovalHandler } = await import('../lib/omni-approval-handler.js');
    const handler = await startOmniApprovalHandler();
    if (handler) {
      handles.omniApprovalHandler = handler;
      console.log('  Omni approval handler started');
    }
  } catch {
    // NATS or workspace not configured — non-fatal
  }
}

async function startOmniBridgeSafely(): Promise<void> {
  // Bridge is optional by default: dev machines without NATS should not crash serve.
  // Set GENIE_OMNI_REQUIRED=1 to make bridge startup fatal (strict/prod mode).
  const { OmniBridge } = await import('../services/omni-bridge.js');
  const bridge = new OmniBridge({
    natsUrl: process.env.GENIE_NATS_URL ?? 'localhost:4222',
    maxConcurrent: Number(process.env.GENIE_MAX_CONCURRENT ?? '20'),
    idleTimeoutMs: Number(process.env.GENIE_IDLE_TIMEOUT_MS ?? '900000'),
  });
  try {
    await bridge.start();
    handles.omniBridge = bridge;
    console.log('  Omni bridge started');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env.GENIE_OMNI_REQUIRED === '1') {
      console.error(`  Omni bridge: FAILED — ${msg}`);
      process.exit(1);
    }
    console.warn(`  Omni bridge: degraded — ${msg}; set GENIE_OMNI_REQUIRED=1 to make this fatal`);
    // Continue without bridge — handles.omniBridge stays null so shutdown() skips it.
  }
}

async function stopSchedulerHandles(): Promise<void> {
  handles.agentWatcher?.close();
  // Stop scheduler (drains in-flight) and wait for its done promise so the
  // final `daemon_stopped` log entry is flushed before we exit.
  const schedulerHandle = handles.schedulerHandle;
  if (schedulerHandle) {
    schedulerHandle.stop();
    try {
      await schedulerHandle.done;
    } catch {
      // Best effort — we still need to finish the rest of shutdown
    }
    handles.schedulerHandle = null;
  }
  if (handles.detectorScheduler) {
    handles.detectorScheduler.stop();
    handles.detectorScheduler = null;
  }
  if (handles.derivedSignals) {
    await handles.derivedSignals.stop().catch(() => {});
    handles.derivedSignals = null;
  }
}

async function stopOmniAndBrainServices(): Promise<void> {
  if (handles.omniApprovalHandler) {
    await handles.omniApprovalHandler.stop().catch(() => {});
    handles.omniApprovalHandler = null;
  }
  if (handles.omniBridge) {
    await handles.omniBridge.stop().catch(() => {});
    handles.omniBridge = null;
  }
  void import('../lib/executor-read.js').then((m) => m.stopExecutorReadEndpoint().catch(() => {}));
  // Brain server: best-effort; signal handlers call process.exit() immediately
  // after shutdown(). The OS reclaims sockets/connections on process exit.
  if (handles.brainHandle) {
    await handles.brainHandle.stop().catch(() => {});
    handles.brainHandle = null;
  }
}

function killRegisteredServices(): void {
  try {
    const { killAllServices } = require('../lib/service-registry.js');
    killAllServices();
  } catch {
    // Registry not available — best effort
  }
}

function removePgservePortLockfile(): void {
  try {
    const lockfilePath = join(genieHome(), 'pgserve.port');
    if (existsSync(lockfilePath)) unlinkSync(lockfilePath);
  } catch {
    // Best effort
  }
}

function sigKillRegisteredServices(): void {
  try {
    const { getRegisteredServices } = require('../lib/service-registry.js');
    for (const svc of getRegisteredServices()) {
      try {
        process.kill(svc.pid, 'SIGKILL');
      } catch {
        // already dead
      }
    }
  } catch {
    // registry not available
  }
}

function buildShutdownFn(headless?: boolean): { shutdown: () => Promise<void>; hasStarted: () => boolean } {
  let shutdownStarted = false;
  const shutdown = async (): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log('\nShutting down genie serve...');
    await stopSchedulerHandles();
    await stopOmniAndBrainServices();
    killRegisteredServices();
    // NEVER kill the agent tmux server — agent sessions are eternal and must
    // survive serve restarts. Only the TUI session is owned by serve.
    if (!headless) killTuiSession();
    removePgservePortLockfile();
    removeServePid();
    console.log('genie serve stopped.');
  };
  return { shutdown, hasStarted: () => shutdownStarted };
}

function installGracefulExitHandlers(shutdown: () => Promise<void>, hasStarted: () => boolean): void {
  const gracefulExit = (exitCode: number): void => {
    if (hasStarted()) return;
    // 10s force-kill fallback — if graceful shutdown doesn't complete, SIGKILL remaining.
    const forceTimer = setTimeout(() => {
      console.error('Graceful shutdown timeout (10s). Force-killing remaining processes.');
      sigKillRegisteredServices();
      removeServePid();
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    shutdown()
      .catch(() => {
        // Swallow — removeServePid below still runs
      })
      .finally(() => {
        clearTimeout(forceTimer);
        removeServePid();
        process.exit(exitCode);
      });
  };

  process.on('SIGTERM', () => gracefulExit(143));
  process.on('SIGINT', () => gracefulExit(130));
  process.on('SIGHUP', () => gracefulExit(129));
  // `exit` handler can only run synchronous code — ensure the PID file is gone
  // even if we reach process exit without going through gracefulExit (e.g. the
  // scheduler's `done` promise resolved normally).
  process.on('exit', () => {
    removeServePid();
  });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception in genie serve:', err);
    gracefulExit(1);
  });
}

async function startForeground(headless?: boolean): Promise<void> {
  claimServePidOrExit();
  const { skipTui, mode } = resolveServeMode(headless);
  process.env.GENIE_IS_DAEMON = '1';
  writeServePid(process.pid);
  console.log(`genie serve starting (PID ${process.pid}, mode: ${mode})`);

  if (!skipTui) {
    await ensureTmux();
  }

  await startPgserve();
  await startBrainServerIfEnabled();
  if (!headless) logAgentSessionInfo();
  handles.agentWatcher = await startAgentSync();
  startTuiSessionIfEnabled(skipTui);
  await startScheduler();
  await startDetectorSchedulerSafely();
  await startExecutorReadEndpointSafely();
  await startOmniApprovalHandlerSafely();
  await startOmniBridgeSafely();

  const stopMsg = headless ? 'Send SIGTERM to stop.' : 'Press Ctrl+C to stop.';
  console.log(`\ngenie serve is running (${mode}). ${stopMsg}`);

  const { shutdown, hasStarted } = buildShutdownFn(headless);
  installGracefulExitHandlers(shutdown, hasStarted);

  // Wait for scheduler to finish (blocks forever until signal)
  if (handles.schedulerHandle) {
    await handles.schedulerHandle.done;
  } else {
    await new Promise(() => {});
  }

  removeServePid();
}

/** Start as a background daemon.
 *  @param headless If true, pass --headless to the foreground process.
 */
async function startBackground(headless?: boolean): Promise<void> {
  const existingEntry = readServePid();
  if (existingEntry && isProcessAlive(existingEntry.pid)) {
    console.log(`genie serve already running (PID ${existingEntry.pid})`);
    process.exit(0);
  }
  if (existingEntry) {
    forceRemoveServePid();
  }

  const bunPath = process.execPath ?? 'bun';
  const genieBin = process.argv[1] ?? 'genie';

  const args = [genieBin, 'serve', '--foreground'];
  if (headless) args.push('--headless');

  const child = spawn(bunPath, args, {
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

/** Unlink serve.pid unconditionally, swallowing ENOENT and permission errors. */
function forceRemoveServePid(): void {
  try {
    unlinkSync(servePidPath());
  } catch {}
}

/** Stop genie serve and all child services */
async function stopServe(): Promise<void> {
  const entry = readServePid();

  if (!entry) {
    console.log('genie serve is not running (no PID file).');
    return;
  }

  const pid = entry.pid;

  if (!isProcessAlive(pid)) {
    console.log(`Stale PID file (PID ${pid} not running). Cleaning up.`);
    forceRemoveServePid();
    // Only kill TUI session — agent server is independent
    killTuiSession();
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

  // Only kill TUI session — agent tmux server is eternal
  killTuiSession();

  // Serve process is gone; unlink the file directly rather than through
  // removeServePid (whose identity check would bail since pid !== process.pid).
  forceRemoveServePid();
  console.log('genie serve stopped.');
}

/** Check pgserve health and print status */
async function printPgserveHealth(): Promise<void> {
  try {
    const { isAvailable, getActivePort } = await import('../lib/db.js');
    const dbOk = await isAvailable();
    console.log(`  pgserve:    ${dbOk ? `healthy (port ${getActivePort()})` : 'unreachable'}`);
  } catch {
    console.log('  pgserve:    unavailable');
  }
}

function resolveBrainPortFromWorkspace(brain: { readServerInfo?: (p: string) => { port?: number } | null }):
  | number
  | null {
  try {
    const { findWorkspace } = require('../lib/workspace.js') as typeof import('../lib/workspace.js');
    const ws = findWorkspace();
    if (ws?.root && brain.readServerInfo) {
      const info = brain.readServerInfo(join(ws.root, 'brain'));
      if (info?.port) return info.port;
    }
  } catch {
    // No workspace — caller falls back to in-memory handle
  }
  return null;
}

async function probeBrainHealth(brainPort: number): Promise<void> {
  try {
    const resp = await fetch(`http://127.0.0.1:${brainPort}/healthz`);
    console.log(
      resp.ok
        ? `  brain:      running (port ${brainPort})`
        : `  brain:      unhealthy (port ${brainPort}, status ${resp.status})`,
    );
  } catch {
    console.log(`  brain:      stopped (port ${brainPort} unreachable)`);
  }
}

async function printBrainStatus(): Promise<void> {
  try {
    // @ts-expect-error — brain is enterprise-only, not in genie's deps
    const brain = await import('@khal-os/brain');
    const brainPort = resolveBrainPortFromWorkspace(brain) ?? handles.brainHandle?.port ?? null;
    if (brainPort) {
      await probeBrainHealth(brainPort);
    } else {
      console.log('  brain:      stopped');
    }
  } catch {
    console.log('  brain:      not installed');
  }
}

async function printPgserveStatus(): Promise<void> {
  await printPgserveHealth();
  await printBrainStatus();
}

/** Print tmux server statuses */
function printTmuxStatus(): void {
  const agentRunning = isGenieTmuxRunning();
  const sessions = agentRunning ? listAgentSessions() : [];
  console.log(`  tmux -L genie: ${agentRunning ? `running (${sessions.length} sessions)` : 'stopped'}`);
  if (sessions.length > 0) {
    console.log(`              ${sessions.join(', ')}`);
  }

  const tuiReady = isTuiSessionReady();
  console.log(`  tmux -L genie-tui: ${tuiReady ? 'running' : 'stopped'}`);
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

/** Print Omni bridge status via IPC (cross-process — no in-process singleton). */
async function printBridgeStatus(): Promise<void> {
  try {
    const { getBridgeStatus } = await import('../lib/bridge-status.js');
    const res = await getBridgeStatus();
    if (res.state === 'running' && res.pong) {
      const uptimeSec = Math.round(res.pong.uptimeMs / 1000);
      const latency = res.latencyMs ?? 0;
      console.log(`  omni-bridge: running (pid ${res.pong.pid}, uptime ${uptimeSec}s, ping ${latency}ms)`);
    } else if (res.state === 'stale') {
      console.log(`  omni-bridge: stale — ${res.detail}`);
    } else {
      console.log('  omni-bridge: stopped');
    }
  } catch {
    console.log('  omni-bridge: unavailable');
  }
}

/** Show service health */
async function statusServe(): Promise<void> {
  const entry = readServePid();
  const running = entry !== null && isProcessAlive(entry.pid);

  console.log('\nGenie Serve');
  console.log('─'.repeat(50));
  console.log(`  Status:     ${running ? 'running' : 'stopped'}`);

  if (running && entry) {
    console.log(`  PID:        ${entry.pid}`);
  }

  await printPgserveStatus();
  printTmuxStatus();
  await printDaemonStatus(running);
  await printBridgeStatus();

  console.log(`  PID file:   ${servePidPath()}`);
  console.log('');
}

// ============================================================================
// Registration
// ============================================================================

interface ServeStartOptions {
  daemon?: boolean;
  foreground?: boolean;
  headless?: boolean;
  fix?: boolean;
}

/**
 * Run `ensureServeReady` and decide whether to proceed with boot.
 *
 * Default mode (`--fix` true): auto-fix every precondition that can be fixed,
 * surface the rest as warnings, and start anyway. The caller still sees the
 * fix verbs printed by `printReport`.
 *
 * Explicit `--no-fix`: refuse to start when any precondition is non-`ok`.
 * Exit code 2 mirrors the convention used by `genie doctor` for actionable
 * failures.
 *
 * `GENIE_SKIP_PRECONDITIONS=1` bypasses the orchestrator entirely. Used by
 * lifecycle integration tests that exercise the post-precondition boot path
 * (e.g. bridge-failure assertions) within a tight timing envelope. Production
 * code paths must never set this — `--no-fix` is the operator-facing escape.
 */
async function runStartPreconditions(autoFix: boolean): Promise<void> {
  if (process.env.GENIE_SKIP_PRECONDITIONS === '1') return;
  const { ensureServeReady } = await import('./serve/ensure-ready.js');
  const report = await ensureServeReady({ autoFix });
  if (autoFix) return;
  if (!report.ok) {
    console.error('genie serve start refused: one or more preconditions are not ok (--no-fix mode).');
    process.exit(2);
  }
}

export function registerServeCommands(program: Command): void {
  const serve = program.command('serve').description('Start all genie infrastructure (pgserve, tmux, scheduler)');

  serve
    .command('start', { isDefault: true })
    .description('Start genie serve')
    .option('--daemon', 'Run in background')
    .option('--foreground', 'Run in foreground (default)')
    .option('--headless', 'Run without TUI (services only: pgserve, scheduler, inbox-watcher)')
    .option('--no-fix', 'Refuse to start when any precondition is not ok (default: auto-fix)')
    .action(async (options: ServeStartOptions) => {
      // commander's `--no-fix` flips `options.fix` to false. Default is true.
      const autoFix = options.fix !== false;
      await runStartPreconditions(autoFix);
      if (options.daemon) {
        await startBackground(options.headless);
      } else {
        await startForeground(options.headless);
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
