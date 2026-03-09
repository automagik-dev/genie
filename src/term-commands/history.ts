/**
 * Worker History Command - Session catch-up with compression
 *
 * Produces a compressed summary of a worker's session by parsing
 * Claude's JSONL logs and extracting key events.
 *
 * Usage:
 *   genie agent history <agent>          # Compressed summary
 *   genie agent history <agent> --full   # Full conversation
 *   genie agent history <agent> --since 5  # Last 5 exchanges
 *   genie agent history <agent> --json   # JSON output
 */

import * as workerRegistry from '../lib/agent-registry.js';
import * as claudeLogs from '../lib/claude-logs.js';

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
  return `${str.slice(0, maxLen - 3)}...`;
}

/**
 * Format file path for display (shorten if needed)
 */
function formatPath(path: string): string {
  // Remove common prefixes
  const shortened = path.replace(/^\/home\/\w+\/workspace\//, '~/').replace(/^\/home\/\w+\//, '~/');
  return truncate(shortened, 50);
}

/** Context for batching reads/edits during event extraction */
interface EventExtractionContext {
  events: CompressedEvent[];
  pendingReads: string[];
  pendingEdits: string[];
  lastReadTime: string;
  lastEditTime: string;
}

function flushPendingReads(ctx: EventExtractionContext): void {
  if (ctx.pendingReads.length === 0) return;
  ctx.events.push({
    timestamp: ctx.lastReadTime,
    type: 'read',
    summary:
      ctx.pendingReads.length === 1
        ? `Read: ${formatPath(ctx.pendingReads[0])}`
        : `Read ${ctx.pendingReads.length} files`,
    details: ctx.pendingReads.length > 1 ? ctx.pendingReads.map(formatPath) : undefined,
  });
  ctx.pendingReads.length = 0;
}

function flushPendingEdits(ctx: EventExtractionContext): void {
  if (ctx.pendingEdits.length === 0) return;
  ctx.events.push({
    timestamp: ctx.lastEditTime,
    type: 'edit',
    summary:
      ctx.pendingEdits.length === 1
        ? `Edit: ${formatPath(ctx.pendingEdits[0])}`
        : `Edit ${ctx.pendingEdits.length} files`,
    details: ctx.pendingEdits.length > 1 ? ctx.pendingEdits.map(formatPath) : undefined,
  });
  ctx.pendingEdits.length = 0;
}

function flushAll(ctx: EventExtractionContext): void {
  flushPendingReads(ctx);
  flushPendingEdits(ctx);
}

function processToolCall(tool: { name: string; input: unknown }, timestamp: string, ctx: EventExtractionContext): void {
  const input = tool.input as Record<string, unknown>;
  switch (tool.name) {
    case 'Read':
      ctx.lastReadTime = timestamp;
      if (input.file_path) ctx.pendingReads.push(String(input.file_path));
      break;
    case 'Edit':
      flushPendingReads(ctx);
      ctx.lastEditTime = timestamp;
      if (input.file_path) ctx.pendingEdits.push(String(input.file_path));
      break;
    case 'Write':
      flushAll(ctx);
      ctx.events.push({
        timestamp,
        type: 'write',
        summary: `Write: ${formatPath(String(input.file_path || 'unknown'))}`,
      });
      break;
    case 'Bash': {
      flushAll(ctx);
      const cmd = String(input.command || '').replace(/\n/g, ' ');
      ctx.events.push({ timestamp, type: 'bash', summary: `Bash: ${truncate(cmd, 60)}` });
      break;
    }
    case 'AskUserQuestion': {
      flushAll(ctx);
      const questions = input.questions as Array<{ question?: string }> | undefined;
      ctx.events.push({
        timestamp,
        type: 'question',
        summary: `Question: ${truncate(questions?.[0]?.question || 'question', 60)}`,
      });
      break;
    }
  }
}

function processLogEntry(entry: claudeLogs.ClaudeLogEntry, ctx: EventExtractionContext): void {
  if (entry.type === 'user' && entry.message) {
    flushAll(ctx);
    const text = extractTextContent(entry.message.content);
    if (text) {
      ctx.events.push({ timestamp: entry.timestamp, type: 'prompt', summary: truncate(text.replace(/\n/g, ' '), 80) });
    }
    return;
  }

  if (entry.type === 'assistant' && entry.toolCalls) {
    for (const tool of entry.toolCalls) {
      processToolCall(tool, entry.timestamp, ctx);
    }
    return;
  }

  if (entry.type === 'assistant' && entry.message && !entry.toolCalls) {
    flushAll(ctx);
    const text = extractTextContent(entry.message.content);
    if (text && text.length > 100) {
      ctx.events.push({
        timestamp: entry.timestamp,
        type: 'response',
        summary: truncate(text.replace(/\n/g, ' '), 80),
      });
    }
  }
}

/**
 * Extract compressed events from log entries
 */
function extractEvents(entries: claudeLogs.ClaudeLogEntry[]): CompressedEvent[] {
  const ctx: EventExtractionContext = {
    events: [],
    pendingReads: [],
    pendingEdits: [],
    lastReadTime: '',
    lastEditTime: '',
  };

  for (const entry of entries) {
    processLogEntry(entry, ctx);
  }

  flushAll(ctx);
  return ctx.events;
}

/**
 * Detect current worker status from last entries
 */
function detectStatusFromEntry(entry: claudeLogs.ClaudeLogEntry): string | null {
  if (entry.type === 'assistant' && entry.toolCalls) {
    const lastTool = entry.toolCalls[entry.toolCalls.length - 1];
    if (lastTool.name === 'AskUserQuestion') return 'question';
  }
  if (entry.type === 'progress' && entry.data) {
    const data = entry.data as Record<string, unknown>;
    if (data.type === 'permission_request') return 'permission';
  }
  return null;
}

function detectStatus(entries: claudeLogs.ClaudeLogEntry[]): string {
  if (entries.length === 0) return 'unknown';

  const lastEntries = entries.slice(-10);
  for (const entry of lastEntries.reverse()) {
    const status = detectStatusFromEntry(entry);
    if (status) return status;
  }

  const lastEntry = entries[entries.length - 1];
  if (lastEntry.type === 'user') return 'working';
  if (lastEntry.type === 'assistant') return 'idle';
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
  lines.push(
    `Session: ${stats.workerId}${stats.branch ? ` (${stats.branch})` : ''} | ${stats.duration} | ${stats.totalLines} lines → ${stats.compressedLines} lines`,
  );
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
  lines.push(
    `Status: ${stats.status.toUpperCase()} | ${stats.exchanges} exchanges | ${stats.toolCalls} tool calls | ${stats.compressionRatio.toFixed(0)}x compression`,
  );
  lines.push('');

  return lines.join('\n');
}

/**
 * Get icon for event type
 */
function getEventIcon(type: CompressedEvent['type']): string {
  switch (type) {
    case 'prompt':
      return '💬';
    case 'read':
      return '📖';
    case 'edit':
      return '✏️';
    case 'write':
      return '📝';
    case 'bash':
      return '⚡';
    case 'question':
      return '❓';
    case 'answer':
      return '✅';
    case 'permission':
      return '🔐';
    case 'thinking':
      return '🤔';
    case 'response':
      return '💭';
    default:
      return '•';
  }
}

/**
 * Format full conversation for display
 */
function formatToolCallLine(tool: { name: string; input: unknown }): string {
  const input = tool.input as Record<string, unknown>;
  if (tool.name === 'Bash') return `  ${tool.name}: ${input.command}`;
  if (tool.name === 'Read' || tool.name === 'Edit' || tool.name === 'Write')
    return `  ${tool.name}: ${input.file_path}`;
  return `  ${tool.name}`;
}

function formatEntryForDisplay(entry: claudeLogs.ClaudeLogEntry): string[] {
  const time = formatTime(entry.timestamp);

  if (entry.type === 'user' && entry.message) {
    return [`\n[${time}] USER:`, extractTextContent(entry.message.content)];
  }

  if (entry.type !== 'assistant') return [];

  if (entry.toolCalls && entry.toolCalls.length > 0) {
    return [`\n[${time}] ASSISTANT (tools):`, ...entry.toolCalls.map(formatToolCallLine)];
  }

  if (entry.message) {
    const text = extractTextContent(entry.message.content);
    if (text) {
      return [`\n[${time}] ASSISTANT:`, text.slice(0, 500) + (text.length > 500 ? '...' : '')];
    }
  }

  return [];
}

function formatFullConversation(entries: claudeLogs.ClaudeLogEntry[]): string {
  return entries.flatMap(formatEntryForDisplay).join('\n');
}

// ============================================================================
// Main Command
// ============================================================================

/**
 * Find worker by ID or task ID
 */
async function findWorker(identifier: string): Promise<workerRegistry.Agent | null> {
  // Try direct ID lookup first
  let worker = await workerRegistry.get(identifier);
  if (worker) return worker;

  // Try task ID lookup
  worker = await workerRegistry.findByTask(identifier);
  if (worker) return worker;

  // Try partial match on worker ID
  const allWorkers = await workerRegistry.list();
  const match = allWorkers.find(
    (w) =>
      w.id.includes(identifier) ||
      w.taskId?.includes(identifier) ||
      w.taskTitle?.toLowerCase().includes(identifier.toLowerCase()),
  );

  return match || null;
}

/** Resolved log context for history display */
interface LogContext {
  logPath: string;
  workerId: string;
  branch?: string;
  duration: string;
}

async function resolveLogContext(workerIdOrName: string, options: HistoryOptions): Promise<LogContext> {
  if (options.logFile) {
    return { logPath: options.logFile, workerId: 'direct', duration: 'N/A' };
  }

  const worker = await findWorker(workerIdOrName);
  if (!worker) {
    console.error(`❌ Agent "${workerIdOrName}" not found.`);
    console.error('   Run `genie agent list` to see active agents.');
    process.exit(1);
  }

  const workspacePath = worker.worktree || worker.repoPath;
  const logInfo = await claudeLogs.getLogsForPane(workspacePath);
  if (!logInfo) {
    console.error(`❌ No Claude logs found for agent "${worker.id}"`);
    console.error(`   Workspace: ${workspacePath}`);
    process.exit(1);
  }

  const elapsed = workerRegistry.getElapsedTime(worker);
  return {
    logPath: logInfo.logPath,
    workerId: worker.id,
    branch: worker.worktree ? `work/${worker.taskId}` : undefined,
    duration: elapsed.formatted,
  };
}

function filterSinceExchanges(entries: claudeLogs.ClaudeLogEntry[], since: number): claudeLogs.ClaudeLogEntry[] {
  let userCount = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'user') {
      userCount++;
      if (userCount >= since) return entries.slice(i);
    }
  }
  return entries;
}

/**
 * Main history command handler
 */
export async function historyCommand(workerIdOrName: string, options: HistoryOptions): Promise<void> {
  const { logPath, workerId, branch, duration } = await resolveLogContext(workerIdOrName, options);

  const entries = await claudeLogs.readLogFile(logPath);
  if (entries.length === 0) {
    console.error(`❌ Log file is empty: ${logPath}`);
    process.exit(1);
  }

  const conversationEntries = entries.filter((e) => e.type === 'user' || e.type === 'assistant');
  const filteredEntries =
    options.since && options.since > 0 ? filterSinceExchanges(conversationEntries, options.since) : conversationEntries;

  if (options.raw) {
    for (const entry of filteredEntries) {
      console.log(JSON.stringify(entry.raw));
    }
    return;
  }

  if (options.full) {
    console.log(formatFullConversation(filteredEntries));
    return;
  }

  const events = extractEvents(filteredEntries);
  const toolCallCount = entries.reduce((count, e) => count + (e.toolCalls?.length || 0), 0);
  const userMessageCount = entries.filter((e) => e.type === 'user').length;

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

  if (options.json) {
    console.log(JSON.stringify({ stats, events }, null, 2));
    return;
  }

  console.log(formatEventsForDisplay(events, stats));
}
