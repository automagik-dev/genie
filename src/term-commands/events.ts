/**
 * Events command - Stream Claude Code events from a pane
 *
 * Usage:
 *   genie agent events <pane-id>           - Show recent events from an agent
 *   genie agent events <pane-id> --follow  - Tail events in real-time (like tail -f)
 *   genie agent events <pane-id> --emit    - Tail and write to .genie/events/<pane-id>.jsonl
 *   genie agent events <pane-id> --json    - Output events as JSON
 *   genie agent events --all               - Aggregate events from all active agents
 *   genie agent events --all --json        - Aggregate events as JSON
 *
 * Events are normalized into a standard format:
 *   - session_start: Claude session started
 *   - tool_call: Tool invocation (Read, Write, Bash, etc.)
 *   - permission_request: Waiting for user approval
 *   - session_end: Session completed or terminated
 *
 * Event Files:
 *   Events can be written to .genie/events/<pane-id>.jsonl for orchestrator consumption.
 *   Use --emit flag to enable this while tailing.
 */

import { appendFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClaudeLogEntry } from '../lib/claude-logs.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Normalized event format for orchestration
 */
export interface NormalizedEvent {
  /** Event type */
  type: 'session_start' | 'tool_call' | 'permission_request' | 'session_end';
  /** ISO timestamp */
  timestamp: string;
  /** Claude session ID */
  sessionId: string;
  /** Working directory */
  cwd: string;
  /** Git branch if available */
  gitBranch?: string;

  // Worker context (enriched from workers.json)
  /** tmux pane ID */
  paneId?: string;
  /** Wish slug (e.g., "wish-21") */
  wishId?: string;
  /** Task ID */
  taskId?: string;

  // Tool call specific fields
  /** Tool name (Read, Write, Bash, etc.) */
  toolName?: string;
  /** Tool input parameters */
  toolInput?: Record<string, unknown>;
  /** Tool call ID for correlation */
  toolCallId?: string;

  // Session end specific fields
  /** Exit reason if session ended */
  exitReason?: string;
}

/**
 * Worker context for event enrichment
 */
interface WorkerContext {
  paneId: string;
  wishSlug?: string;
  taskId?: string;
}

// ============================================================================
// Event File Operations
// ============================================================================

/**
 * Get the .genie directory path for the current working directory.
 * Falls back to .genie in the current directory.
 */
function getGenieDir(baseDir?: string): string {
  return baseDir || join(process.cwd(), '.genie');
}

/**
 * Get the events directory path.
 * Events are stored in .genie/events/
 */
export function getEventsDir(genieDir?: string): string {
  return join(getGenieDir(genieDir), 'events');
}

/**
 * Normalize pane ID to always include the % prefix.
 */
function normalizePaneId(paneId: string): string {
  return paneId.startsWith('%') ? paneId : `%${paneId}`;
}

/**
 * Get the event file path for a specific pane.
 * Event files are named <pane-id>.jsonl (e.g., %42.jsonl)
 */
export function getEventFilePath(paneId: string, genieDir?: string): string {
  const normalizedPaneId = normalizePaneId(paneId);
  return join(getEventsDir(genieDir), `${normalizedPaneId}.jsonl`);
}

/**
 * Ensure the events directory exists.
 */
async function ensureEventsDir(genieDir?: string): Promise<void> {
  const eventsDir = getEventsDir(genieDir);
  await mkdir(eventsDir, { recursive: true });
}

/**
 * Write an event to a pane's event file (append-only).
 * Creates the events directory and file if they don't exist.
 */
export async function writeEventToFile(event: NormalizedEvent, paneId: string, genieDir?: string): Promise<void> {
  await ensureEventsDir(genieDir);
  const filePath = getEventFilePath(paneId, genieDir);
  const line = `${JSON.stringify(event)}\n`;
  await appendFile(filePath, line, 'utf-8');
}

/**
 * Read all events from a pane's event file.
 * Returns empty array if file doesn't exist.
 */
export async function readEventsFromFile(paneId: string, genieDir?: string): Promise<NormalizedEvent[]> {
  const filePath = getEventFilePath(paneId, genieDir);
  const events: NormalizedEvent[] = [];

  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');

    for (const line of lines) {
      if (line.trim()) {
        try {
          events.push(JSON.parse(line) as NormalizedEvent);
        } catch {
          // Skip invalid JSON lines
        }
      }
    }
  } catch (err) {
    const errCode = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    // File doesn't exist or can't be read
    if (errCode !== 'ENOENT') {
      throw err;
    }
  }

  return events;
}

/**
 * Aggregate events from all pane event files.
 * Returns events sorted by timestamp (oldest first).
 */
function parseJsonlFile(content: string): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  for (const line of content.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as NormalizedEvent);
    } catch {
      // Skip invalid JSON lines
    }
  }
  return events;
}

export async function aggregateAllEvents(genieDir?: string): Promise<NormalizedEvent[]> {
  const eventsDir = getEventsDir(genieDir);
  const allEvents: NormalizedEvent[] = [];

  try {
    const files = await readdir(eventsDir);

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      try {
        const content = await readFile(join(eventsDir, file), 'utf-8');
        allEvents.push(...parseJsonlFile(content));
      } catch {
        // Skip files that can't be read
      }
    }
  } catch (err) {
    const errCode = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (errCode !== 'ENOENT') throw err;
  }

  allEvents.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return allEvents;
}

/**
 * Cleanup event file for a terminated worker.
 * Call this when a worker is removed from the registry.
 */
export async function cleanupEventFile(paneId: string, genieDir?: string): Promise<void> {
  const filePath = getEventFilePath(paneId, genieDir);

  try {
    await unlink(filePath);
  } catch (err) {
    const errCode = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    // Ignore if file doesn't exist
    if (errCode !== 'ENOENT') {
      throw err;
    }
  }
}

// ============================================================================
// Event Parsing
// ============================================================================

/**
 * Parse a Claude log entry into a normalized event.
 * Returns null if the entry doesn't represent a relevant event.
 */
function parseProgressEvent(entry: ClaudeLogEntry, base: Record<string, unknown>): NormalizedEvent | null {
  const data = entry.data as Record<string, unknown>;
  if (data.type === 'permission_request' || data.waitingForPermission) {
    return { ...base, type: 'permission_request', toolName: (data.toolName as string) || undefined } as NormalizedEvent;
  }
  if (data.type === 'session_end' || data.type === 'conversation_end') {
    return { ...base, type: 'session_end', exitReason: (data.reason as string) || 'completed' } as NormalizedEvent;
  }
  return null;
}

export function parseLogEntryToEvent(entry: ClaudeLogEntry, workerContext?: WorkerContext): NormalizedEvent | null {
  const base = {
    timestamp: entry.timestamp,
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    gitBranch: entry.gitBranch,
    paneId: workerContext?.paneId,
    wishId: workerContext?.wishSlug,
    taskId: workerContext?.taskId,
  };

  if (entry.type === 'user' && !entry.parentUuid) {
    return { ...base, type: 'session_start' };
  }

  if (entry.type === 'assistant' && entry.toolCalls && entry.toolCalls.length > 0) {
    const tool = entry.toolCalls[0];
    return { ...base, type: 'tool_call', toolName: tool.name, toolInput: tool.input, toolCallId: tool.id };
  }

  if (entry.type === 'progress' && entry.data) {
    return parseProgressEvent(entry, base);
  }

  return null;
}
