/**
 * Term History Command - Session catch-up with compression
 *
 * Produces a compressed summary of a worker's session by parsing
 * Claude's JSONL logs and extracting key events.
 *
 * Usage:
 *   term history <worker>          # Compressed summary
 *   term history <worker> --full   # Full conversation
 *   term history <worker> --since 5  # Last 5 exchanges
 *   term history <worker> --json   # JSON output
 */

import * as workerRegistry from '../lib/worker-registry.js';
import * as claudeLogs from '../lib/claude-logs.js';
import { resolve } from 'path';

// ============================================================================
// Types
// ============================================================================

export interface HistoryOptions {
  /** Show full conversation without compression */
  full?: boolean;
  /** Show last N user/assistant exchanges */
  since?: number;
  /** Output as JSON */
  json?: boolean;
  /** Show raw JSONL entries */
  raw?: boolean;
  /** Direct path to log file (for testing/debugging) */
  logFile?: string;
}

/** Compressed event for display */
interface CompressedEvent {
  timestamp: string;
  type: 'prompt' | 'read' | 'edit' | 'write' | 'bash' | 'question' | 'answer' | 'permission' | 'thinking' | 'response';
  summary: string;
  details?: string[];
  result?: string;
}

/** Session summary stats */
interface SessionStats {
  workerId: string;
  taskId?: string;
  branch?: string;
  duration: string;
  totalLines: number;
  compressedLines: number;
  compressionRatio: number;
  exchanges: number;
  toolCalls: number;
  status: string;
}

// ============================================================================
// Event Extraction
// ============================================================================

/**
 * Extract text content from a message content array or string
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        textParts.push(item);
      } else if (item && typeof item === 'object' && 'text' in item) {
        textParts.push(String(item.text));
      }
    }
    return textParts.join(' ');
  }
  return '';
}

/**
 * Format a timestamp for display (HH:MM)
 */
function formatTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '??:??';
  }
}

/**
 * Truncate a string with ellipsis
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

/**
 * Format file path for display (shorten if needed)
 */
