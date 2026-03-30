import { shellQuote } from './team-lead-command.js';
import { executeTmux as wrapperExecuteTmux } from './tmux-wrapper.js';

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
  try {
    return await wrapperExecuteTmux(tmuxCommand);
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
    const output = await executeTmux(`list-windows -t '${sessionId}' -F '${format}'`);

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
 * Ensure a tmux window exists for a team within a session.
 * Idempotent: if the window already exists, returns its first pane.
 * If not, creates the window and returns pane 0.
 */
export async function ensureTeamWindow(
  session: string,
  teamName: string,
  workingDir?: string,
): Promise<{ windowId: string; windowName: string; paneId: string; created: boolean }> {
  // Auto-create session if it doesn't exist (enables --session with new session names)
  const sessionExists = await findSessionByName(session);
  if (!sessionExists) {
    await createSession(session);
  }

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
    return { windowId: existing.id, windowName: teamName, paneId, created: false };
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
  return { windowId: newWindow.id, windowName: teamName, paneId, created: true };
}

/**
 * Map agent color names to tmux hex colors for active border styling.
 * Palette matches ClaudeTeamColor from provider-adapters.
 */
const TMUX_COLOR_MAP: Record<string, string> = {
  red: '#b83030',
  blue: '#2a6cb8',
  green: '#20a050',
  yellow: '#b8a020',
  purple: '#7830b8',
  orange: '#b86820',
  pink: '#b83078',
  cyan: '#20a0a0',
};

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
  writeFileSync(
    PANE_COLOR_SCRIPT,
    `#!/bin/bash
# Genie tmux pane color router — reads @genie_color pane option
PANE_ID="$1"
COLOR=$(tmux display-message -p -t "$PANE_ID" '#{@genie_color}' 2>/dev/null)
[ -z "$COLOR" ] && COLOR="default"
tmux set-option -w pane-active-border-style "fg=$COLOR"
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
  const { basename } = require('node:path');
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
 * Check if a tmux pane is still alive by attempting a minimal capture.
 * Returns false for invalid pane IDs ('inline', empty, non-%N format).
 */
export async function isPaneAlive(paneId: string): Promise<boolean> {
  if (!paneId || paneId === 'inline') return false;
  if (!/^%\d+$/.test(paneId)) return false;
  try {
    await capturePaneContent(paneId, 1);
    return true;
  } catch {
    return false;
  }
}
