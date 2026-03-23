/**
 * Worker History Command - Session catch-up with compression
 *
 * Produces a compressed summary of a worker's session by parsing
 * provider logs (Claude Code or Codex) and extracting key events.
 *
 * Usage:
 *   genie history <agent>                         # Compressed summary
 *   genie history <agent> --full                  # Full conversation
 *   genie history <agent> --since 5               # Last 5 user/assistant exchanges
 *   genie history <agent> --last 20               # Last 20 transcript entries
 *   genie history <agent> --type assistant         # Only assistant messages
 *   genie history <agent> --json                  # JSON output
 *   genie history <agent> --ndjson                # Newline-delimited JSON (pipeable)
 *   genie history <agent> --ndjson | jq '.text'   # Pipe to jq
 */

import * as workerRegistry from '../lib/agent-registry.js';
import type { TranscriptEntry, TranscriptFilter, TranscriptRole } from '../lib/transcript.js';

// ============================================================================
// Types
// ============================================================================

export interface HistoryOptions {
  /** Show full conversation without compression */
  full?: boolean;
  /** Show last N user/assistant exchanges (legacy) */
  since?: number;
  /** Show last N transcript entries */
  last?: number;
  /** Filter by role (user, assistant, tool_call, system) */
  type?: string;
  /** Output as JSON */
  json?: boolean;
  /** Output as newline-delimited JSON */
  ndjson?: boolean;
  /** Show raw JSONL entries */
  raw?: boolean;
  /** Direct path to log file (for testing/debugging) */
  logFile?: string;
  /** ISO timestamp — only entries after this time */
  after?: string;
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
  provider: string;
  duration: string;
  totalEntries: number;
  compressedLines: number;
  compressionRatio: number;
  exchanges: number;
  toolCalls: number;
  status: string;
}

// ============================================================================
// Event Extraction (from TranscriptEntry)
// ============================================================================

function formatTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '??:??';
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 3)}...`;
}

function formatPath(path: string): string {
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

function processToolCallEntry(entry: TranscriptEntry, ctx: EventExtractionContext): void {
  if (!entry.toolCall) return;
  const { name, input } = entry.toolCall;
  const inputRecord = input as Record<string, unknown>;

  // Normalize Codex shell/exec_command to match Claude tool names
  const normalizedName = name === 'shell' || name === 'exec_command' ? 'Bash' : name;

  switch (normalizedName) {
    case 'Read':
      ctx.lastReadTime = entry.timestamp;
      if (inputRecord.file_path) ctx.pendingReads.push(String(inputRecord.file_path));
      break;
    case 'Edit':
      flushPendingReads(ctx);
      ctx.lastEditTime = entry.timestamp;
      if (inputRecord.file_path) ctx.pendingEdits.push(String(inputRecord.file_path));
      break;
    case 'Write':
      flushAll(ctx);
      ctx.events.push({
        timestamp: entry.timestamp,
        type: 'write',
        summary: `Write: ${formatPath(String(inputRecord.file_path || 'unknown'))}`,
      });
      break;
    case 'Bash': {
      flushAll(ctx);
      const cmd = String(inputRecord.command || '').replace(/\n/g, ' ');
      ctx.events.push({ timestamp: entry.timestamp, type: 'bash', summary: `Bash: ${truncate(cmd, 60)}` });
      break;
    }
    case 'AskUserQuestion': {
      flushAll(ctx);
      const questions = inputRecord.questions as Array<{ question?: string }> | undefined;
      ctx.events.push({
        timestamp: entry.timestamp,
        type: 'question',
        summary: `Question: ${truncate(questions?.[0]?.question || 'question', 60)}`,
      });
      break;
    }
    default: {
      flushAll(ctx);
      ctx.events.push({
        timestamp: entry.timestamp,
        type: 'bash',
        summary: `${normalizedName}: ${truncate(entry.text.replace(/\n/g, ' '), 60)}`,
      });
    }
  }
}

function processTranscriptEntry(entry: TranscriptEntry, ctx: EventExtractionContext): void {
  if (entry.role === 'user') {
    flushAll(ctx);
    ctx.events.push({
      timestamp: entry.timestamp,
      type: 'prompt',
      summary: truncate(entry.text.replace(/\n/g, ' '), 80),
    });
    return;
  }

  if (entry.role === 'tool_call') {
    processToolCallEntry(entry, ctx);
    return;
  }

  if (entry.role === 'assistant' && entry.text.length > 100) {
    flushAll(ctx);
    ctx.events.push({
      timestamp: entry.timestamp,
      type: 'response',
      summary: truncate(entry.text.replace(/\n/g, ' '), 80),
    });
  }
}

function extractEvents(entries: TranscriptEntry[]): CompressedEvent[] {
  const ctx: EventExtractionContext = {
    events: [],
    pendingReads: [],
    pendingEdits: [],
    lastReadTime: '',
    lastEditTime: '',
  };

  for (const entry of entries) {
    processTranscriptEntry(entry, ctx);
  }

  flushAll(ctx);
  return ctx.events;
}

function detectStatus(entries: TranscriptEntry[]): string {
  if (entries.length === 0) return 'unknown';

  const lastEntries = entries.slice(-10);
  for (const entry of lastEntries.reverse()) {
    if (entry.role === 'tool_call' && entry.toolCall?.name === 'AskUserQuestion') return 'question';
  }

  const last = entries[entries.length - 1];
  if (last.role === 'user') return 'working';
  if (last.role === 'assistant') return 'idle';
  return 'unknown';
}

// ============================================================================
// Display Formatting
// ============================================================================

function formatEventsForDisplay(events: CompressedEvent[], stats: SessionStats): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(
    `Session: ${stats.workerId} [${stats.provider}]${stats.branch ? ` (${stats.branch})` : ''} | ${stats.duration} | ${stats.totalEntries} entries → ${stats.compressedLines} lines`,
  );
  lines.push('');

  for (const event of events) {
    const time = formatTime(event.timestamp);
    const icon = getEventIcon(event.type);
    lines.push(`[${time}] ${icon} ${event.summary}`);

    if (event.details && event.details.length > 0) {
      for (const detail of event.details.slice(0, 5)) {
        lines.push(`         ${detail}`);
      }
      if (event.details.length > 5) {
        lines.push(`         ... and ${event.details.length - 5} more`);
      }
    }

    if (event.result) {
      lines.push(`         → ${event.result}`);
    }
  }

  lines.push('');
  lines.push(
    `Status: ${stats.status.toUpperCase()} | ${stats.exchanges} exchanges | ${stats.toolCalls} tool calls | ${stats.compressionRatio.toFixed(0)}x compression`,
  );
  lines.push('');

  return lines.join('\n');
}

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

function formatToolDetail(toolCall: NonNullable<TranscriptEntry['toolCall']>): string {
  const input = toolCall.input as Record<string, unknown>;
  if (toolCall.name === 'Bash' || toolCall.name === 'shell') {
    return `  ${toolCall.name}: ${input.command ?? ''}`;
  }
  if (['Read', 'Edit', 'Write'].includes(toolCall.name)) {
    return `  ${toolCall.name}: ${input.file_path ?? ''}`;
  }
  return `  ${toolCall.name}`;
}

function formatTranscriptEntryForDisplay(entry: TranscriptEntry): string[] {
  const time = formatTime(entry.timestamp);

  switch (entry.role) {
    case 'user':
      return [`\n[${time}] USER:`, entry.text];
    case 'tool_call':
      return entry.toolCall ? [`\n[${time}] TOOL:`, formatToolDetail(entry.toolCall)] : [];
    case 'assistant':
      return [`\n[${time}] ASSISTANT:`, truncate(entry.text, 500)];
    case 'tool_result':
      return [`\n[${time}] RESULT:`, `  ${truncate(entry.text, 500)}`];
    case 'system':
      return [`\n[${time}] SYSTEM:`, entry.text];
    default:
      return [];
  }
}

function formatFullConversation(entries: TranscriptEntry[]): string {
  return entries.flatMap(formatTranscriptEntryForDisplay).join('\n');
}

// ============================================================================
// Main Command
// ============================================================================

async function findWorker(identifier: string): Promise<workerRegistry.Agent | null> {
  let worker = await workerRegistry.get(identifier);
  if (worker) return worker;

  worker = await workerRegistry.findByTask(identifier);
  if (worker) return worker;

  const allWorkers = await workerRegistry.list();
  return (
    allWorkers.find(
      (w) =>
        w.id.includes(identifier) ||
        w.taskId?.includes(identifier) ||
        w.taskTitle?.toLowerCase().includes(identifier.toLowerCase()),
    ) ?? null
  );
}

/** Resolved context for transcript reading */
interface TranscriptContext {
  worker: workerRegistry.Agent;
  workerId: string;
  provider: string;
  branch?: string;
  duration: string;
}

async function resolveContext(workerIdOrName: string, options: HistoryOptions): Promise<TranscriptContext> {
  if (options.logFile) {
    // Direct log file mode — create a stub worker for Claude provider
    const stub: workerRegistry.Agent = {
      id: 'direct',
      paneId: '',
      session: '',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'idle',
      lastStateChange: new Date().toISOString(),
      repoPath: process.cwd(),
      provider: 'claude',
    };
    return { worker: stub, workerId: 'direct', provider: 'claude', duration: 'N/A' };
  }

  const worker = await findWorker(workerIdOrName);
  if (!worker) {
    console.error(`Agent "${workerIdOrName}" not found. Run \`genie ls\` to see agents.`);
    process.exit(1);
  }

  const elapsed = workerRegistry.getElapsedTime(worker);
  return {
    worker,
    workerId: worker.id,
    provider: worker.provider ?? 'claude',
    branch: worker.worktree ? `work/${worker.taskId}` : undefined,
    duration: elapsed.formatted,
  };
}

