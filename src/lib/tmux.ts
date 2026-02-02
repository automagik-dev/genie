import { v4 as uuidv4 } from 'uuid';
import { executeTmux as wrapperExecuteTmux } from './tmux-wrapper.js';

// Basic interfaces for tmux objects
export interface TmuxSession {
  id: string;
  name: string;
  attached: boolean;
  windows: number;
}

export interface TmuxWindow {
  id: string;
  name: string;
  active: boolean;
  sessionId: string;
}

export interface TmuxPane {
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

export type ShellType = 'bash' | 'zsh' | 'fish';

let shellConfig: { type: ShellType } = { type: 'bash' };

export function setShellConfig(config: { type: string }): void {
  // Validate shell type
  const validShells: ShellType[] = ['bash', 'zsh', 'fish'];

  if (validShells.includes(config.type as ShellType)) {
    shellConfig = { type: config.type as ShellType };
  } else {
    shellConfig = { type: 'bash' };
  }
}

/**
 * Execute a tmux command and return the result
 */
export async function executeTmux(tmuxCommand: string): Promise<string> {
  try {
    return await wrapperExecuteTmux(tmuxCommand);
  } catch (error: any) {
    throw new Error(`Failed to execute tmux command: ${error.message}`);
  }
}

/**
 * Check if tmux server is running
 */
export async function isTmuxRunning(): Promise<boolean> {
  try {
    await executeTmux("list-sessions -F '#{session_name}'");
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * List all tmux sessions
 */
export async function listSessions(): Promise<TmuxSession[]> {
  try {
    const format = "#{session_id}:#{session_name}:#{?session_attached,1,0}:#{session_windows}";
    const output = await executeTmux(`list-sessions -F '${format}'`);

    if (!output) return [];

    return output.split('\n').map(line => {
      const [id, name, attached, windows] = line.split(':');
      return {
        id,
        name,
        attached: attached === '1',
        windows: parseInt(windows, 10)
      };
    });
  } catch (error: any) {
    // Handle "no server running" gracefully
    if (error.message.includes('no server running')) {
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
    return sessions.find(session => session.name === name) || null;
  } catch (error) {
    return null;
  }
}

/**
 * List windows in a session
 */
export async function listWindows(sessionId: string): Promise<TmuxWindow[]> {
  try {
    const format = "#{window_id}:#{window_name}:#{?window_active,1,0}";
    const output = await executeTmux(`list-windows -t '${sessionId}' -F '${format}'`);

    if (!output) return [];

    return output.split('\n').map(line => {
      const [id, name, active] = line.split(':');
      return {
        id,
        name,
        active: active === '1',
        sessionId
      };
    });
  } catch (error: any) {
    // Handle session not found or no server running
    if (error.message.includes('no server running') || error.message.includes('session not found')) {
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
    const format = "#{pane_id}:#{pane_title}:#{?pane_active,1,0}";
    const output = await executeTmux(`list-panes -t '${windowId}' -F '${format}'`);

    if (!output) return [];

    return output.split('\n').map(line => {
      const [id, title, active] = line.split(':');
      return {
        id,
        windowId,
        title: title,
        active: active === '1'
      };
    });
  } catch (error: any) {
    // Handle window not found or no server running
    if (error.message.includes('no server running') || error.message.includes('window not found')) {
      return [];
    }
    throw error;
  }
}

/**
 * Capture content from a specific pane, by default the latest 200 lines.
 */
export async function capturePaneContent(paneId: string, lines: number = 200, includeColors: boolean = false): Promise<string> {
  try {
    const colorFlag = includeColors ? '-e' : '';
    return await executeTmux(`capture-pane -p ${colorFlag} -t '${paneId}' -S -${lines} -E -`);
  } catch (error: any) {
    // Handle pane not found or no server running
    if (error.message.includes('no server running') || error.message.includes('pane not found')) {
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
export async function createWindow(sessionId: string, name: string): Promise<TmuxWindow | null> {
  const output = await executeTmux(`new-window -t '${sessionId}' -n '${name}'`);
  const windows = await listWindows(sessionId);
  return windows.find(window => window.name === name) || null;
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
 * Kill a tmux pane by ID
 */
export async function killPane(paneId: string): Promise<void> {
  await executeTmux(`kill-pane -t '${paneId}'`);
}

/**
 * Escape a string for safe use in shell single quotes.
 * Replaces ' with '\'' (end quote, escaped quote, start quote).
 */
function escapeShellPath(path: string): string {
  return path.replace(/'/g, "'\\''");
}

/**
 * Split a tmux pane horizontally or vertically
 */
export async function splitPane(
  targetPaneId: string,
  direction: 'horizontal' | 'vertical' = 'vertical',
  size?: number,
  workingDir?: string
): Promise<TmuxPane | null> {
  // Build the split-window command
  let splitCommand = 'split-window';

  // Add direction flag (-h for horizontal, -v for vertical)
  if (direction === 'horizontal') {
    splitCommand += ' -h';
  } else {
    splitCommand += ' -v';
  }

  // Add target pane
  splitCommand += ` -t '${targetPaneId}'`;

  // Add size if specified (as percentage)
  if (size !== undefined && size > 0 && size < 100) {
    splitCommand += ` -p ${size}`;
  }

  // Add working directory if specified
  if (workingDir) {
    splitCommand += ` -c '${escapeShellPath(workingDir)}'`;
  }

  // Add -P flag to print new pane info, with format to get pane ID
  splitCommand += ` -P -F '#{pane_id}'`;

  // Execute the split command - returns the new pane ID
  const newPaneId = (await executeTmux(splitCommand)).trim();

  // Get the window ID for the new pane
  const windowId = await executeTmux(`display-message -p -t '${newPaneId}' '#{window_id}'`);

  return {
    id: newPaneId,
    windowId: windowId.trim(),
    active: false,
    title: ''
  };
}

// Map to track ongoing command executions
const activeCommands = new Map<string, CommandExecution>();

const startMarkerText = 'TMUX_MCP_START';
const endMarkerPrefix = "TMUX_MCP_DONE_";

// Execute a command in a tmux pane and track its execution
export async function executeCommand(paneId: string, command: string, rawMode?: boolean, noEnter?: boolean): Promise<string> {
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
    rawMode: rawMode || noEnter
  });

  // Send the command to the tmux pane
  if (noEnter) {
    // Check if this is a special key (e.g., Up, Down, Left, Right, Escape, Tab, etc.)
    // Special keys in tmux are typically capitalized or have special names
    const specialKeys = ['Up', 'Down', 'Left', 'Right', 'Escape', 'Tab', 'Enter', 'Space',
      'BSpace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
      'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];

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

export async function checkCommandStatus(commandId: string): Promise<CommandExecution | null> {
  const command = activeCommands.get(commandId);
  if (!command) return null;

  if (command.status !== 'pending') return command;

  const content = await capturePaneContent(command.paneId, 1000);

  if (command.rawMode) {
    command.result = 'Status tracking unavailable for rawMode commands. Use capture-pane to monitor interactive apps instead.';
    return command;
  }

  // Find the last occurrence of the markers
  const startIndex = content.lastIndexOf(startMarkerText);
  const endIndex = content.lastIndexOf(endMarkerPrefix);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    command.result = "Command output could not be captured properly";
    return command;
  }

  // Extract exit code from the end marker line
  const endLine = content.substring(endIndex).split('\n')[0];
  const endMarkerRegex = new RegExp(`${endMarkerPrefix}(\\d+)`);
  const exitCodeMatch = endLine.match(endMarkerRegex);

  if (exitCodeMatch) {
    const exitCode = parseInt(exitCodeMatch[1], 10);

    command.status = exitCode === 0 ? 'completed' : 'error';
    command.exitCode = exitCode;

    // Extract output between the start and end markers
    const outputStart = startIndex + startMarkerText.length;
    const outputContent = content.substring(outputStart, endIndex).trim();

    command.result = outputContent.substring(outputContent.indexOf('\n') + 1).trim();

    // Update in map
    activeCommands.set(commandId, command);
  }

  return command;
}

// Get command by ID
export function getCommand(commandId: string): CommandExecution | null {
  return activeCommands.get(commandId) || null;
}

// Get all active command IDs
export function getActiveCommandIds(): string[] {
  return Array.from(activeCommands.keys());
}

// Clean up completed commands older than a certain time
export function cleanupOldCommands(maxAgeMinutes: number = 60): void {
  const now = new Date();

  for (const [id, command] of activeCommands.entries()) {
    const ageMinutes = (now.getTime() - command.startTime.getTime()) / (1000 * 60);

    if (command.status !== 'pending' && ageMinutes > maxAgeMinutes) {
      activeCommands.delete(id);
    }
  }
}

function getEndMarkerText(): string {
  return shellConfig.type === 'fish'
    ? `${endMarkerPrefix}$status`
    : `${endMarkerPrefix}$?`;
}

/**
 * Get the current session ID when running inside tmux
 */
export async function getCurrentSessionId(): Promise<string> {
  return await executeTmux(`display-message -p '#{session_id}'`);
}

/**
 * Rename a window
 */
export async function renameWindow(windowId: string, newName: string): Promise<void> {
  await executeTmux(`rename-window -t '${windowId}' '${newName}'`);
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
  timeoutMs: number = 120000
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
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Command timed out')), timeoutMs)
      ),
    ]);
  } catch (error: any) {
    if (error.message === 'Command timed out') {
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
    const { readFile, unlink } = await import('fs/promises');

    output = await readFile(outFile, 'utf-8');
    // Clean up output
    output = output.trim();

    const exitStr = await readFile(exitFile, 'utf-8');
    exitCode = parseInt(exitStr.trim(), 10) || 0;

    // Clean up temp files
    await unlink(outFile).catch(() => {});
    await unlink(exitFile).catch(() => {});
  } catch (err) {
    // If files don't exist, command may have failed to start
    console.error('Failed to read command output:', err);
  }

  return { output, exitCode };
}