function formatPath(path: string): string {
  // Remove common prefixes
  const shortened = path
    .replace(/^\/home\/\w+\/workspace\//, '~/')
    .replace(/^\/home\/\w+\//, '~/');
  return truncate(shortened, 50);
}

/**
 * Extract compressed events from log entries
 */
function extractEvents(entries: claudeLogs.ClaudeLogEntry[]): CompressedEvent[] {
  const events: CompressedEvent[] = [];
  const pendingReads: string[] = [];
  const pendingEdits: string[] = [];
  let lastReadTime = '';
  let lastEditTime = '';

  const flushReads = () => {
    if (pendingReads.length > 0) {
      events.push({
        timestamp: lastReadTime,
        type: 'read',
        summary: pendingReads.length === 1
          ? `Read: ${formatPath(pendingReads[0])}`
          : `Read ${pendingReads.length} files`,
        details: pendingReads.length > 1 ? pendingReads.map(formatPath) : undefined,
      });
      pendingReads.length = 0;
    }
  };

  const flushEdits = () => {
    if (pendingEdits.length > 0) {
      events.push({
        timestamp: lastEditTime,
        type: 'edit',
        summary: pendingEdits.length === 1
          ? `Edit: ${formatPath(pendingEdits[0])}`
          : `Edit ${pendingEdits.length} files`,
        details: pendingEdits.length > 1 ? pendingEdits.map(formatPath) : undefined,
      });
      pendingEdits.length = 0;
    }
  };

  for (const entry of entries) {
    // User messages (prompts)
    if (entry.type === 'user' && entry.message) {
      flushReads();
      flushEdits();
      const text = extractTextContent(entry.message.content);
      if (text) {
        events.push({
          timestamp: entry.timestamp,
          type: 'prompt',
          summary: truncate(text.replace(/\n/g, ' '), 80),
        });
      }
    }

    // Assistant messages with tool calls
    if (entry.type === 'assistant' && entry.toolCalls) {
      for (const tool of entry.toolCalls) {
        const input = tool.input as Record<string, unknown>;

        switch (tool.name) {
          case 'Read':
            lastReadTime = entry.timestamp;
            if (input.file_path) {
              pendingReads.push(String(input.file_path));
            }
            break;

          case 'Edit':
            flushReads(); // Flush reads before edits
            lastEditTime = entry.timestamp;
            if (input.file_path) {
              pendingEdits.push(String(input.file_path));
            }
            break;

          case 'Write':
            flushReads();
            flushEdits();
            events.push({
              timestamp: entry.timestamp,
              type: 'write',
              summary: `Write: ${formatPath(String(input.file_path || 'unknown'))}`,
            });
            break;

          case 'Bash':
            flushReads();
            flushEdits();
            const cmd = String(input.command || '').replace(/\n/g, ' ');
            events.push({
              timestamp: entry.timestamp,
              type: 'bash',
              summary: `Bash: ${truncate(cmd, 60)}`,
            });
            break;

          case 'AskUserQuestion':
            flushReads();
            flushEdits();
            const questions = input.questions as Array<{ question?: string }> | undefined;
            const questionText = questions?.[0]?.question || 'question';
            events.push({
              timestamp: entry.timestamp,
              type: 'question',
              summary: `Question: ${truncate(questionText, 60)}`,
            });
            break;
        }
      }
    }

    // Assistant text responses (no tool calls) - only include significant ones
    if (entry.type === 'assistant' && entry.message && !entry.toolCalls) {
      flushReads();
      flushEdits();
      const text = extractTextContent(entry.message.content);
      // Only include if it's substantial (more than a short acknowledgment)
      if (text && text.length > 100) {
        events.push({
          timestamp: entry.timestamp,
          type: 'response',
          summary: truncate(text.replace(/\n/g, ' '), 80),
        });
      }
    }
  }

  // Flush any remaining
  flushReads();
  flushEdits();

  return events;
}

/**
 * Detect current worker status from last entries
 */
function detectStatus(entries: claudeLogs.ClaudeLogEntry[]): string {
  if (entries.length === 0) return 'unknown';

  // Check last few entries for status indicators
  const lastEntries = entries.slice(-10);

  for (const entry of lastEntries.reverse()) {
    // Check for permission request
    if (entry.type === 'assistant' && entry.toolCalls) {
      // If there's a pending tool call, might be waiting
      const lastTool = entry.toolCalls[entry.toolCalls.length - 1];
      if (lastTool.name === 'AskUserQuestion') {
        return 'question';
      }
    }

    // Check for progress events that indicate state
    if (entry.type === 'progress' && entry.data) {
      const data = entry.data as Record<string, unknown>;
      if (data.type === 'permission_request') {
        return 'permission';
      }
    }
  }

  // If last entry is user message, Claude is working
  const lastEntry = entries[entries.length - 1];
  if (lastEntry.type === 'user') {
    return 'working';
  }

  // If last entry is assistant, Claude is idle
  if (lastEntry.type === 'assistant') {
    return 'idle';
  }

  return 'unknown';
}

// ============================================================================
// Display Formatting
// ============================================================================

/**
 * Format events for terminal display
 */
function formatEventsForDisplay(events: CompressedEvent[], stats: SessionStats): string {
  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push(`Session: ${stats.workerId}${stats.branch ? ` (${stats.branch})` : ''} | ${stats.duration} | ${stats.totalLines} lines → ${stats.compressedLines} lines`);
  lines.push('');

  // Events
  for (const event of events) {
    const time = formatTime(event.timestamp);
    const icon = getEventIcon(event.type);
    lines.push(`[${time}] ${icon} ${event.summary}`);

    // Show details if present
    if (event.details && event.details.length > 0) {
      for (const detail of event.details.slice(0, 5)) {
        lines.push(`         ${detail}`);
      }
      if (event.details.length > 5) {
        lines.push(`         ... and ${event.details.length - 5} more`);
      }
    }

    // Show result if present
    if (event.result) {
      lines.push(`         → ${event.result}`);
    }
  }

  // Footer
  lines.push('');
  lines.push(`Status: ${stats.status.toUpperCase()} | ${stats.exchanges} exchanges | ${stats.toolCalls} tool calls | ${stats.compressionRatio.toFixed(0)}x compression`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Get icon for event type
 */
function getEventIcon(type: CompressedEvent['type']): string {
  switch (type) {
    case 'prompt': return '💬';
    case 'read': return '📖';
    case 'edit': return '✏️';
    case 'write': return '📝';
    case 'bash': return '⚡';
    case 'question': return '❓';
    case 'answer': return '✅';
    case 'permission': return '🔐';
    case 'thinking': return '🤔';
    case 'response': return '💭';
    default: return '•';
  }
}

/**
 * Format full conversation for display
 */
function formatFullConversation(entries: claudeLogs.ClaudeLogEntry[]): string {
  const lines: string[] = [];

  for (const entry of entries) {
    const time = formatTime(entry.timestamp);

    if (entry.type === 'user' && entry.message) {
      const text = extractTextContent(entry.message.content);
      lines.push(`\n[${time}] USER:`);
      lines.push(text);
    }

    if (entry.type === 'assistant') {
      if (entry.toolCalls && entry.toolCalls.length > 0) {
        lines.push(`\n[${time}] ASSISTANT (tools):`);
        for (const tool of entry.toolCalls) {
          const input = tool.input as Record<string, unknown>;
          if (tool.name === 'Bash') {
            lines.push(`  ${tool.name}: ${input.command}`);
          } else if (tool.name === 'Read' || tool.name === 'Edit' || tool.name === 'Write') {
            lines.push(`  ${tool.name}: ${input.file_path}`);
          } else {
            lines.push(`  ${tool.name}`);
          }
        }
      } else if (entry.message) {
        const text = extractTextContent(entry.message.content);
        if (text) {
          lines.push(`\n[${time}] ASSISTANT:`);
          lines.push(text.slice(0, 500) + (text.length > 500 ? '...' : ''));
        }
      }
    }
  }

  return lines.join('\n');
}

// ============================================================================
// Main Command
// ============================================================================

/**
 * Find worker by ID or task ID
 */
async function findWorker(identifier: string): Promise<workerRegistry.Worker | null> {
  // Try direct ID lookup first
  let worker = await workerRegistry.get(identifier);
  if (worker) return worker;

  // Try task ID lookup
  worker = await workerRegistry.findByTask(identifier);
  if (worker) return worker;

  // Try partial match on worker ID
  const allWorkers = await workerRegistry.list();
  const match = allWorkers.find(w =>
    w.id.includes(identifier) ||
    w.taskId.includes(identifier) ||
    (w.taskTitle && w.taskTitle.toLowerCase().includes(identifier.toLowerCase()))
  );

  return match || null;
}

/**
 * Main history command handler
 */
export async function historyCommand(
  workerIdOrName: string,
  options: HistoryOptions
): Promise<void> {
  let logPath: string;
  let workerId: string;
  let branch: string | undefined;
  let duration: string;

  // Direct log file mode (for testing/debugging)
  if (options.logFile) {
    logPath = options.logFile;
    workerId = 'direct';
    duration = 'N/A';
  } else {
    // Find the worker
    const worker = await findWorker(workerIdOrName);

    if (!worker) {
      console.error(`❌ Worker "${workerIdOrName}" not found.`);
      console.error('   Run `term workers` to see active workers.');
      process.exit(1);
    }

    // Find Claude logs for this worker's workspace
    const workspacePath = worker.worktree || worker.repoPath;
    const logInfo = await claudeLogs.getLogsForPane(workspacePath);

    if (!logInfo) {
      console.error(`❌ No Claude logs found for worker "${worker.id}"`);
      console.error(`   Workspace: ${workspacePath}`);
      process.exit(1);
    }

    logPath = logInfo.logPath;
    workerId = worker.id;
    branch = worker.worktree ? `work/${worker.taskId}` : undefined;
    const elapsed = workerRegistry.getElapsedTime(worker);
    duration = elapsed.formatted;
  }

  // Read log entries
  const entries = await claudeLogs.readLogFile(logPath);

  if (entries.length === 0) {
    console.error(`❌ Log file is empty: ${logInfo.logPath}`);
    process.exit(1);
  }

  // Filter to user/assistant entries for conversation
  const conversationEntries = entries.filter(e =>
    e.type === 'user' || e.type === 'assistant'
  );

  // Handle --since option (last N exchanges)
  let filteredEntries = conversationEntries;
  if (options.since && options.since > 0) {
    // Find last N user prompts and everything after first one
    let userCount = 0;
    let startIndex = conversationEntries.length;

    for (let i = conversationEntries.length - 1; i >= 0; i--) {
      if (conversationEntries[i].type === 'user') {
        userCount++;
        if (userCount >= options.since) {
          startIndex = i;
          break;
        }
      }
    }

    filteredEntries = conversationEntries.slice(startIndex);
  }

  // Calculate stats
  const toolCallCount = entries.reduce((count, e) => count + (e.toolCalls?.length || 0), 0);
  const userMessageCount = entries.filter(e => e.type === 'user').length;

  // Handle --raw option
  if (options.raw) {
    for (const entry of filteredEntries) {
      console.log(JSON.stringify(entry.raw));
    }
    return;
  }

  // Handle --full option
  if (options.full) {
    const output = formatFullConversation(filteredEntries);
    console.log(output);
    return;
  }

  // Default: compressed view
  const events = extractEvents(filteredEntries);

  const stats: SessionStats = {
    workerId,
    taskId: workerId,
    branch,
    duration,
    totalLines: entries.length,
    compressedLines: events.length,
    compressionRatio: entries.length / Math.max(events.length, 1),
    exchanges: userMessageCount,
    toolCalls: toolCallCount,
    status: detectStatus(entries),
  };

  // Handle --json option
  if (options.json) {
    console.log(JSON.stringify({ stats, events }, null, 2));
    return;
  }

  // Default: formatted display
  const output = formatEventsForDisplay(events, stats);
  console.log(output);
}
