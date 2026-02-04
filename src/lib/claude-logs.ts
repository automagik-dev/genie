/**
 * Claude Code Log Discovery and Parsing
 *
 * Provides utilities for finding and reading Claude Code session logs.
 *
 * Log Location:
 * - Claude Code stores logs in ~/.claude/projects/<project-hash>/
 * - Project hash is the workspace path with slashes replaced by dashes
 *   e.g., /home/genie/workspace/guga -> -home-genie-workspace-guga
 * - Session logs are JSONL files named <session-uuid>.jsonl
 * - A sessions-index.json file lists all sessions for a project
 *
 * Log Entry Types:
 * - user: User messages
 * - assistant: Claude responses (may include tool_use content)
 * - progress: Progress updates, tool results, hook events
 * - system: System messages
 * - file-history-snapshot: File tracking snapshots
 * - queue-operation: Message queue operations
 *
 * Tool Call Format (in assistant messages):
 * message.content[] contains objects with type "tool_use":
 * { type: "tool_use", id: "toolu_xxx", name: "Read", input: { file_path: "..." } }
 */

import { join } from 'path';
import { readdir, readFile, access, stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

// ============================================================================
// Types
// ============================================================================

/**
 * Tool call extracted from assistant message
 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Parsed log entry with normalized fields
 */
export interface ClaudeLogEntry {
  type: 'user' | 'assistant' | 'progress' | 'system' | 'file-history-snapshot' | 'queue-operation' | string;
  sessionId: string;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  cwd: string;
  gitBranch?: string;
  version?: string;

  // For user/assistant messages
  message?: {
    role: string;
    content: unknown;
  };

  // For assistant messages with tool calls
  toolCalls?: ToolCall[];
  model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };

  // For progress events
  data?: Record<string, unknown>;

  // Raw entry for access to all fields
  raw: Record<string, unknown>;
}

/**
 * Session metadata from sessions-index.json
 */
export interface ClaudeSession {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt?: string;
  summary?: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch?: string;
  projectPath: string;
  isSidechain: boolean;
}

/**
 * Sessions index file structure
 */
interface SessionsIndex {
  version: number;
  entries: ClaudeSession[];
  originalPath: string;
}

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Convert a project path to Claude's hash format.
 * Claude replaces slashes with dashes, e.g.:
 * /home/genie/workspace/guga -> -home-genie-workspace-guga
 */
