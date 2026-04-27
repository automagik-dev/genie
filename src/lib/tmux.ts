import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { palette, rotateHue } from '../../packages/genie-tokens';
import { tmuxBin } from './ensure-tmux.js';
import { shellQuote } from './team-lead-command.js';
// tmux-wrapper imported dynamically inside executeTmux for test mockability

// Basic interfaces for tmux objects
interface TmuxSession {
  id: string;
  name: string;
  attached: boolean;
  windows: number;
}

interface TmuxWindow {
  id: string;
  name: string;
  index: number;
  active: boolean;
  sessionId: string;
}

interface TmuxPane {
  id: string;
  windowId: string;
  active: boolean;
  title: string;
}

/**
 * Execute a tmux command and return the result
 */
export async function executeTmux(tmuxCommand: string): Promise<string> {
  const { executeTmux: wrapperExec } = await import('./tmux-wrapper.js');
  try {
    return await wrapperExec(tmuxCommand);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to execute tmux command: ${message}`);
  }
}

/**
 * Get the current tmux session name.
 *
 * Fallback chain:
 *   1. TMUX env → display-message (running inside tmux)
 *   2. `tmux list-sessions` → first session (tmux server running, but invoked outside)
 *
 * The optional `hint` parameter biases step 2: if a session name contains
 * the hint, it is preferred over the first match.
 */
export async function getCurrentSessionName(hint?: string): Promise<string | null> {
  // 1. Inside tmux — authoritative
  if (process.env.TMUX) {
    try {
      const name = (await executeTmux("display-message -p '#{session_name}'")).trim();
      return name || null;
    } catch {
      return null;
    }
  }

  // 2. Outside tmux — try list-sessions fallback
  try {
    const sessions = await listSessions();
    if (sessions.length === 0) return null;
    if (hint) {
      const match = sessions.find((s) => s.name.includes(hint));
      if (match) return match.name;
    }
    return sessions[0].name;
  } catch {
    return null;
  }
}

/**
 * List all tmux sessions
 */
async function listSessions(): Promise<TmuxSession[]> {
  try {
    const format = '#{session_id}:#{session_name}:#{?session_attached,1,0}:#{session_windows}';
    const output = await executeTmux(`list-sessions -F '${format}'`);

    if (!output) return [];

    return output.split('\n').map((line) => {
      const [id, name, attached, windows] = line.split(':');
      return {
        id,
        name,
        attached: attached === '1',
        windows: Number.parseInt(windows, 10),
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Handle "no server running" gracefully
    if (message.includes('no server running')) {
      return [];
    }
    throw error;
  }
}

/**
 * Find a session by name
 */
export async function findSessionByName(name: string): Promise<TmuxSession | null> {
  try {
    const sessions = await listSessions();
    return sessions.find((session) => session.name === name) || null;
  } catch (_error) {
    return null;
  }
}

/**
 * Get a tmux environment variable for a specific window target.
 * Uses `tmux show-environment -t <target> <varName>` which returns "VAR=value".
 * Returns null if the variable is not set or the target doesn't exist.
 */
export async function getWindowEnv(target: string, varName: string): Promise<string | null> {
  try {
    const output = await executeTmux(`show-environment -t ${shellQuote(target)} ${shellQuote(varName)}`);
    // Output format: "VARNAME=value"
    const prefix = `${varName}=`;
    if (output?.startsWith(prefix)) {
      return output.slice(prefix.length).trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Set a tmux environment variable scoped to a specific window target.
 * Uses `tmux set-environment -t <target> <varName> <value>`.
 */
export async function setWindowEnv(target: string, varName: string, value: string): Promise<void> {
  await executeTmux(`set-environment -t ${shellQuote(target)} ${shellQuote(varName)} ${shellQuote(value)}`);
}

/**
 * Kill a tmux session by ID
 */
export async function killSession(sessionId: string): Promise<void> {
  await executeTmux(`kill-session -t '${sessionId}'`);
}

/**
 * List windows in a session
 */
export async function listWindows(sessionId: string): Promise<TmuxWindow[]> {
  try {
    const format = '#{window_id}:#{window_name}:#{window_index}:#{?window_active,1,0}';
    // Use `=` prefix to force literal session-name match. Without it, tmux
    // interprets values like `@46` as window-id syntax (`@N`) instead of
    // session names, causing "can't find window: @46" errors when looking up
    // anonymously-named sessions created by `genie spawn --new-window`.
    const output = await executeTmux(`list-windows -t '=${sessionId}' -F '${format}'`);

    if (!output) return [];

    return output.split('\n').map((line) => {
      const [id, name, indexStr, active] = line.split(':');
      return {
        id,
        name,
        index: Number.parseInt(indexStr, 10),
        active: active === '1',
        sessionId,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Handle session not found or no server running
    if (message.includes('no server running') || message.includes('session not found')) {
      return [];
    }
    throw error;
  }
}

/**
 * List panes in a window
 */
export async function listPanes(windowId: string): Promise<TmuxPane[]> {
  try {
    const format = '#{pane_id}:#{pane_title}:#{?pane_active,1,0}';
    const output = await executeTmux(`list-panes -t '${windowId}' -F '${format}'`);

    if (!output) return [];

    return output.split('\n').map((line) => {
      const [id, title, active] = line.split(':');
      return {
        id,
        windowId,
        title: title,
        active: active === '1',
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Handle window not found or no server running
    if (message.includes('no server running') || message.includes('window not found')) {
      return [];
    }
    throw error;
  }
}

/**
 * Capture content from a specific pane, by default the latest 200 lines.
 */
export async function capturePaneContent(paneId: string, lines = 200, includeColors = false): Promise<string> {
  try {
    const colorFlag = includeColors ? '-e' : '';
    return await executeTmux(`capture-pane -p ${colorFlag} -t '${paneId}' -S -${lines} -E -`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Handle pane not found or no server running
    if (message.includes('no server running') || message.includes('pane not found')) {
      return '';
    }
    throw error;
  }
}

/**
 * Create a new tmux session
 */
/** @public - used in team-auto-spawn.ts (knip-ignored file) */
export async function createSession(name: string): Promise<TmuxSession | null> {
  await executeTmux(`new-session -d -s "${name}" -e LC_ALL=C.UTF-8 -e LANG=C.UTF-8`);
  return findSessionByName(name);
}

/**
 * Create a new window in a session
 */
async function createWindow(sessionId: string, name: string, workingDir?: string): Promise<TmuxWindow | null> {
  const cdFlag = workingDir ? ` -c '${workingDir.replace(/'/g, "'\\''")}'` : '';
  // Use -d (don't switch focus) and -P -F to capture the window ID and index directly.
  // Avoids relying on findWindowByName which can fail if automatic-rename fires.
  const output = await executeTmux(
    `new-window -d -P -F '#{window_id}:#{window_index}' -t '${sessionId}:' -n '${name}'${cdFlag}`,
  );
  const [windowId, indexStr] = output.trim().split(':');
  if (!windowId) return null;

  // Lock the window name — prevent tmux automatic-rename from overriding it
  try {
    await executeTmux(`set-window-option -t '${windowId}' automatic-rename off`);
  } catch {
    /* best-effort */
  }

  return { id: windowId, name, index: Number.parseInt(indexStr, 10) || 0, active: false, sessionId };
}

