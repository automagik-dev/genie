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
