/**
 * Events command - Stream Claude Code events from a pane
 *
 * Usage:
 *   term events <pane-id>           - Show recent events from a worker
 *   term events <pane-id> --follow  - Tail events in real-time (like tail -f)
 *   term events <pane-id> --emit    - Tail and write to .genie/events/<pane-id>.jsonl
 *   term events <pane-id> --json    - Output events as JSON
 *   term events --all               - Aggregate events from all active workers
 *   term events --all --json        - Aggregate events as JSON
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

import {
  getLogsForPane,
  readLogFile,
  tailLogFile,
  parseLogEntry,
  type ClaudeLogEntry,
} from '../lib/claude-logs.js';
import * as registry from '../lib/worker-registry.js';
import * as tmux from '../lib/tmux.js';
import { mkdir, readFile, writeFile, appendFile, readdir, unlink, access } from 'fs/promises';
import { join } from 'path';

// ============================================================================
// Types
// ============================================================================

export interface EventsOptions {
  json?: boolean;
  follow?: boolean;
  lines?: number;
  /** Write events to .genie/events/<pane-id>.jsonl while tailing */
  emit?: boolean;
  /** Aggregate events from all active workers */
  all?: boolean;
}

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
  /** Task/beads ID (e.g., "bd-123") */
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
export interface WorkerContext {
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
export function getGenieDir(baseDir?: string): string {
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
export async function writeEventToFile(
  event: NormalizedEvent,
  paneId: string,
  genieDir?: string
): Promise<void> {
  await ensureEventsDir(genieDir);
  const filePath = getEventFilePath(paneId, genieDir);
  const line = JSON.stringify(event) + '\n';
  await appendFile(filePath, line, 'utf-8');
}

/**
 * Read all events from a pane's event file.
 * Returns empty array if file doesn't exist.
 */
export async function readEventsFromFile(
  paneId: string,
  genieDir?: string
): Promise<NormalizedEvent[]> {
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
  } catch (err: any) {
    // File doesn't exist or can't be read
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }

  return events;
}

/**
 * Aggregate events from all pane event files.
 * Returns events sorted by timestamp (oldest first).
 */
export async function aggregateAllEvents(genieDir?: string): Promise<NormalizedEvent[]> {
  const eventsDir = getEventsDir(genieDir);
  const allEvents: NormalizedEvent[] = [];

  try {
    const files = await readdir(eventsDir);

    for (const file of files) {
      if (file.endsWith('.jsonl')) {
        const filePath = join(eventsDir, file);
        try {
          const content = await readFile(filePath, 'utf-8');
          const lines = content.trim().split('\n');

          for (const line of lines) {
            if (line.trim()) {
              try {
                allEvents.push(JSON.parse(line) as NormalizedEvent);
              } catch {
                // Skip invalid JSON lines
              }
            }
          }
        } catch {
          // Skip files that can't be read
        }
      }
    }
  } catch (err: any) {
    // Events directory doesn't exist
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }

  // Sort by timestamp
  allEvents.sort((a, b) => {
    const timeA = new Date(a.timestamp).getTime();
    const timeB = new Date(b.timestamp).getTime();
    return timeA - timeB;
  });

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
  } catch (err: any) {
    // Ignore if file doesn't exist
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * List all pane IDs that have event files.
 */
export async function listEventFiles(genieDir?: string): Promise<string[]> {
  const eventsDir = getEventsDir(genieDir);
  const paneIds: string[] = [];

  try {
    const files = await readdir(eventsDir);

    for (const file of files) {
      if (file.endsWith('.jsonl')) {
        // Extract pane ID from filename (e.g., %42.jsonl -> %42)
        paneIds.push(file.replace('.jsonl', ''));
      }
    }
  } catch (err: any) {
    // Events directory doesn't exist
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }

  return paneIds;
}

// ============================================================================
// Event Parsing
// ============================================================================

/**
 * Parse a Claude log entry into a normalized event.
 * Returns null if the entry doesn't represent a relevant event.
 */
export function parseLogEntryToEvent(
  entry: ClaudeLogEntry,
  workerContext?: WorkerContext
): NormalizedEvent | null {
  const base = {
    timestamp: entry.timestamp,
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    gitBranch: entry.gitBranch,
    // Worker context enrichment
    paneId: workerContext?.paneId,
    wishId: workerContext?.wishSlug,
    taskId: workerContext?.taskId,
  };

  // Session start: first user message (parentUuid is null)
  if (entry.type === 'user' && !entry.parentUuid) {
    return {
      ...base,
      type: 'session_start',
    };
  }

  // Tool calls: assistant messages with tool_use content
  if (entry.type === 'assistant' && entry.toolCalls && entry.toolCalls.length > 0) {
    // Return first tool call (could be expanded to return multiple events)
    const tool = entry.toolCalls[0];
    return {
      ...base,
      type: 'tool_call',
      toolName: tool.name,
      toolInput: tool.input,
      toolCallId: tool.id,
    };
  }

  // Permission request detection from progress events
  if (entry.type === 'progress' && entry.data) {
    const data = entry.data as Record<string, unknown>;
    // Check for permission-related progress events
    if (data.type === 'permission_request' || data.waitingForPermission) {
      return {
        ...base,
        type: 'permission_request',
        toolName: (data.toolName as string) || undefined,
      };
    }
  }

  // Session end: detect via specific progress event types
  if (entry.type === 'progress' && entry.data) {
    const data = entry.data as Record<string, unknown>;
    if (data.type === 'session_end' || data.type === 'conversation_end') {
      return {
        ...base,
        type: 'session_end',
        exitReason: (data.reason as string) || 'completed',
      };
    }
  }

  // Not a relevant event
  return null;
}

// ============================================================================
// Pane Resolution
// ============================================================================

/**
 * Get the working directory for a tmux pane
 */
async function getPaneWorkdir(paneId: string): Promise<string | undefined> {
  try {
    // Normalize pane ID
    const normalizedPaneId = paneId.startsWith('%') ? paneId : `%${paneId}`;
    const result = await tmux.executeTmux(`display-message -p -t '${normalizedPaneId}' '#{pane_current_path}'`);
    return result.trim() || undefined;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Main Command
// ============================================================================

/**
 * Main events command entry point.
 * Supports single pane, all workers, follow mode, and emit mode.
 */
export async function eventsCommand(paneId: string | undefined, options: EventsOptions = {}): Promise<void> {
  try {
    // Handle --all mode: aggregate events from all workers
    if (options.all) {
      await eventsAllCommand(options);
      return;
    }

    // Require pane ID for single-pane mode
    if (!paneId) {
      console.error('Error: pane-id is required (or use --all for all workers)');
      process.exit(1);
    }

    // Normalize pane ID
    const normalizedPaneId = paneId.startsWith('%') ? paneId : `%${paneId}`;

    // Look up worker context from registry
    const worker = await registry.findByPane(normalizedPaneId);
    const workerContext: WorkerContext | undefined = worker
      ? {
          paneId: worker.paneId,
          wishSlug: worker.wishSlug,
          taskId: worker.taskId,
        }
      : undefined;

    // Get pane working directory
    let workdir = worker?.repoPath;
    if (!workdir) {
      workdir = await getPaneWorkdir(normalizedPaneId);
    }

    if (!workdir) {
      console.error(`Could not determine working directory for pane ${normalizedPaneId}`);
      process.exit(1);
    }

    // Find Claude logs for this pane
    const logInfo = await getLogsForPane(workdir);
    if (!logInfo) {
      console.error(`No Claude Code logs found for pane ${normalizedPaneId}`);
      console.error(`Working directory: ${workdir}`);
      process.exit(1);
    }

    if (options.follow || options.emit) {
      // Tail mode: stream events in real-time
      if (options.emit) {
        const eventFile = getEventFilePath(normalizedPaneId);
        console.error(`Writing events to ${eventFile}...`);
      }
      console.error(`Tailing events from ${logInfo.logPath}...`);
      console.error(`Press Ctrl+C to stop.\n`);

      const cleanup = await tailLogFile(logInfo.logPath, async (entry) => {
        const event = parseLogEntryToEvent(entry, workerContext);
        if (event) {
          // Always output to console unless in pure emit mode
          if (!options.emit || options.json || options.follow) {
            outputEvent(event, options);
          }

          // Write to event file if --emit is enabled
          if (options.emit) {
            await writeEventToFile(event, normalizedPaneId);
          }
        }
      });

      // Handle Ctrl+C
      process.on('SIGINT', () => {
        cleanup();
        process.exit(0);
      });

      // Keep running
      await new Promise(() => {});
    } else {
      // Read mode: show recent events
      const entries = await readLogFile(logInfo.logPath);
      const events: NormalizedEvent[] = [];

      for (const entry of entries) {
        const event = parseLogEntryToEvent(entry, workerContext);
        if (event) {
          events.push(event);
        }
      }

      // Limit to last N events
      const limit = options.lines || 20;
      const recentEvents = events.slice(-limit);

      if (options.json) {
        console.log(JSON.stringify(recentEvents, null, 2));
      } else {
        if (recentEvents.length === 0) {
          console.log('No events found.');
        } else {
          for (const event of recentEvents) {
            outputEvent(event, options);
          }
        }
      }
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Handle --all mode: aggregate events from all active workers.
 * Reads from event files in .genie/events/
 */
async function eventsAllCommand(options: EventsOptions): Promise<void> {
  // Get all active workers
  const workers = await registry.list();

  if (workers.length === 0) {
    if (options.json) {
      console.log('[]');
    } else {
      console.log('No active workers found.');
    }
    return;
  }

  // Aggregate events from all event files
  const allEvents = await aggregateAllEvents();

  // Filter to events from active workers only
  const activePaneIds = new Set(workers.map(w => w.paneId));
  const activeEvents = allEvents.filter(e => e.paneId && activePaneIds.has(e.paneId));

  // Limit to last N events
  const limit = options.lines || 50;
  const recentEvents = activeEvents.slice(-limit);

  if (options.json) {
    console.log(JSON.stringify(recentEvents, null, 2));
  } else {
    if (recentEvents.length === 0) {
      console.log('No events found from active workers.');
      console.log('Hint: Use --emit flag when tailing to write events to files.');
    } else {
      for (const event of recentEvents) {
        outputEvent(event, options);
      }
    }
  }
}

/**
 * Output a single event to stdout
 */
function outputEvent(event: NormalizedEvent, options: EventsOptions): void {
  if (options.json) {
    console.log(JSON.stringify(event));
  } else {
    // Human-readable format
    const time = new Date(event.timestamp).toLocaleTimeString();
    const context = event.wishId ? `[${event.wishId}] ` : '';

    switch (event.type) {
      case 'session_start':
        console.log(`${time} ${context}SESSION_START - ${event.cwd}`);
        break;
      case 'tool_call':
        const input = event.toolInput
          ? Object.entries(event.toolInput)
              .slice(0, 2)
              .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 30)}`)
              .join(', ')
          : '';
        console.log(`${time} ${context}TOOL_CALL - ${event.toolName}(${input})`);
        break;
      case 'permission_request':
        console.log(`${time} ${context}PERMISSION_REQUEST - ${event.toolName || 'unknown'}`);
        break;
      case 'session_end':
        console.log(`${time} ${context}SESSION_END - ${event.exitReason || 'completed'}`);
        break;
    }
  }
}