/**
 * Find a window by name within a session
 */
export async function findWindowByName(sessionId: string, name: string): Promise<TmuxWindow | null> {
  const windows = await listWindows(sessionId);
  return windows.find((w) => w.name === name) || null;
}

/**
 * Ensure the master (first) window of a session stays at index 0.
 *
 * When new windows are created, tmux may assign them index 0 if gaps exist
 * (e.g., after renumber-windows or with base-index 0). This pushes the
 * original master window to a higher index. This helper detects that case
 * and uses swap-window to restore the master window to index 0.
 *
 * @param session - The tmux session name
 * @param masterName - The expected name of the master/team-lead window
 */
async function ensureMasterWindow(session: string, masterName: string): Promise<void> {
  try {
    const windows = await listWindows(session);
    if (windows.length < 2) return; // Nothing to swap with a single window

    const masterWindow = windows.find((w) => w.name === masterName);
    if (!masterWindow) return; // Master window not found — nothing to fix

    // Find the lowest index in the session (respects user's base-index setting)
    const minIndex = Math.min(...windows.map((w) => w.index));

    if (masterWindow.index === minIndex) return; // Already at the correct position

    // Swap the master window with whatever is at the lowest index
    await executeTmux(`swap-window -s '${session}:${masterWindow.index}' -t '${session}:${minIndex}'`);
  } catch {
    /* best-effort — don't break window creation if swap fails */
  }
}

/**
 * Atomically ensure a tmux session exists.
 * Uses `new-session` directly and catches "duplicate session" errors,
 * eliminating the TOCTOU race of find-then-create.
 */
