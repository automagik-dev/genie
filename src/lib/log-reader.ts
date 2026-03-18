import * as tmux from './tmux.js';

export interface ReadOptions {
  lines?: number; // Number of lines (default 100)
  from?: number; // Start line
  to?: number; // End line
  search?: string; // Search pattern
  grep?: string; // Regex pattern
  follow?: boolean; // Live tail mode
  all?: boolean; // Entire scrollback
  reverse?: boolean; // Newest first
  range?: string; // Range syntax like "100:200"
  pane?: string; // Target specific pane ID (e.g., %16)
}

/**
 * Strip internal TMUX_MCP markers from log output
 */
function isTmuxMarkerOrNoise(line: string): boolean {
  const trimmed = line.trim();

  // Marker lines and fragments
  if (trimmed.includes('TMUX_MCP_START') || trimmed.includes('TMUX_MCP_DONE_')) return true;
  if (line.includes('echo "TMUX_MCP_START"') || line.includes('echo "TMUX_MCP_DONE_')) return true;

  // Bash locale warnings and fragments
  if (line.includes('-bash:') || line.includes('warning: setlocale:') || line.includes('cannot change locale'))
    return true;
  if (trimmed === 'or directory') return true;

  return false;
}

function stripTmuxMarkers(content: string): string {
  const filtered = content.split('\n').filter((line) => !isTmuxMarkerOrNoise(line));

  // Remove leading/trailing empty lines
  while (filtered.length > 0 && filtered[0].trim() === '') {
    filtered.shift();
  }
  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === '') {
    filtered.pop();
  }

  return filtered.join('\n');
}

/**
 * Read logs from a tmux session with comprehensive filtering options
 */
async function resolveActivePaneId(sessionName: string, session: { id: string }): Promise<string> {
  const windows = await tmux.listWindows(session.id);
  if (!windows || windows.length === 0) {
    throw new Error(`No windows found in session "${sessionName}"`);
  }

  const activeWindow = windows.find((w) => w.active) || windows[0];
  const panes = await tmux.listPanes(activeWindow.id);
  if (!panes || panes.length === 0) {
    throw new Error(`No panes found in session "${sessionName}"`);
  }

  return (panes.find((p) => p.active) || panes[0]).id;
}

function maybeReverse(content: string, reverse?: boolean): string {
  return reverse ? content.split('\n').reverse().join('\n') : content;
}

function readRange(paneContent: string, from: number, to: number, reverse?: boolean): string {
  const lines = stripTmuxMarkers(paneContent).split('\n');
  return maybeReverse(lines.slice(from, to + 1).join('\n'), reverse);
}

function searchContent(paneContent: string, pattern: string, reverse?: boolean): string {
  const lines = stripTmuxMarkers(paneContent).split('\n');
  try {
    const regex = new RegExp(pattern, 'i');
    const matched = lines.filter((line) => regex.test(line));
    return maybeReverse(matched.join('\n'), reverse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regex pattern: ${message}`);
  }
}

export async function readSessionLogs(sessionName: string, options: ReadOptions = {}): Promise<string> {
  // When a pane ID is already resolved (e.g., from target-resolver), skip session lookup entirely.
  // The session lookup fails when session names don't match (e.g., folder-based "genie-pm" vs legacy "genie").
  const paneId = options.pane
    ? options.pane.startsWith('%')
      ? options.pane
      : `%${options.pane}`
    : await (async () => {
        const session = await tmux.findSessionByName(sessionName);
        if (!session) {
          throw new Error(`Session "${sessionName}" not found`);
        }
        return resolveActivePaneId(sessionName, session);
      })();

  // Parse range if provided
  if (options.range) {
    const parts = options.range.split(':');
    if (parts.length === 2) {
      options.from = Number.parseInt(parts[0], 10);
      options.to = Number.parseInt(parts[1], 10);
    }
  }

  if (options.all) {
    return stripTmuxMarkers(await tmux.capturePaneContent(paneId, 10000));
  }

  if (options.from !== undefined && options.to !== undefined) {
    return readRange(await tmux.capturePaneContent(paneId, 10000), options.from, options.to, options.reverse);
  }

  if (options.search || options.grep) {
    const pattern = options.search ?? options.grep ?? '';
    return searchContent(await tmux.capturePaneContent(paneId, 10000), pattern, options.reverse);
  }

  // Default: last N lines
  const content = stripTmuxMarkers(await tmux.capturePaneContent(paneId, options.lines || 100));
  return maybeReverse(content, options.reverse);
}

/**
 * Follow a session's logs in real-time (like tail -f)
 * Returns a function to stop following
 */
export async function followSessionLogs(
  sessionName: string,
  callback: (line: string) => void,
  options: { pane?: string } = {},
): Promise<() => void> {
  let paneId: string;

  if (options.pane) {
    paneId = options.pane.startsWith('%') ? options.pane : `%${options.pane}`;
  } else {
    const session = await tmux.findSessionByName(sessionName);
    if (!session) {
      throw new Error(`Session "${sessionName}" not found`);
    }

    const windows = await tmux.listWindows(session.id);
    if (!windows || windows.length === 0) {
      throw new Error(`No windows found in session "${sessionName}"`);
    }

    const activeWindow = windows.find((w) => w.active) || windows[0];

    const panes = await tmux.listPanes(activeWindow.id);
    if (!panes || panes.length === 0) {
      throw new Error(`No panes found in session "${sessionName}"`);
    }

    const activePane = panes.find((p) => p.active) || panes[0];
    paneId = activePane.id;
  }
  let lastContent = '';
  let following = true;

  function emitNewLines(oldContent: string, newContent: string): void {
    const newLines = newContent.split('\n');
    const oldLines = oldContent.split('\n');
    const startIndex = oldLines.length > 0 ? oldLines.length - 1 : 0;
    const lastOldLine = oldLines[oldLines.length - 1];
    for (const line of newLines.slice(startIndex)) {
      if (line && line !== lastOldLine) callback(line);
    }
  }

  // Poll for new content every 500ms
  const pollInterval = setInterval(async () => {
    if (!following) {
      clearInterval(pollInterval);
      return;
    }

    try {
      const content = stripTmuxMarkers(await tmux.capturePaneContent(paneId, 100));
      if (content !== lastContent) {
        emitNewLines(lastContent, content);
        lastContent = content;
      }
    } catch {
      clearInterval(pollInterval);
      following = false;
    }
  }, 500);

  // Return stop function
  return () => {
    following = false;
    clearInterval(pollInterval);
  };
}
