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
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { palette } from '../../packages/genie-tokens';
import {
  type BrainServerApi,
  type StartedBrainVault,
  resolveBrainVaults,
  startResolvedBrainVaults,
} from '../lib/brain-vaults.js';
import { ensureTmux, tmuxBin } from '../lib/ensure-tmux.js';
import { getProcessStartTime } from '../lib/process-identity.js';
import { respawnInvocation, respawnShellCommand } from '../lib/respawn.js';
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

function serveStartupStatusPath(): string {
  return join(genieHome(), 'state', `serve-startup-${process.pid}-${Date.now()}.json`);
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
// Stopping sentinel — signals "operator is intentionally stopping serve"
//
// `stopServe()` writes the lock before SIGTERM and clears it after the PID
// file is gone. `autoStartServe()` checks for the lock and refuses to spawn
// while it's active, so the next genie command after `serve stop` does not
// immediately respawn the daemon the operator just killed.
//
// The file body is a single absolute expiry timestamp (ms since epoch); a
// crashed `stopServe` cannot brick auto-start beyond {@link STOPPING_LOCK_TTL_MS}.
// ============================================================================

const STOPPING_LOCK_TTL_MS = 30_000;

function stoppingLockPath(): string {
  return join(genieHome(), 'serve.stopping.lock');
}

/** Write the shutdown sentinel with an absolute expiry; safe to call repeatedly. */
export function writeStoppingLockSync(ttlMs: number = STOPPING_LOCK_TTL_MS): void {
  mkdirSync(genieHome(), { recursive: true });
  writeFileSync(stoppingLockPath(), String(Date.now() + ttlMs), 'utf-8');
}

/** Best-effort unlink of the shutdown sentinel. */
export function clearStoppingLock(): void {
  try {
    unlinkSync(stoppingLockPath());
  } catch {
    // already gone
  }
}

/**
 * `true` iff a non-expired sentinel exists. Corrupt/empty files and expired
 * timestamps are treated as absent (and removed) so a malformed lock can
 * never block auto-start indefinitely.
 */
export function isStoppingLockActive(): boolean {
  const path = stoppingLockPath();
  if (!existsSync(path)) return false;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8').trim();
  } catch {
    return false;
  }
  const expiresAt = Number.parseInt(raw, 10);
  if (raw === '' || Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
    clearStoppingLock();
    return false;
  }
  return true;
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

interface BrainStartupConfig {
  brain?: {
    embedded?: boolean;
    paths?: string[];
  };
}

interface StartBrainServerDeps {
  loadConfig?: () => BrainStartupConfig;
  importBrain?: () => Promise<BrainServerApi>;
  getActivePort?: () => number | undefined;
  resolveVaults?: typeof resolveBrainVaults;
  startVaults?: typeof startResolvedBrainVaults;
  setBrainHandles?: (brainHandles: StartedBrainVault[]) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

type BrainStartupLogger = (message: string) => void;

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
 * Run a tmux command via execSync and re-throw with the captured stderr
 * embedded in the message. Bun's execSync throws an `Error` whose default
 * message is the unhelpful `output: [null, null, null]` when stdio is
 * ignored — capturing stdout/stderr as strings gives us tmux's actual
 * complaint (e.g. `duplicate session: genie-tui`).
 */
function runTuiTmuxCapturing(cmd: string): string {
  try {
    return execSync(tuiTmux(cmd), { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf-8');
    const stdout = typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf-8');
    const detail = (stderr ?? stdout ?? e.message ?? 'unknown tmux error').trim();
    throw new Error(`tmux ${cmd}: ${detail}`);
  }
}

/**
 * Append a single line to ~/.genie/logs/tui-crash.log so the original
 * inner-branch error survives the recovery `kill-session`. Best-effort:
 * never throw from here — the whole point is that the user gets a working
 * TUI even when logging fails.
 *
 * Prefix `[startTuiTmuxServer] <ISO timestamp> ` keeps these distinguishable
 * from `sendTuiLaunchScript`'s native-panic appends to the same file.
 */
function logTuiStartupFailure(message: string): void {
  try {
    const home = genieHome();
    const logsDir = join(home, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const crashLog = join(logsDir, 'tui-crash.log');
    const line = `[startTuiTmuxServer] ${new Date().toISOString()} ${message.replace(/\s+/g, ' ').trim()}\n`;
    appendFileSync(crashLog, line);
  } catch {
    // Logging is best-effort; a failed log must not block recovery.
  }
}

/**
 * Build a fresh genie-tui session from scratch: new-session, split-window,
 * style, keybindings, focus left pane. Used both when no session existed
 * and when a corrupt session was killed during recovery.
 *
 * Errors from `new-session` and `split-window` propagate up with tmux's
 * stderr embedded — see `runTuiTmuxCapturing`.
 */
function freshCreateTuiSession(): { leftPane: string; rightPane: string } {
  const cols = 120;
  const rows = 40;

  runTuiTmuxCapturing(`new-session -d -s ${TUI_SESSION} -x ${cols} -y ${rows}`);
  runTuiTmuxCapturing(`split-window -h -t ${TUI_SESSION}:0 -l ${cols - NAV_WIDTH - 1}`);

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
 * Start the TUI tmux server with full session setup:
 * left pane (nav) + right pane (agent display).
 * If session already exists (serve restart), reuse it.
 *
 * Control flow:
 *   1. `has-session` probe in its own try/catch — non-existence is the ONLY
 *      path into a fresh `new-session`. This avoids the historical bug
 *      where any failure inside the repair branch fell through to
 *      `new-session` and crashed with `duplicate session: genie-tui`.
 *   2. If the session exists, run the repair branch in its own try. On
 *      failure: log to ~/.genie/logs/tui-crash.log, kill the corrupt
 *      session, and rebuild from scratch — the user just typed `genie`
 *      and wants a working TUI.
 *
 * Exported so unit tests can exercise it directly without monkey-patching
 * `child_process` globally.
 */
export function startTuiTmuxServer(): { leftPane: string; rightPane: string } {
  // Step 1: probe — the ONLY signal that decides "fresh create" vs "repair".
  try {
    execSync(tuiTmux(`has-session -t ${TUI_SESSION}`), { stdio: 'ignore' });
  } catch {
    // Session genuinely doesn't exist — create it from scratch.
    return freshCreateTuiSession();
  }

  // Step 2: session exists — try to repair / reuse. Any throw in this branch
  // means the session is in a bad state we can't reason about: log, kill,
  // and rebuild rather than bubbling an opaque error to the user.
  try {
    const panes = execSync(tuiTmux(`list-panes -t ${TUI_SESSION}:0 -F '#{pane_id}'`), { encoding: 'utf-8' })
      .trim()
      .split('\n')
      .filter((id) => id.length > 0);

    if (panes.length >= 2) {
      // Both panes exist — clear the right pane so it doesn't show stale content
      // (e.g., a leftover TUI nav renderer from a crashed serve process)
      try {
        execSync(tuiTmux(`respawn-pane -k -t ${panes[1]} 'cat'`), { stdio: 'ignore' });
      } catch {}
      return { leftPane: panes[0], rightPane: panes[1] };
    }

    // 1 pane (or theoretically 0 — tmux sessions always have ≥1 pane, but
    // defensively this falls into the same recreate-the-split path) → re-split.
    const cols =
      Number.parseInt(
        execSync(tuiTmux(`display-message -t ${TUI_SESSION}:0 -p '#{window_width}'`), { encoding: 'utf-8' }).trim(),
        10,
      ) || 120;
    runTuiTmuxCapturing(`split-window -h -t ${TUI_SESSION}:0 -l ${cols - NAV_WIDTH - 1}`);
    const refreshed = execSync(tuiTmux(`list-panes -t ${TUI_SESSION}:0 -F '#{pane_id}'`), { encoding: 'utf-8' })
      .trim()
      .split('\n');
    applyTuiStyle();
    setupTuiKeybindings();
    try {
      execSync(tuiTmux(`select-pane -t ${refreshed[0]}`), { stdio: 'ignore' });
    } catch {}
    return { leftPane: refreshed[0], rightPane: refreshed[1] || refreshed[0] };
  } catch (err) {
    // Repair failed — corrupt session in unknown state. Persist the original
    // cause for forensics, then nuke and rebuild.
    const message = err instanceof Error ? err.message : String(err);
    logTuiStartupFailure(message);
    try {
      execSync(tuiTmux(`kill-session -t ${TUI_SESSION}`), { stdio: 'ignore' });
    } catch {
      // If kill-session itself fails, freshCreateTuiSession() will re-throw
      // a useful error via runTuiTmuxCapturing — let it surface.
    }
    return freshCreateTuiSession();
  }
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
  const scriptPath = join(home, 'tui-launch.sh');
  const logsDir = join(home, 'logs');
  const crashLog = join(logsDir, 'tui-crash.log');

  const envVars = ['GENIE_TUI_PANE=left', `GENIE_TUI_RIGHT=${rightPane}`];
  if (workspaceRoot) envVars.push(`GENIE_TUI_WORKSPACE=${workspaceRoot}`);
  if (process.env.GENIE_TEAM) envVars.push(`GENIE_TUI_TEAM=${process.env.GENIE_TEAM}`);

  const content = [
    '#!/bin/sh',
    `mkdir -p '${logsDir}'`,
    // fd-level redirect catches native (Zig/FFI) panics that write directly
    // to fd 2 — JS-level monkey patching cannot.
    `exec 2>> '${crashLog}'`,
    `printf -- '--- tui-launch %s pid=%s ---\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" >&2`,
    `export ${envVars.join('\nexport ')}`,
    `exec ${respawnShellCommand()}`,
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
  // Defense in depth against the cascade where any genie command (TUI, hook,
  // automation) re-spawns serve immediately after `serve stop`. The sentinel
  // is cleared by stopServe once teardown finishes, so a normal restart loop
  // (stop → start) is unaffected.
  if (isStoppingLockActive()) {
    console.log('genie serve is shutting down — skipping auto-start.');
    return;
  }
  if (isServeRunning()) return;

  const { command, args } = respawnInvocation(['serve', '--foreground']);

  const { spawn: spawnChild } = await import('node:child_process');
  const child = spawnChild(command, args, {
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
  brainHandles: StartedBrainVault[];
  omniApprovalHandler: { stop: () => Promise<void> } | null;
  omniBridge: { stop: () => Promise<void> } | null;
  detectorScheduler: { stop: () => void } | null;
  /** Derived-signal rule engine (invincible-genie / Group 2). */
  derivedSignals: { stop: () => Promise<void> } | null;
  /** UDS hook-dispatch listener — replaces fork-per-event hook execution. */
  hookSocket: { stop: () => Promise<void>; path: string } | null;
}

const handles: DaemonHandles = {
  schedulerHandle: null,
  agentWatcher: null,
  brainHandles: [],
  omniApprovalHandler: null,
  omniBridge: null,
  detectorScheduler: null,
  derivedSignals: null,
  hookSocket: null,
};

interface ServeStartupStatus {
  ok: boolean;
  code?: number;
  lines?: string[];
}

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

/**
 * Probe pgserve via the unified transport-discovery resolver (UDS-first,
 * TCP-fallback). Genie is consumer-only after the canonical-cutover wish —
 * `genie serve` no longer spawns or supervises pgserve. If neither transport
 * is reachable, log a clear canonical-install hint and disable subsequent
 * autostart attempts so the rest of the serve boot doesn't loop on the same
 * failure.
 *
 * Pre-#1667: this function called `requirePgserveDaemon()` which only
 * accepted the canonical Unix socket. On hosts where `pgserve install`
 * registered foreground TCP mode (the supported install path post
 * pgserve@^2.2), the boot probe would print a misleading
 * "pgserve unreachable" error AND then real connections would still succeed
 * via the resolver's TCP fallback — confusing operators into thinking
 * something was broken when it wasn't. Now the boot probe matches the
 * connection probe.
 */
async function requirePgserveReady(): Promise<void> {
  console.log('  Probing pgserve transport...');
  try {
    const { resolvePgserveTransport } = await import('../lib/db.js');
    const transport = await resolvePgserveTransport();
    if (transport.kind === 'unix') {
      console.log(`  pgserve ready: unix socket ${transport.socketDir}/.s.PGSQL.${transport.port}`);
    } else {
      console.log(`  pgserve ready: tcp ${transport.host}:${transport.port}`);
    }
    try {
      // Service registry entry stays for diagnostics — genie no longer OWNS
      // pgserve, but observability tools still want to know which serve is
      // talking to it. The role name reflects the consumer-only contract.
      const { registerService } = await import('../lib/service-registry.js');
      registerService('pgserve-owner', process.pid);
    } catch {
      // Registry not available — non-fatal
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  pgserve unreachable: ${msg}`);
    process.env.GENIE_PG_NO_AUTOSTART = '1';
    process.env.GENIE_PG_DISABLE_AUTOSTART = '1';
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

/**
 * Atomically claim ownership of `~/.genie/serve.pid` via `O_EXCL`.
 *
 * Resolves the boot-path race where two parallel `serve --foreground`
 * processes both passed a pre-write `isProcessAlive` check and then both
 * stomped the PID file. Symptom: out-of-order PIDs across `serve stop`
 * calls because each stop targeted a different surviving sibling.
 *
 * Strategy:
 *   - `openSync(path, 'wx')` creates the file or fails with EEXIST.
 *   - On EEXIST, read it: a live entry with a known startTime is a real
 *     survivor (we exit 0 with the existing-running message). A dead PID
 *     or legacy/no-startTime entry is treated as stale — unlink and
 *     retry the open ONCE.
 *   - After two failed attempts, refuse to start: a genuine concurrent
 *     race that needs operator attention.
 */
function claimServePidOrExit(): void {
  const path = servePidPath();
  mkdirSync(genieHome(), { recursive: true });
  const startTime = getProcessStartTime(process.pid) ?? 'unknown';
  const payload = `${process.pid}:${startTime}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o644);
      try {
        writeSync(fd, payload);
      } finally {
        closeSync(fd);
      }
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      const existing = readServePid();
      if (existing && existing.startTime !== null && isProcessAlive(existing.pid)) {
        // pm2-authoritative takeover. When WE are the pm2-supervised
        // instance (`pm_id` set) but a *different*, detached non-pm2
        // daemon squats serve.pid, deferring with exit(0) makes pm2
        // autorestart us forever (uptime 0, thousands of restarts,
        // supervision permanently inert). Reclaim instead: terminate the
        // squatter and retry the claim on the next loop iteration.
        if (process.env.pm_id !== undefined && existing.pid !== process.pid) {
          console.log(
            `genie serve (pm2 pm_id=${process.env.pm_id}) reclaiming serve.pid from detached PID ${existing.pid}`,
          );
          try {
            process.kill(existing.pid, 'SIGTERM');
          } catch {
            // already gone — fall through to reclaim
          }
          forceRemoveServePid();
          continue;
        }
        console.log(`genie serve already running (PID ${existing.pid})`);
        // Closes #1490 — also probe the hook UDS health on the live daemon.
        // Pre-fix, an "already running" daemon that pre-dated #1485 (or whose
        // startHookSocketSafely silently failed under detached stdio) would
        // never expose hook.sock, leaving every hook dispatch on the legacy
        // F1 fork path with no operator signal that daemon-mode was inert.
        // Now we surface the gap loudly so `genie serve restart` is the
        // obvious remediation.
        warnIfHookSocketMissing();
        process.exit(0);
      }
      // Stale (dead PID) or legacy (no startTime) — clear and retry once.
      forceRemoveServePid();
    }
  }

  console.error(
    'Could not claim serve.pid after 2 attempts — another genie serve is racing this one. ' +
      'Wait a moment and retry, or run `genie serve status`.',
  );
  process.exit(1);
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

async function loadBrainStartupConfig(deps: StartBrainServerDeps): Promise<BrainStartupConfig> {
  return deps.loadConfig?.() ?? (await import('../lib/genie-config.js')).loadGenieConfigSync();
}

async function importBrainForStartup(deps: StartBrainServerDeps): Promise<BrainServerApi> {
  if (deps.importBrain) return deps.importBrain();
  // Dynamic import — brain is optional. Silently skip if not installed.
  // @ts-expect-error — brain is enterprise-only, not in genie's deps
  return import('@khal-os/brain');
}

async function getBrainStartupPgPort(deps: StartBrainServerDeps): Promise<number | undefined> {
  return deps.getActivePort?.() ?? (await import('../lib/db.js')).getActivePort();
}

function assignBrainHandles(deps: StartBrainServerDeps, brainHandles: StartedBrainVault[]): void {
  if (deps.setBrainHandles) {
    deps.setBrainHandles(brainHandles);
    return;
  }
  handles.brainHandles = brainHandles;
}

function isMissingBrainModule(message: string): boolean {
  return message.includes('Cannot find') || message.includes('not found') || message.includes('MODULE_NOT_FOUND');
}

async function startBrainServer(
  deps: StartBrainServerDeps,
  config: BrainStartupConfig,
  log: BrainStartupLogger,
  warn: BrainStartupLogger,
): Promise<StartedBrainVault[]> {
  const brain = await importBrainForStartup(deps);
  if (!brain.startEmbeddedBrainServer) return [];

  const pgPort = await getBrainStartupPgPort(deps);
  if (!pgPort) {
    log('  Brain server: pgserve not available (skipped)');
    return [];
  }

  const resolveVaults = deps.resolveVaults ?? resolveBrainVaults;
  const startVaults = deps.startVaults ?? startResolvedBrainVaults;
  const resolution = await resolveVaults({ brain, config, warn });
  if (resolution.paths.length === 0) {
    log(`  Brain server: no ${resolution.source} brain vaults found (skipped)`);
    return [];
  }

  log(`  Starting brain server (${resolution.paths.length} ${resolution.source} vault(s))...`);
  const brainHandles = await startVaults(resolution, brain, pgPort, { warn, log });
  assignBrainHandles(deps, brainHandles);
  if (brainHandles.length === 0) {
    log('  Brain server: no vaults started');
  }
  return brainHandles;
}

export async function startBrainServerIfEnabled(deps: StartBrainServerDeps = {}): Promise<StartedBrainVault[]> {
  // Gated by `brain.embedded` config (default: true). Set `brain.embedded=false`
  // in ~/.genie/config.json to opt out — power-users can then run `brain serve`
  // standalone with custom settings (port, brain-path, @next dev channel).
  const config = await loadBrainStartupConfig(deps);
  const brainEmbedded = config.brain?.embedded !== false;
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  if (!brainEmbedded) {
    log('  Brain server: skipped (brain.embedded=false — managed externally)');
    return [];
  }
  try {
    return await startBrainServer(deps, config, log, warn);
  } catch (err) {
    // Brain not installed — fine, skip silently
    const msg = err instanceof Error ? err.message : String(err);
    if (isMissingBrainModule(msg)) return [];
    warn(`  Brain server: failed: ${msg}`);
    return [];
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
  if (handles.brainHandles.length > 0) {
    for (const handle of handles.brainHandles) {
      await handle.stop().catch(() => {});
    }
    handles.brainHandles = [];
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

function removeLegacyPgservePortLockfileIfForcedTcp(): void {
  if (process.env.GENIE_PG_FORCE_TCP !== '1') return;
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

async function startHookSocketSafely(): Promise<void> {
  try {
    const { startHookSocket } = await import('../serve/hook-socket.js');
    // GENIE_STRICT_HOOKS is set by `genie serve --strict-hooks`. The repoRoot
    // for the per-repo tier scan is the daemon's cwd — operators running the
    // daemon from a repo root get that repo's `.genie/hooks/` scanned.
    handles.hookSocket = await startHookSocket({
      strict: process.env.GENIE_STRICT_HOOKS === '1',
      // Use operatorCwd (captured before daemon's cwd pin) so the per-repo
      // hook tier scan still finds the operator's `.genie/hooks/` (issue
      // #1575 — daemon pins cwd to genie's package dir).
      repoRoot: operatorCwd,
    });
  } catch (err) {
    // Bubble up --strict-hooks failures so the operator sees the colliding
    // hook names and can fix the deployment. Other failures (socket EADDRINUSE,
    // etc.) keep the soft-disable behavior so the daemon stays up.
    if (process.env.GENIE_STRICT_HOOKS === '1' && (err as Error).message.includes('--strict-hooks')) {
      throw err;
    }
    console.warn(`  Hook socket: DISABLED — ${(err as Error).message}`);
    handles.hookSocket = null;
  }
}

async function stopHookSocketSafely(): Promise<void> {
  if (!handles.hookSocket) return;
  try {
    await handles.hookSocket.stop();
  } catch {
    // best effort
  }
  handles.hookSocket = null;
}

function buildShutdownFn(headless?: boolean): { shutdown: () => Promise<void>; hasStarted: () => boolean } {
  let shutdownStarted = false;
  const shutdown = async (): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log('\nShutting down genie serve...');
    await stopHookSocketSafely();
    await stopSchedulerHandles();
    await stopOmniAndBrainServices();
    killRegisteredServices();
    // NEVER kill the agent tmux server — agent sessions are eternal and must
    // survive serve restarts. Only the TUI session is owned by serve.
    if (!headless) killTuiSession();
    removeLegacyPgservePortLockfileIfForcedTcp();
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

function writeStartupStatus(status: ServeStartupStatus): void {
  const statusPath = process.env.GENIE_SERVE_STARTUP_STATUS;
  if (!statusPath) return;
  try {
    mkdirSync(dirname(statusPath), { recursive: true });
    writeFileSync(statusPath, `${JSON.stringify(status)}\n`, 'utf-8');
  } catch {
    // Best effort; the parent still falls back to liveness checks.
  }
}

function readStartupStatus(statusPath: string): ServeStartupStatus | null {
  try {
    const parsed = JSON.parse(readFileSync(statusPath, 'utf-8')) as Partial<ServeStartupStatus>;
    if (typeof parsed.ok !== 'boolean') return null;
    return {
      ok: parsed.ok,
      code: typeof parsed.code === 'number' ? parsed.code : undefined,
      lines: Array.isArray(parsed.lines)
        ? parsed.lines.filter((line): line is string => typeof line === 'string')
        : undefined,
    };
  } catch {
    return null;
  }
}

async function waitForStartupStatus(
  statusPath: string,
  childPid: number,
  timeoutMs: number,
): Promise<ServeStartupStatus | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readStartupStatus(statusPath);
    if (status) return status;
    if (!isProcessAlive(childPid)) return { ok: false, code: 1 };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function exitBackgroundStartFailed(): never {
  console.error('Error: genie serve exited immediately.');
  process.exit(1);
}

function exitStartupStatusFailure(status: ServeStartupStatus): never {
  for (const line of status.lines ?? []) console.error(line);
  process.exit(status.code ?? 1);
}

function exitStartupStatusMissing(childPid: number): never {
  console.error('Error: genie serve did not report startup precondition status within 16s.');
  try {
    process.kill(childPid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  process.exit(1);
}

async function confirmBackgroundStarted(childPid: number, startupStatusPath?: string): Promise<void> {
  if (startupStatusPath) {
    const status = await waitForStartupStatus(startupStatusPath, childPid, 16_000);
    forceRemovePath(startupStatusPath);
    if (status?.ok === false) exitStartupStatusFailure(status);
    if (status?.ok !== true) exitStartupStatusMissing(childPid);
    if (!isProcessAlive(childPid)) exitBackgroundStartFailed();
    console.log(`genie serve started (PID ${childPid})`);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (!isProcessAlive(childPid)) exitBackgroundStartFailed();
  console.log(`genie serve started (PID ${childPid})`);
}

/**
 * Operator's invocation cwd, captured BEFORE the daemon pins itself to
 * genie's package directory (issue #1575). Used by the hook socket so the
 * per-repo tier scan still finds the operator's repo `.genie/hooks/`.
 */
let operatorCwd: string = process.cwd();

async function startForeground(headless?: boolean, autoFix = true): Promise<void> {
  // Capture the operator's cwd FIRST — pinCwdToGeniePackageDir() below will
  // chdir away for the daemon's lifetime so pgserve fingerprints us as the
  // genie package (issue #1575). Anything that legitimately needs the
  // operator's cwd (hook-socket repoRoot, future relative-path lookups)
  // must read `operatorCwd`, not `process.cwd()`.
  operatorCwd = process.cwd();
  claimServePidOrExit();
  // Default pgserve v2 uses a Unix socket and must coexist with legacy v1
  // TCP daemons. Only touch ~/.genie/pgserve.port when the operator has
  // explicitly forced the legacy TCP path.
  removeLegacyPgservePortLockfileIfForcedTcp();
  const { skipTui, mode } = resolveServeMode(headless);
  process.env.GENIE_IS_DAEMON = '1';
  // Pin cwd to genie's package directory for the daemon's lifetime so every
  // pgserve accept under this PID fingerprints to the same persistent DB
  // (issue #1575). Must run BEFORE any getConnection() call (preconditions
  // included). No-op if already pinned or if the package dir cannot be
  // resolved.
  try {
    const { pinCwdToGeniePackageDir } = await import('../lib/db.js');
    pinCwdToGeniePackageDir();
  } catch {
    // Non-fatal: db module load failure surfaces later via preconditions.
  }
  // claimServePidOrExit already wrote `${pid}:${startTime}` atomically.
  console.log(`genie serve starting (PID ${process.pid}, mode: ${mode})`);

  // Preconditions call getConnection(); the daemon marker must already be set
  // so pgserve starts in this process instead of recursively auto-spawning serve.
  const preconditionLines: string[] = [];
  const preconditionLog = process.env.GENIE_SERVE_STARTUP_STATUS
    ? (line: string): void => {
        preconditionLines.push(line);
        console.log(line);
      }
    : undefined;
  try {
    const preconditionsOk = await runStartPreconditions(autoFix, preconditionLog);
    if (!preconditionsOk) {
      writeStartupStatus({ ok: false, code: 2, lines: preconditionLines });
      removeServePid();
      process.exit(2);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`genie serve start preconditions failed: ${msg}`);
    writeStartupStatus({
      ok: false,
      code: 1,
      lines: [...preconditionLines, `genie serve start preconditions failed: ${msg}`],
    });
    removeServePid();
    process.exit(1);
  }
  writeStartupStatus({ ok: true });

  if (!skipTui) {
    await ensureTmux();
  }

  await requirePgserveReady();
  await startBrainServerIfEnabled();
  if (!headless) logAgentSessionInfo();
  handles.agentWatcher = await startAgentSync();
  startTuiSessionIfEnabled(skipTui);
  await startScheduler();
  await startDetectorSchedulerSafely();
  await startExecutorReadEndpointSafely();
  await startOmniApprovalHandlerSafely();
  await startOmniBridgeSafely();
  await startHookSocketSafely();

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
async function startBackground(headless?: boolean, autoFix = true): Promise<void> {
  // PM2-supervised mode: the calling process IS the supervised entry. Forking
  // a detached --foreground child and exiting would trigger an
  // unstable-restart loop (pm2 sees the parent exit, respawns it, repeat) AND
  // leave the actual long-running daemon untracked by pm2. Instead, run the
  // daemon in-process so pm2 tracks the real PID. Detection: pm2 sets `pm_id`
  // on supervised processes (alongside `name`, `exec_mode`, etc.).
  if (process.env.pm_id) {
    return startForeground(headless, autoFix);
  }

  const existingEntry = readServePid();
  if (existingEntry && isProcessAlive(existingEntry.pid)) {
    console.log(`genie serve already running (PID ${existingEntry.pid})`);
    process.exit(0);
  }
  if (existingEntry) {
    forceRemoveServePid();
  }

  const startupStatusPath = autoFix ? undefined : serveStartupStatusPath();

  const extraArgs = ['serve', '--foreground'];
  if (headless) extraArgs.push('--headless');
  if (!autoFix) extraArgs.push('--no-fix');
  const { command, args } = respawnInvocation(extraArgs);

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      GENIE_IS_DAEMON: '1',
      ...(startupStatusPath ? { GENIE_SERVE_STARTUP_STATUS: startupStatusPath } : {}),
    },
  });

  child.unref();

  if (child.pid) {
    await confirmBackgroundStarted(child.pid, startupStatusPath);
  } else {
    console.error('Error: failed to spawn genie serve');
    process.exit(1);
  }
}

/** Unlink serve.pid unconditionally, swallowing ENOENT and permission errors. */
function forceRemoveServePid(): void {
  forceRemovePath(servePidPath());
}

function forceRemovePath(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

/** Stop genie serve and all child services */
async function stopServe(): Promise<void> {
  const entry = readServePid();

  if (!entry) {
    console.log('genie serve is not running (no PID file).');
    return;
  }

  // Block auto-start cascade BEFORE issuing SIGTERM. Cleared in `finally`
  // once the PID file is gone, so the next genie invocation can spawn a
  // fresh serve. The lock has a TTL so a crashed stop cannot brick autostart.
  writeStoppingLockSync();
  try {
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
  } finally {
    clearStoppingLock();
  }
}

/** Check pgserve health and print status */
async function printPgserveHealth(): Promise<void> {
  try {
    const { isAvailable, getActivePort, isSocketMode, resolvePgserveSocketDir } = await import('../lib/db.js');
    const dbOk = await isAvailable();
    const where = isSocketMode() ? `socket ${resolvePgserveSocketDir()}` : `port ${getActivePort()}`;
    console.log(`  pgserve:    ${dbOk ? `healthy (${where})` : 'unreachable'}`);
  } catch {
    console.log('  pgserve:    unavailable');
  }
}

/**
 * Resolve the hook UDS path the same way startHookSocket does — env override
 * first, fall back to ~/.genie/hook.sock. Closes #1490: warm-restart and
 * status output need to agree on which socket they look for.
 */
function hookSocketPath(): string {
  return process.env.GENIE_HOOK_SOCK ?? join(genieHome(), 'hook.sock');
}

/**
 * Closes #1490 — log a clear warning when a live daemon is missing the hook
 * UDS (and therefore daemon-mode hook dispatch is silently inert; every
 * hook dispatch falls back to the legacy F1 bun fork). Called by both
 * `claimServePidOrExit` (before exiting on "already running") and
 * `printHookSocketStatus` (called by `genie serve status`).
 */
function warnIfHookSocketMissing(): void {
  const sock = hookSocketPath();
  if (existsSync(sock)) return;
  const lines = [
    `  WARNING: hook UDS not found at ${sock}.`,
    '  Daemon-mode hook dispatch is INACTIVE — every hook will fall back',
    '  to the legacy F1 bun-fork path (hookify-perf-foundation gains lost).',
    '  Remediation: `genie serve stop && genie serve start` to refresh the',
    '  daemon and re-create the socket.',
  ];
  console.warn(lines.join('\n'));
}

/** Print hook UDS status for `genie serve status`. */
function printHookSocketStatus(): void {
  const sock = hookSocketPath();
  if (existsSync(sock)) {
    console.log(`  hook UDS:   listening at ${sock}`);
  } else {
    console.log(`  hook UDS:   MISSING at ${sock} (F1 fallback active — see #1490)`);
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
    if (handles.brainHandles.length > 0) {
      for (const handle of handles.brainHandles) {
        await probeBrainHealth(handle.port);
      }
      return;
    }
    const brainPort = resolveBrainPortFromWorkspace(brain);
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
  printHookSocketStatus();
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
  /**
   * Refuse to start when the boot-scan loader finds two external `.ts` hook
   * files declaring the same `name`. Default behavior is to log a warning,
   * keep the higher-precedence file, and continue. Operators who want a hard
   * gate (e.g. CI / fleet rollouts) pass `--strict-hooks`.
   */
  strictHooks?: boolean;
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
async function runStartPreconditions(autoFix: boolean, log?: (line: string) => void): Promise<boolean> {
  if (process.env.GENIE_SKIP_PRECONDITIONS === '1') return true;
  const { ensureServeReady } = await import('./serve/ensure-ready.js');
  const report = await ensureServeReady({ autoFix, deps: log ? { log } : undefined });
  if (autoFix) return true;
  if (!report.ok) {
    const message = 'genie serve start refused: one or more preconditions are not ok (--no-fix mode).';
    if (log) log(message);
    else console.error(message);
    return false;
  }
  return true;
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
    .option('--strict-hooks', 'Refuse to start on any same-name external hook collision (default: warn + continue)')
    .action(async (options: ServeStartOptions) => {
      // commander's `--no-fix` flips `options.fix` to false. Default is true.
      const autoFix = options.fix !== false;
      // Propagate --strict-hooks to startHookSocketSafely via env so the
      // signature stays narrow (the daemon-startup graph is deep). Read once
      // by hook-socket.ts at boot; never mutated thereafter.
      if (options.strictHooks) {
        process.env.GENIE_STRICT_HOOKS = '1';
      }
      if (options.daemon) {
        await startBackground(options.headless, autoFix);
      } else {
        await startForeground(options.headless, autoFix);
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
