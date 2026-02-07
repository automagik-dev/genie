import * as tmux from './tmux.js';

export interface ReadOptions {
  lines?: number;           // Number of lines (default 100)
  from?: number;            // Start line
  to?: number;              // End line
  search?: string;          // Search pattern
  grep?: string;            // Regex pattern
  follow?: boolean;         // Live tail mode
  all?: boolean;            // Entire scrollback
  reverse?: boolean;        // Newest first
  range?: string;           // Range syntax like "100:200"
  pane?: string;            // Target specific pane ID (e.g., %16)
}

/**
 * Strip internal TMUX_MCP markers from log output
 */
function stripTmuxMarkers(content: string): string {
  const lines = content.split('\n');

  // First pass: mark lines to remove
  const filtered = lines.filter(line => {
    const trimmed = line.trim();

    // Remove complete marker lines
    if (trimmed.match(/^TMUX_MCP_START$/)) return false;
    if (trimmed.match(/^TMUX_MCP_DONE_\d+$/)) return false;

    // Remove partial marker fragments (from split echo commands)
    if (trimmed.includes('TMUX_MCP_START')) return false;
    if (trimmed.includes('TMUX_MCP_DONE_')) return false;

    // Remove lines containing echo commands for markers
    if (line.includes('echo "TMUX_MCP_START"')) return false;
    if (line.includes('echo "TMUX_MCP_DONE_')) return false;

    // Remove bash locale warnings and fragments
    if (line.includes('-bash:')) return false;
    if (line.includes('warning: setlocale:')) return false;
    if (line.includes('cannot change locale')) return false;
    if (trimmed === 'or directory') return false;  // Orphan fragment from wrapped warning

    return true;
  });

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
export async function readSessionLogs(
  sessionName: string,
  options: ReadOptions = {}
): Promise<string> {
  // Find session
  const session = await tmux.findSessionByName(sessionName);
  if (!session) {
    throw new Error(`Session "${sessionName}" not found`);
  }

  // Use specified pane or find active pane
  let paneId: string;

  if (options.pane) {
    paneId = options.pane.startsWith('%') ? options.pane : `%${options.pane}`;
  } else {
    const windows = await tmux.listWindows(session.id);
    if (!windows || windows.length === 0) {
      throw new Error(`No windows found in session "${sessionName}"`);
    }

    const activeWindow = windows.find(w => w.active) || windows[0];

    const panes = await tmux.listPanes(activeWindow.id);
    if (!panes || panes.length === 0) {
      throw new Error(`No panes found in session "${sessionName}"`);
    }

    const activePane = panes.find(p => p.active) || panes[0];
    paneId = activePane.id;
  }

  // Parse range if provided
  if (options.range) {
    const parts = options.range.split(':');
    if (parts.length === 2) {
      options.from = parseInt(parts[0], 10);
      options.to = parseInt(parts[1], 10);
    }
  }

  // Handle different read modes
  if (options.all) {
    // Get entire scrollback buffer (tmux history limit, usually 2000-10000 lines)
    const content = await tmux.capturePaneContent(paneId, 10000);
    return stripTmuxMarkers(content);
  }

  if (options.from !== undefined && options.to !== undefined) {
    // Read specific range
    const fullContent = await tmux.capturePaneContent(paneId, 10000);
    const cleanContent = stripTmuxMarkers(fullContent);
    const lines = cleanContent.split('\n');
    const rangeContent = lines.slice(options.from, options.to + 1).join('\n');

    if (options.reverse) {
      return rangeContent.split('\n').reverse().join('\n');
    }

    return rangeContent;
  }

  if (options.search || options.grep) {
    // Search logs
    const pattern = options.search || options.grep;
    const fullContent = await tmux.capturePaneContent(paneId, 10000);
    const cleanContent = stripTmuxMarkers(fullContent);
    const lines = cleanContent.split('\n');

    try {
      const regex = new RegExp(pattern, 'i');
      const matchedLines = lines.filter(line => regex.test(line));

      if (options.reverse) {
        return matchedLines.reverse().join('\n');
      }

      return matchedLines.join('\n');
    } catch (error: any) {
      throw new Error(`Invalid regex pattern: ${error.message}`);
    }
  }

  // Default: last N lines
  const lineCount = options.lines || 100;
  let content = await tmux.capturePaneContent(paneId, lineCount);
  content = stripTmuxMarkers(content);

  if (options.reverse) {
    // Newest first
    content = content.split('\n').reverse().join('\n');
  }

  return content;
}

/**
 * Follow a session's logs in real-time (like tail -f)
 * Returns a function to stop following
 */
export async function followSessionLogs(
  sessionName: string,
  callback: (line: string) => void,
  options: { pane?: string } = {}
): Promise<() => void> {
  const session = await tmux.findSessionByName(sessionName);
  if (!session) {
    throw new Error(`Session "${sessionName}" not found`);
  }

  let paneId: string;

  if (options.pane) {
    paneId = options.pane.startsWith('%') ? options.pane : `%${options.pane}`;
  } else {
    const windows = await tmux.listWindows(session.id);
    if (!windows || windows.length === 0) {
      throw new Error(`No windows found in session "${sessionName}"`);
    }

    const activeWindow = windows.find(w => w.active) || windows[0];

    const panes = await tmux.listPanes(activeWindow.id);
    if (!panes || panes.length === 0) {
      throw new Error(`No panes found in session "${sessionName}"`);
    }

    const activePane = panes.find(p => p.active) || panes[0];
    paneId = activePane.id;
  }
  let lastContent = '';
  let following = true;

  // Poll for new content every 500ms
  const pollInterval = setInterval(async () => {
    if (!following) {
      clearInterval(pollInterval);
      return;
    }

    try {
      const rawContent = await tmux.capturePaneContent(paneId, 100);
      const content = stripTmuxMarkers(rawContent);

      if (content !== lastContent) {
        const newLines = content.split('\n');
        const oldLines = lastContent.split('\n');

        // Find new lines by comparing arrays
        const startIndex = oldLines.length > 0 ? oldLines.length - 1 : 0;
        const addedLines = newLines.slice(startIndex);

        addedLines.forEach(line => {
          if (line && line !== oldLines[oldLines.length - 1]) {
            callback(line);
          }
        });

        lastContent = content;
      }
    } catch (error) {
      // Session might have been closed
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