async function ensureSessionExists(name: string): Promise<void> {
  // §19 v3 belt-and-suspenders: refuse session names that mimic tmux ids.
  // tmux uses `@N` for window-ids and `$N` for session-ids; allowing those
  // shapes as session NAMES creates unsearchable ghost sessions (the `@60`
  // trap that captured spawns all night on 2026-04-26 → 04-27). Even if a
  // caller passes one of these by accident, refusing here short-circuits
  // the cascade. Twin's evidence at
  // `/tmp/genie-recover/twin-overnight/finding-001-ghost-session-at60.md`.
  if (/^[@$]\d+$/.test(name)) {
    throw new Error(
      `Refused to create tmux session with id-shaped name "${name}". Names matching /^[@$]\\d+$/ collide with tmux's window-id (@N) and session-id ($N) notation, producing ghost sessions that cannot be safely targeted. Pass a human-readable session name (e.g. the team or agent name) instead.`,
    );
  }
  try {
    await executeTmux(`new-session -d -s "${name}" -e LC_ALL=C.UTF-8 -e LANG=C.UTF-8`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // "duplicate session" means another process created it first — that's fine
    if (message.includes('duplicate session')) return;
    throw error;
  }
}

/**
 * Ensure a tmux window exists for a team within a session.
 * Idempotent: if the window already exists, returns its first pane.
 * If not, creates the window and returns pane 0.
 *
 * Retries with backoff on "no server running" errors (tmux server crash recovery).
 */
export async function ensureTeamWindow(
  session: string,
  teamName: string,
  workingDir?: string,
): Promise<{ windowId: string; windowName: string; sessionName: string; paneId: string; created: boolean }> {
  const maxRetries = 3;
  const baseDelayMs = 250;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await ensureTeamWindowOnce(session, teamName, workingDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes('no server running') ||
        message.includes('server exited') ||
        message.includes('error connecting')
      ) {
        if (attempt < maxRetries - 1) {
          const delay = baseDelayMs * 2 ** attempt;
          console.warn(
            `[genie-tmux] tmux server unreachable (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }
      throw error;
    }
  }

  // Unreachable, but TypeScript doesn't know that
  throw new Error(`Failed to ensure team window after ${maxRetries} attempts`);
}

/**
 * Single-attempt implementation of ensureTeamWindow (called by the retry wrapper).
 */
async function ensureTeamWindowOnce(
  session: string,
  teamName: string,
  workingDir?: string,
): Promise<{ windowId: string; windowName: string; sessionName: string; paneId: string; created: boolean }> {
  // Atomic session creation — eliminates TOCTOU race
  await ensureSessionExists(session);

  const existing = await findWindowByName(session, teamName);
  if (existing) {
    // Ensure automatic-rename is off so the team name sticks
    try {
      await executeTmux(`set-window-option -t '${existing.id}' automatic-rename off`);
    } catch {
      /* best-effort */
    }
    // Rehydrate pane color hook (survives tmux restarts)
    await rehydratePaneColorHook(existing.id);
    const panes = await listPanes(existing.id);
    const paneId = panes.length > 0 ? panes[0].id : `${session}:${teamName}.0`;
    return { windowId: existing.id, windowName: teamName, sessionName: session, paneId, created: false };
  }

  // Remember the current master window (lowest-index window) before creating
  const windowsBefore = await listWindows(session);
  const masterBefore = windowsBefore.length > 0 ? windowsBefore.reduce((a, b) => (a.index <= b.index ? a : b)) : null;

  const newWindow = await createWindow(session, teamName, workingDir);
  if (!newWindow) {
    throw new Error(`Failed to create team window "${teamName}" in session "${session}"`);
  }

  // Ensure the master window stays at index 0 after the new window is created
  if (masterBefore) {
    await ensureMasterWindow(session, masterBefore.name);
  }

  // Install pane color hook on new window
  await rehydratePaneColorHook(newWindow.id);
  const panes = await listPanes(newWindow.id);
  const paneId = panes.length > 0 ? panes[0].id : `${session}:${teamName}.0`;
  return { windowId: newWindow.id, windowName: teamName, sessionName: session, paneId, created: true };
}

/**
 * Map agent color names to tmux hex colors for active border styling.
 * Palette matches ClaudeTeamColor from provider-adapters. Hues are derived
 * by rotating `palette.accent` so every window-bg stays palette-coherent
 * (no hand-picked magic numbers).
 */
const TMUX_COLOR_NAMES = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'] as const;
const TMUX_COLOR_MAP: Record<string, string> = Object.fromEntries(
  TMUX_COLOR_NAMES.map((name, i) => [name, rotateHue(palette.accent, i * 45)]),
);

const PANE_COLOR_SCRIPT = `${require('node:os').homedir()}/.genie/tmux-pane-color.sh`;

/**
 * Ensure the pane-color router script exists.
 * Reads @genie_color tmux pane option instead of JSON files.
 */
function ensurePaneColorScript(): void {
  const { existsSync, writeFileSync, mkdirSync, chmodSync } = require('node:fs');
  const { dirname } = require('node:path');

  if (existsSync(PANE_COLOR_SCRIPT)) return;

  mkdirSync(dirname(PANE_COLOR_SCRIPT), { recursive: true });
  const bin = tmuxBin();
  writeFileSync(
    PANE_COLOR_SCRIPT,
    `#!/bin/bash
# Genie tmux pane color router — reads @genie_color pane option
PANE_ID="$1"
COLOR=$(${bin} display-message -p -t "$PANE_ID" '#{@genie_color}' 2>/dev/null)
[ -z "$COLOR" ] && COLOR="default"
${bin} set-option -w pane-active-border-style "fg=$COLOR"
`,
  );
  chmodSync(PANE_COLOR_SCRIPT, 0o755);
}

/**
 * Register a pane→color mapping and install the window focus hook.
 * Stores color in tmux pane option (@genie_color) and PG agents.pane_color.
 */
export async function applyPaneColor(paneId: string, color: string, windowId?: string): Promise<void> {
  const hex = TMUX_COLOR_MAP[color] ?? TMUX_COLOR_MAP.blue;

  try {
    ensurePaneColorScript();

    // Store color in tmux pane option (runtime cache — no files)
    await executeTmux(`set-option -p -t '${paneId}' @genie_color '${hex}'`);

    // Update PG executors table (authoritative source — survives restarts)
    try {
      const { getConnection } = await import('./db.js');
      const sql = await getConnection();
      await sql`UPDATE executors SET pane_color = ${hex} WHERE tmux_pane_id = ${paneId}`;
    } catch {
      /* PG update is best-effort */
    }

    if (windowId) {
      await executeTmux(`set-hook -w -t '${windowId}' pane-focus-in "run-shell '${PANE_COLOR_SCRIPT} #{pane_id}'"`);
    }
  } catch {
    /* best-effort — don't break spawn if tmux styling fails */
  }
}

/**
 * Rehydrate the pane-focus-in color hook on a window.
 */
async function rehydratePaneColorHook(windowId: string): Promise<void> {
  try {
    ensurePaneColorScript();
    await executeTmux(`set-hook -w -t '${windowId}' pane-focus-in "run-shell '${PANE_COLOR_SCRIPT} #{pane_id}'"`);
  } catch {
    /* best-effort */
  }
}

/**
 * Resolve the tmux session that should host windows for a given repo.
 *
 * Resolution order:
 *   1. `basename(repoPath)` exact match against existing tmux sessions
 *   2. `process.env.TMUX` current session (caller is inside tmux)
 *   3. `tmux list-sessions` partial match (session name contains basename)
 *   4. Return derived basename (ensureTeamWindow will create it on demand)
 *
 * This prevents session explosion: teams for `/workspace/repos/genie` land
 * in the existing `genie` session instead of creating a new session per team.
 */
export async function resolveRepoSession(repoPath: string): Promise<string> {
  const derived = basename(repoPath);

  try {
    const sessions = await listSessions();

    // 1. Exact match — basename maps directly to a session
    const exact = sessions.find((s) => s.name === derived);
    if (exact) return exact.name;

    // 2. Inside tmux — use current session
    if (process.env.TMUX) {
      try {
        const name = (await executeTmux("display-message -p '#{session_name}'")).trim();
        if (name) return name;
      } catch {
        /* fall through */
      }
    }

    // 3. Partial match — session name contains the repo basename
    const partial = sessions.find((s) => s.name.includes(derived));
    if (partial) return partial.name;
  } catch {
    /* tmux not available — fall through to derived name */
  }

  // 4. Last resort — derived basename (will be created on demand by ensureTeamWindow)
  return derived;
}

/**
 * Error thrown when the tmux server is unreachable (crashed, not started, etc.).
 * Callers can catch this to distinguish "tmux is down" from "pane is dead".
 */
export class TmuxUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TmuxUnreachableError';
  }
}

/**
 * Check if a tmux socket file exists on disk.
 *
 * tmux stores per-user sockets at `/tmp/tmux-<uid>/<socketName>`. If the
 * file is missing, the tmux server for that socket is not running and
 * every pane registered against it is permanently dead — no amount of
 * transient-retry will recover. Callers use this to distinguish
 * "socket permanently gone" from the transient `TmuxUnreachableError`
 * surfaced by `isPaneAlive`.
 *
 * Returns `false` for empty/undefined socket names (safer default than
 * assuming `true` and then trying to probe a non-existent server).
 */
function isTmuxSocketAlive(socketName: string | undefined | null): boolean {
  if (!socketName) return false;
  const uid = process.getuid?.() ?? 501;
  return existsSync(join(`/tmp/tmux-${uid}`, socketName));
}

/**
 * Probe whether the tmux server on `socketName` is actually accepting
 * commands — not just whether its socket file exists on disk.
 *
 * `isTmuxSocketAlive` is a pure `existsSync` check, which returns `true`
 * for orphaned socket files left behind when the tmux server dies
 * ungracefully (SIGKILL, OOM, host reboot mid-session). Every subsequent
 * `isPaneAlive` probe on such a "zombie socket" throws
 * `TmuxUnreachableError`, which jams the reconciler's dead-socket
 * fast-path, the scheduler's recovery pass, and `resolveSpawnIdentity` —
 * users see `genie agent spawn` fail with a raw tmux stderr.
 *
 * This probe runs `tmux -L <sock> list-sessions`; success (incl. empty
 * server) means reachable, failure means the socket is stale. We do not
 * unlink the stale socket — tmux recreates it atomically on next
 * session start, and silent cleanup of shared fs state outside our
 * ownership is risky.
 */
export async function isTmuxServerReachable(socketName: string | undefined | null): Promise<boolean> {
  if (!socketName) return false;
  if (!isTmuxSocketAlive(socketName)) return false;
  try {
    const { execSync } = await import('node:child_process');
    execSync(`${tmuxBin()} -L ${shellQuote(socketName)} list-sessions -F ''`, {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a tmux pane is still alive.
 * Returns false for invalid pane IDs ('inline', empty, non-%N format).
 * Returns false when the pane is dead but tmux is reachable.
 * Throws TmuxUnreachableError when the tmux server itself is unreachable.
 */
export async function isPaneAlive(paneId: string): Promise<boolean> {
  if (!paneId || paneId === 'inline') return false;
  if (!/^%\d+$/.test(paneId)) return false;
  try {
    const paneDead = (await executeTmux(`display-message -t '${paneId}' -p '#{pane_dead}'`)).trim();
    // tmux 3.5+ returns empty string (not error) for non-existent panes —
    // only "0" means alive; "1" means dead; anything else means not found.
    return paneDead === '0';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('no server running') ||
      message.includes('server exited') ||
      message.includes('error connecting')
    ) {
      throw new TmuxUnreachableError(message);
    }
    // Pane not found, session not found, etc. — pane is dead but tmux is reachable
    return false;
  }
}

/**
 * execSync signature for dependency injection in tests.
 * Accepting execSync as a parameter lets tests stub it without
 * `mock.module('node:child_process', ...)`, which is process-global
 * and leaks across test files (breaks audit-context, freshness, pg tests).
 */
type ExecSyncFn = (cmd: string, opts: { encoding: 'utf-8'; timeout: number }) => string;

/**
 * Check if a tmux pane has a running descendant process matching the given name.
 * Walks two levels of the process tree (shell -> process -> subprocess) to handle
 * cases where the target runs under a wrapper script.
 * Returns false if the pane doesn't exist or the process is not found.
 *
 * @param execSyncFn - injected for testing; defaults to node:child_process.execSync
 */
export async function isPaneProcessRunning(
  paneId: string,
  processName: string,
  execSyncFn?: ExecSyncFn,
): Promise<boolean> {
  if (!paneId || paneId === 'inline') return false;
  if (!/^%\d+$/.test(paneId)) return false;

  try {
    const panePid = (await executeTmux(`display-message -t '${paneId}' -p '#{pane_pid}'`)).trim();
    if (!panePid || !/^\d+$/.test(panePid)) return false;

    const exec: ExecSyncFn = execSyncFn ?? ((await import('node:child_process')).execSync as ExecSyncFn);
    // Check direct children and grandchildren for the target process name
    const output = exec(
      `pgrep -la -P ${panePid} 2>/dev/null; for cpid in $(pgrep -P ${panePid} 2>/dev/null); do pgrep -la -P "$cpid" 2>/dev/null; done; true`,
      { encoding: 'utf-8', timeout: 5000 },
    );
    return output.toLowerCase().includes(processName.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Kill a tmux window by session:window target.
 * Returns true if the window was killed, false if it didn't exist or the kill failed.
 */
export async function killWindow(sessionName: string, windowName: string): Promise<boolean> {
  try {
    await executeTmux(`kill-window -t ${shellQuote(`${sessionName}:${windowName}`)}`);
    return true;
  } catch {
    return false;
  }
}