/**
 * Build a TranscriptFilter from CLI options.
 */
function buildFilter(options: HistoryOptions): TranscriptFilter | undefined {
  const filter: TranscriptFilter = {};
  let hasFilter = false;

  if (options.last && options.last > 0) {
    filter.last = options.last;
    hasFilter = true;
  }

  if (options.after) {
    filter.since = options.after;
    hasFilter = true;
  }

  if (options.type) {
    filter.roles = [options.type as TranscriptRole];
    hasFilter = true;
  }

  return hasFilter ? filter : undefined;
}

/**
 * Filter entries by exchange count (last N user turns + everything after).
 * Legacy --since behavior.
 */
function filterSinceExchanges(entries: TranscriptEntry[], since: number): TranscriptEntry[] {
  let userCount = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].role === 'user') {
      userCount++;
      if (userCount >= since) return entries.slice(i);
    }
  }
  return entries;
}

async function loadEntries(ctx: TranscriptContext, options: HistoryOptions): Promise<TranscriptEntry[]> {
  const { readTranscript, getProvider } = await import('../lib/transcript.js');
  if (options.logFile) {
    const provider = await getProvider(ctx.worker);
    return provider.readEntries(options.logFile);
  }
  return readTranscript(ctx.worker);
}

function filterEntries(entries: TranscriptEntry[], options: HistoryOptions): TranscriptEntry[] {
  const { applyFilter } = require('../lib/transcript.js') as typeof import('../lib/transcript.js');
  let filtered = options.since && options.since > 0 ? filterSinceExchanges(entries, options.since) : entries;
  const transcriptFilter = buildFilter(options);
  if (transcriptFilter) filtered = applyFilter(filtered, transcriptFilter);
  return filtered;
}

function outputEntries(filtered: TranscriptEntry[], options: HistoryOptions): boolean {
  if (options.ndjson) {
    for (const entry of filtered) {
      const { raw: _raw, ...rest } = entry;
      console.log(JSON.stringify(options.raw ? entry : rest));
    }
    return true;
  }
  if (options.raw) {
    for (const entry of filtered) console.log(JSON.stringify(entry.raw));
    return true;
  }
  if (options.full) {
    console.log(formatFullConversation(filtered));
    return true;
  }
  return false;
}

/**
 * Main history command handler
 */
export async function historyCommand(workerIdOrName: string, options: HistoryOptions): Promise<void> {
  const ctx = await resolveContext(workerIdOrName, options);
  const entries = await loadEntries(ctx, options);

  if (entries.length === 0) {
    console.error(`No transcript found for agent "${ctx.workerId}".`);
    process.exit(1);
  }

  const filtered = filterEntries(entries, options);
  if (outputEntries(filtered, options)) return;

  // Compressed summary (default)
  const events = extractEvents(filtered);
  const toolCallCount = entries.filter((e) => e.role === 'tool_call').length;
  const userMessageCount = entries.filter((e) => e.role === 'user').length;

  const stats: SessionStats = {
    workerId: ctx.workerId,
    taskId: ctx.workerId,
    branch: ctx.branch,
    provider: ctx.provider,
    duration: ctx.duration,
    totalEntries: entries.length,
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
