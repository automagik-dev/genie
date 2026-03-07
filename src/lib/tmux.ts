import { v4 as uuidv4 } from 'uuid';
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

interface CommandExecution {
  id: string;
  paneId: string;
  command: string;
  status: 'pending' | 'completed' | 'error';
  startTime: Date;
  result?: string;
  exitCode?: number;
  rawMode?: boolean;
}

type ShellType = 'bash' | 'zsh' | 'fish';

const shellConfig: { type: ShellType } = { type: 'bash' };

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
    const panes = await listPanes(existing.id);
    const paneId = panes.length > 0 ? panes[0].id : `${session}:${teamName}.0`;
    return { windowId: existing.id, windowName: teamName, paneId, created: false };
  }

  const newWindow = await createWindow(session, teamName, workingDir);
  if (!newWindow) {
    throw new Error(`Failed to create team window "${teamName}" in session "${session}"`);
  }

  const panes = await listPanes(newWindow.id);
  const paneId = panes.length > 0 ? panes[0].id : `${session}:${teamName}.0`;
  return { windowId: newWindow.id, windowName: teamName, paneId, created: true };
}

/**
 * Kill a tmux session by ID
 */
export async function killSession(sessionId: string): Promise<void> {
  await executeTmux(`kill-session -t '${sessionId}'`);
}

/**
 * Kill a tmux window by ID
 */
export async function killWindow(windowId: string): Promise<void> {
  await executeTmux(`kill-window -t '${windowId}'`);
}

/**
 * Kill a tmux window using session-qualified targeting.
 * Uses `sessionId:windowId` format to avoid ambiguity across sessions.
 */
export async function killWindowQualified(sessionId: string, windowId: string): Promise<void> {
  await executeTmux(`kill-window -t '${sessionId}:${windowId}'`);
}

/**
 * Kill a tmux pane by ID
 */
export async function killPane(paneId: string): Promise<void> {
  await executeTmux(`kill-pane -t '${paneId}'`);
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

// Map to track ongoing command executions
const activeCommands = new Map<string, CommandExecution>();

const startMarkerText = 'TMUX_MCP_START';
const endMarkerPrefix = 'TMUX_MCP_DONE_';

// Execute a command in a tmux pane and track its execution
export async function executeCommand(
  paneId: string,
  command: string,
  rawMode?: boolean,
  noEnter?: boolean,
): Promise<string> {
  // Generate unique ID for this command execution
  const commandId = uuidv4();

  let fullCommand: string;
  if (rawMode || noEnter) {
    fullCommand = command;
  } else {
    const endMarkerText = getEndMarkerText();
    fullCommand = `echo "${startMarkerText}"; ${command}; echo "${endMarkerText}"`;
  }

  // Store command in tracking map
  activeCommands.set(commandId, {
    id: commandId,
    paneId,
    command,
    status: 'pending',
    startTime: new Date(),
    rawMode: rawMode || noEnter,
  });

  // Send the command to the tmux pane
  if (noEnter) {
    // Check if this is a special key (e.g., Up, Down, Left, Right, Escape, Tab, etc.)
    // Special keys in tmux are typically capitalized or have special names
    const specialKeys = [
      'Up',
      'Down',
      'Left',
      'Right',
      'Escape',
      'Tab',
      'Enter',
      'Space',
      'BSpace',
      'Delete',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'F1',
      'F2',
      'F3',
      'F4',
      'F5',
      'F6',
      'F7',
      'F8',
      'F9',
      'F10',
      'F11',
      'F12',
    ];

    if (specialKeys.includes(fullCommand)) {
      // Send special key as-is
      await executeTmux(`send-keys -t '${paneId}' ${fullCommand}`);
    } else {
      // For regular text, send each character individually to ensure proper processing
      // This handles both single characters (like 'q', 'f') and strings (like 'beam')
      for (const char of fullCommand) {
        await executeTmux(`send-keys -t '${paneId}' '${char.replace(/'/g, "'\\''")}'`);
      }
    }
  } else {
    await executeTmux(`send-keys -t '${paneId}' '${fullCommand.replace(/'/g, "'\\''")}' Enter`);
  }

  return commandId;
}

function getEndMarkerText(): string {
  return shellConfig.type === 'fish' ? `${endMarkerPrefix}$status` : `${endMarkerPrefix}$?`;
}

/**
 * Run a command synchronously in a tmux pane using wait-for.
 *
 * Uses tmux wait-for for proper synchronization (no polling).
 * Output is captured via tee so it's visible in the pane AND returned.
 *
 * @returns {output: string, exitCode: number}
 */
export async function runCommandSync(
  paneId: string,
  command: string,
  timeoutMs = 120000,
): Promise<{ output: string; exitCode: number }> {
  const id = uuidv4().substring(0, 8);
  const outFile = `/tmp/genie-${id}.out`;
  const exitFile = `/tmp/genie-${id}.exit`;
  const channel = `genie-${id}`;

  // Escape single quotes in command for shell embedding
  const escapedCommand = command.replace(/'/g, "'\\''");

  // Wrap command using tee for output capture:
  // - Run command, pipe through tee (visible in terminal AND saved to file)
  // - Capture exit code via PIPESTATUS
  // - Signal completion via wait-for
  const fullCommand = `{ ${escapedCommand}; } 2>&1 | tee ${outFile}; echo \${PIPESTATUS[0]} > ${exitFile}; tmux wait-for -S ${channel}`;

  // Send command to pane
  await executeTmux(`send-keys -t '${paneId}' '${fullCommand.replace(/'/g, "'\\''")}' Enter`);

  // Wait for completion (blocks until signaled, with timeout)
  try {
    await Promise.race([
      executeTmux(`wait-for ${channel}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Command timed out')), timeoutMs)),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'Command timed out') {
      // Clean up on timeout
      try {
        await executeTmux(`wait-for -S ${channel}`); // Unblock any waiters
      } catch {}
      return { output: '', exitCode: 124 };
    }
    throw error;
  }

  // Read output and exit code from files
  let output = '';
  let exitCode = 0;

  try {
    const { readFile, unlink } = await import('node:fs/promises');

    output = await readFile(outFile, 'utf-8');
    // Clean up output
    output = output.trim();

    const exitStr = await readFile(exitFile, 'utf-8');
    exitCode = Number.parseInt(exitStr.trim(), 10) || 0;

    // Clean up temp files
    await unlink(outFile).catch(() => {});
    await unlink(exitFile).catch(() => {});
  } catch (err) {
    // If files don't exist, command may have failed to start
    console.error('Failed to read command output:', err);
  }

  return { output, exitCode };
}