export function projectPathToHash(projectPath: string): string {
  // Normalize path: remove trailing slash, handle root
  let normalized = projectPath.replace(/\/+$/, '');
  if (!normalized) normalized = '/';

  // Replace slashes with dashes
  return normalized.replace(/\//g, '-');
}

/**
 * Get the default Claude directory path
 */
export function getClaudeDir(): string {
  return join(process.env.HOME || '', '.claude');
}

/**
 * Get the projects directory path
 */
export function getProjectsDir(claudeDir?: string): string {
  return join(claudeDir || getClaudeDir(), 'projects');
}

// ============================================================================
// Project Discovery
// ============================================================================

/**
 * Find the Claude project directory for a given workspace path.
 *
 * @param projectPath - The absolute path to the workspace
 * @param claudeDir - Optional custom Claude directory (defaults to ~/.claude)
 * @returns The project directory path, or null if not found
 */
export async function findClaudeProjectDir(
  projectPath: string,
  claudeDir?: string
): Promise<string | null> {
  const projectsDir = getProjectsDir(claudeDir);
  const expectedHash = projectPathToHash(projectPath);

  try {
    await access(projectsDir);
    const projectDir = join(projectsDir, expectedHash);
    await access(projectDir);
    return projectDir;
  } catch {
    return null;
  }
}

/**
 * List all Claude project directories
 */
export async function listClaudeProjects(claudeDir?: string): Promise<string[]> {
  const projectsDir = getProjectsDir(claudeDir);

  try {
    const entries = await readdir(projectsDir);
    const projects: string[] = [];

    for (const entry of entries) {
      const projectPath = join(projectsDir, entry);
      const stats = await stat(projectPath);
      if (stats.isDirectory()) {
        projects.push(projectPath);
      }
    }

    return projects;
  } catch {
    return [];
  }
}

// ============================================================================
// Session Discovery
// ============================================================================

/**
 * List all sessions for a project directory.
 * Reads from sessions-index.json if available, otherwise scans for .jsonl files.
 */
export async function listSessions(projectDir: string): Promise<ClaudeSession[]> {
  const indexPath = join(projectDir, 'sessions-index.json');

  try {
    const content = await readFile(indexPath, 'utf-8');
    const index: SessionsIndex = JSON.parse(content);
    return index.entries;
  } catch {
    // Fallback: scan for .jsonl files
    return await scanForSessions(projectDir);
  }
}

/**
 * Scan a project directory for session log files.
 * Used as fallback when sessions-index.json is not available.
 */
async function scanForSessions(projectDir: string): Promise<ClaudeSession[]> {
  const sessions: ClaudeSession[] = [];

  try {
    const entries = await readdir(projectDir);

    for (const entry of entries) {
      if (entry.endsWith('.jsonl') && !entry.startsWith('.')) {
        const filePath = join(projectDir, entry);
        const stats = await stat(filePath);

        // Session ID is the filename without extension
        const sessionId = entry.replace('.jsonl', '');

        sessions.push({
          sessionId,
          fullPath: filePath,
          fileMtime: stats.mtimeMs,
          messageCount: 0, // Unknown without parsing
          created: stats.birthtime.toISOString(),
          modified: stats.mtime.toISOString(),
          projectPath: '', // Unknown without parsing
          isSidechain: false,
        });
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return sessions;
}

/**
 * Find the most recently modified session in a project directory.
 */
export async function findActiveSession(projectDir: string): Promise<ClaudeSession | null> {
  const sessions = await listSessions(projectDir);

  if (sessions.length === 0) {
    return null;
  }

  // Sort by modified time, most recent first
  sessions.sort((a, b) => {
    const timeA = new Date(a.modified).getTime();
    const timeB = new Date(b.modified).getTime();
    return timeB - timeA;
  });

  return sessions[0];
}

/**
 * Get the log file path for a session
 */
export function getSessionLogPath(projectDir: string, sessionId: string): string {
  return join(projectDir, `${sessionId}.jsonl`);
}

// ============================================================================
// Log Entry Parsing
// ============================================================================

/**
 * Parse a single log entry from a JSONL line.
 *
 * @param line - A single line from a .jsonl log file
 * @returns Parsed log entry, or null if invalid
 */
export function parseLogEntry(line: string): ClaudeLogEntry | null {
  if (!line || !line.trim()) {
    return null;
  }

  try {
    const raw = JSON.parse(line);

    // Basic validation - must have type
    if (!raw.type) {
      return null;
    }

    const entry: ClaudeLogEntry = {
      type: raw.type,
      sessionId: raw.sessionId || '',
      uuid: raw.uuid || '',
      parentUuid: raw.parentUuid || null,
      timestamp: raw.timestamp || '',
      cwd: raw.cwd || '',
      gitBranch: raw.gitBranch,
      version: raw.version,
      raw,
    };

    // Handle message content
    if (raw.message) {
      entry.message = {
        role: raw.message.role,
        content: raw.message.content,
      };

      // Extract tool calls from assistant messages
      if (raw.type === 'assistant' && Array.isArray(raw.message.content)) {
        const toolCalls: ToolCall[] = [];

        for (const item of raw.message.content) {
          if (item.type === 'tool_use') {
            toolCalls.push({
              id: item.id || '',
              name: item.name || '',
              input: item.input || {},
            });
          }
        }

        if (toolCalls.length > 0) {
          entry.toolCalls = toolCalls;
        }
      }

      // Extract model and usage from assistant messages
      if (raw.type === 'assistant' && raw.message.model) {
        entry.model = raw.message.model;
        if (raw.message.usage) {
          entry.usage = raw.message.usage;
        }
      }
    }

    // Handle progress data
    if (raw.data) {
      entry.data = raw.data;
    }

    return entry;
  } catch {
    return null;
  }
}

/**
 * Read all entries from a log file.
 *
 * @param logPath - Path to the .jsonl log file
 * @returns Array of parsed log entries
 */
export async function readLogFile(logPath: string): Promise<ClaudeLogEntry[]> {
  const entries: ClaudeLogEntry[] = [];

  try {
    const content = await readFile(logPath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const entry = parseLogEntry(line);
      if (entry) {
        entries.push(entry);
      }
    }
  } catch {
    // File doesn't exist or can't be read
  }

  return entries;
}

/**
 * Read the last N entries from a log file (most recent).
 * More efficient than reading the entire file.
 *
 * @param logPath - Path to the .jsonl log file
 * @param count - Number of entries to read from the end
 * @returns Array of parsed log entries (most recent last)
 */
export async function readLastEntries(logPath: string, count: number): Promise<ClaudeLogEntry[]> {
  const entries: ClaudeLogEntry[] = [];

  try {
    const content = await readFile(logPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    // Get last N lines
    const startIndex = Math.max(0, lines.length - count);
    const lastLines = lines.slice(startIndex);

    for (const line of lastLines) {
      const entry = parseLogEntry(line);
      if (entry) {
        entries.push(entry);
      }
    }
  } catch {
    // File doesn't exist or can't be read
  }

  return entries;
}

// ============================================================================
// Streaming / Tailing
// ============================================================================

/**
 * Tail a log file and emit new entries as they're written.
 * Returns a cleanup function to stop tailing.
 *
 * @param logPath - Path to the .jsonl log file
 * @param onEntry - Callback for each new entry
 * @param pollIntervalMs - How often to check for new content (default 500ms)
 * @returns Cleanup function to stop tailing
 */
export async function tailLogFile(
  logPath: string,
  onEntry: (entry: ClaudeLogEntry) => void,
  pollIntervalMs: number = 500
): Promise<() => void> {
  let lastSize = 0;
  let running = true;
  let pendingBuffer = '';

  try {
    const stats = await stat(logPath);
    lastSize = stats.size;
  } catch {
    // File doesn't exist yet, start from 0
  }

  const poll = async () => {
    if (!running) return;

    try {
      const stats = await stat(logPath);
      const currentSize = stats.size;

      if (currentSize > lastSize) {
        // Read new content
        const { createReadStream } = await import('fs');
        const { promisify } = await import('util');

        // Create a read stream starting from last position
        const stream = createReadStream(logPath, {
          start: lastSize,
          encoding: 'utf-8',
        });

        let newContent = '';
        for await (const chunk of stream) {
          newContent += chunk;
        }

        // Process new content line by line
        const content = pendingBuffer + newContent;
        const lines = content.split('\n');

        // Last element might be incomplete, save it for next poll
        pendingBuffer = lines.pop() || '';

        for (const line of lines) {
          const entry = parseLogEntry(line);
          if (entry) {
            onEntry(entry);
          }
        }

        lastSize = currentSize;
      }
    } catch (error) {
      // File might have been deleted or rotated
      // Just continue polling
    }

    if (running) {
      setTimeout(poll, pollIntervalMs);
    }
  };

  // Start polling
  poll();

  // Return cleanup function
  return () => {
    running = false;
  };
}

// ============================================================================
// High-Level Discovery Functions
// ============================================================================

/**
 * Find logs for a workspace path.
 * Returns the project directory and active session if found.
 */
export async function findLogsForWorkspace(
  workspacePath: string,
  claudeDir?: string
): Promise<{ projectDir: string; session: ClaudeSession } | null> {
  const projectDir = await findClaudeProjectDir(workspacePath, claudeDir);

  if (!projectDir) {
    return null;
  }

  const session = await findActiveSession(projectDir);

  if (!session) {
    return null;
  }

  return { projectDir, session };
}

/**
 * Get the log file for a pane's working directory.
 * This is the main entry point for orchestration.
 *
 * @param paneWorkdir - The working directory of the tmux pane
 * @param claudeDir - Optional custom Claude directory
 * @returns Log file path and session info, or null if not found
 */
export async function getLogsForPane(
  paneWorkdir: string,
  claudeDir?: string
): Promise<{ logPath: string; session: ClaudeSession; projectDir: string } | null> {
  const result = await findLogsForWorkspace(paneWorkdir, claudeDir);

  if (!result) {
    return null;
  }

  return {
    logPath: result.session.fullPath,
    session: result.session,
    projectDir: result.projectDir,
  };
}
