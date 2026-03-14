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
 * List all tmux sessions
 */
export async function listSessions(): Promise<TmuxSession[]> {
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
  await executeTmux(`kill-session -t ${shellQuote(sessionId)}`);
}

/**
 * List windows in a session
 */
export async function listWindows(sessionId: string): Promise<TmuxWindow[]> {
  try {
    const format = '#{window_id}:#{window_name}:#{?window_active,1,0}';
    const output = await executeTmux(`list-windows -t '${sessionId}' -F '${format}'`);

    if (!output) return [];

    return output.split('\n').map((line) => {
      const [id, name, active] = line.split(':');
      return {
        id,
        name,
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
export async function createWindow(sessionId: string, name: string, workingDir?: string): Promise<TmuxWindow | null> {
  const cdFlag = workingDir ? ` -c '${workingDir.replace(/'/g, "'\\''")}'` : '';
  // Use -d (don't switch focus) and -P -F to capture the window ID directly.
  // Avoids relying on findWindowByName which can fail if automatic-rename fires.
  const output = await executeTmux(`new-window -d -P -F '#{window_id}' -t '${sessionId}:' -n '${name}'${cdFlag}`);
  const windowId = output.trim();
  if (!windowId) return null;

  // Lock the window name — prevent tmux automatic-rename from overriding it
  try {
    await executeTmux(`set-window-option -t '${windowId}' automatic-rename off`);
  } catch {
    /* best-effort */
  }

  return { id: windowId, name, active: false, sessionId };
}

/**
 * Find a window by name within a session
 */
export async function findWindowByName(sessionId: string, name: string): Promise<TmuxWindow | null> {
  const windows = await listWindows(sessionId);
  return windows.find((w) => w.name === name) || null;
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

  const newWindow = await createWindow(session, teamName, workingDir);
  if (!newWindow) {
    throw new Error(`Failed to create team window "${teamName}" in session "${session}"`);
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

const PANE_COLORS_PATH = `${require('node:os').homedir()}/.genie/pane-colors.json`;
const PANE_COLOR_SCRIPT = `${require('node:os').homedir()}/.genie/tmux-pane-color.sh`;

/**
 * Ensure the pane-color router script exists.
 * This script is called by the tmux pane-focus-in hook and reads
 * ~/.genie/pane-colors.json to resolve pane_id → border color.
 */
function ensurePaneColorScript(): void {
  const { existsSync, writeFileSync, mkdirSync, chmodSync } = require('node:fs');
  const { dirname } = require('node:path');

  if (existsSync(PANE_COLOR_SCRIPT)) return;

  mkdirSync(dirname(PANE_COLOR_SCRIPT), { recursive: true });
  writeFileSync(
    PANE_COLOR_SCRIPT,
    `#!/bin/bash
# Genie tmux pane color router — maps focused pane to agent border color
PANE_ID="$1"
MAP="$HOME/.genie/pane-colors.json"
[ -f "$MAP" ] || exit 0
COLOR=$(jq -r --arg p "$PANE_ID" '.[$p] // empty' "$MAP" 2>/dev/null)
[ -z "$COLOR" ] && COLOR="default"
tmux set-option -w pane-active-border-style "fg=$COLOR"
`,
  );
  chmodSync(PANE_COLOR_SCRIPT, 0o755);
}

/**
 * Register a pane→color mapping and install the window focus hook.
 * When any pane in the window gains focus, the active border color
 * changes to match that agent's assigned color.
 */
export async function applyPaneColor(paneId: string, color: string, windowId?: string): Promise<void> {
  const hex = TMUX_COLOR_MAP[color] ?? TMUX_COLOR_MAP.blue;
  const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs');
  const { dirname } = require('node:path');

  try {
    // 1. Ensure script exists
    ensurePaneColorScript();

    // 2. Update pane-colors.json
    let map: Record<string, string> = {};
    if (existsSync(PANE_COLORS_PATH)) {
      try {
        map = JSON.parse(readFileSync(PANE_COLORS_PATH, 'utf-8'));
      } catch {
        map = {};
      }
    } else {
      mkdirSync(dirname(PANE_COLORS_PATH), { recursive: true });
    }
    map[paneId] = hex;
    writeFileSync(PANE_COLORS_PATH, JSON.stringify(map, null, 2));

    // 3. Install window hook (idempotent — overwrites previous)
    if (windowId) {
      await executeTmux(`set-hook -w -t '${windowId}' pane-focus-in "run-shell '${PANE_COLOR_SCRIPT} #{pane_id}'"`);
    }
  } catch {
    /* best-effort — don't break spawn if tmux styling fails */
  }
}

/**
 * Rehydrate the pane-focus-in color hook on a window.
 * Called when a team window is resolved (created or found) to survive tmux restarts.
 * Only installs the hook if pane-colors.json exists and has entries for panes in this window.
 */
async function rehydratePaneColorHook(windowId: string): Promise<void> {
  const { existsSync } = require('node:fs');
  try {
    if (!existsSync(PANE_COLORS_PATH) || !existsSync(PANE_COLOR_SCRIPT)) return;
    ensurePaneColorScript();
    await executeTmux(`set-hook -w -t '${windowId}' pane-focus-in "run-shell '${PANE_COLOR_SCRIPT} #{pane_id}'"`);
  } catch {
    /* best-effort */
  }
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
