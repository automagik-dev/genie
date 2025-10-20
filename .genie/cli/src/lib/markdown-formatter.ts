/**
 * Markdown Formatter for Token-Efficient AI-to-AI Orchestration Output
 *
 * Replaces verbose Ink rendering (16k tokens) with compact markdown (~300-500 tokens).
 * Provides 3 output modes optimized for different orchestration scenarios.
 */

export interface ChatMessage {
  title: string;
  body: string[];
  role?: string;
}

// ============================================================================
// Types
// ============================================================================

export type OutputMode = 'final' | 'recent' | 'overview' | 'full';

export interface SessionMeta {
  sessionId: string | null;
  agent: string;
  status: string | null;
  executor?: string;
  tokens?: { input: number; output: number; total: number };
  toolCalls?: Array<{ name: string; count: number }>;
  model?: string;
}

export interface SessionEntry {
  sessionId: string;
  agent: string;
  status: string;
  executor: string;
  model?: string;
  started?: string;
  updated?: string;
}

// ============================================================================
// Constants
// ============================================================================

const TOKEN_BUDGET = {
  final: 500,      // ~2000 chars
  recent: 300,     // ~1200 chars
  overview: 400,   // ~1600 chars
  full: Infinity   // No truncation - complete transcript
};

const CHARS_PER_TOKEN = 4; // Rough estimate for token counting

// ============================================================================
// Main Formatting Functions
// ============================================================================

/**
 * Format transcript messages into markdown with specified mode
 *
 * @param messages - Array of chat messages in temporal order
 * @param meta - Session metadata (id, agent, status, metrics)
 * @param mode - Output mode: 'final' | 'recent' | 'overview'
 * @returns Formatted markdown string optimized for token efficiency
 */
export function formatTranscriptMarkdown(
  messages: ChatMessage[],
  meta: SessionMeta,
  mode: OutputMode
): string {
  const parts: string[] = [];

  // Session header
  const sessionId = meta.sessionId || 'pending';
  parts.push(`## Session: ${sessionId}`);

  switch (mode) {
    case 'final':
      return formatFinalMode(messages, meta, parts);
    case 'recent':
      return formatRecentMode(messages, meta, parts);
    case 'overview':
      return formatOverviewMode(messages, meta, parts);
    case 'full':
      return formatFullMode(messages, meta, parts);
    default:
      return formatRecentMode(messages, meta, parts); // Default to recent
  }
}

/**
 * Format session list into compact markdown table
 *
 * @param sessions - Array of session entries
 * @returns Markdown table with session info
 */
export function formatSessionList(sessions: SessionEntry[]): string {
  if (sessions.length === 0) {
    return '**No sessions found**\n';
  }

  const parts: string[] = [];
  parts.push('## Active Sessions\n');
  parts.push('| Session ID | Agent | Status | Executor | Model |');
  parts.push('|------------|-------|--------|----------|-------|');

  for (const session of sessions) {
    const id = trimSessionId(session.sessionId);
    const model = session.model ? session.model : '';
    parts.push(`| ${id} | ${session.agent} | ${session.status} | ${session.executor} | ${model} |`);
  }

  return parts.join('\n') + '\n';
}

// ============================================================================
// Mode-Specific Formatters
// ============================================================================

/**
 * Final mode: Last message only, mini-report format
 * Target: ~500 tokens (2000 chars)
 * Use case: Completed tasks, final status reports
 */
function formatFinalMode(
  messages: ChatMessage[],
  meta: SessionMeta,
  parts: string[]
): string {
  parts.push(`**Agent:** ${meta.agent}`);
  parts.push(`**Status:** ${meta.status || 'unknown'}`);

  if (messages.length === 0) {
    parts.push('\n*No messages available*\n');
    return enforceTokenBudget(parts.join('\n'), 'final');
  }

  // Get last message
  const lastMsg = messages[messages.length - 1];
  parts.push(`**Last message:** ${lastMsg.title}\n`);

  // Format body with truncation if needed
  const body = formatMessageBody(lastMsg.body);
  parts.push(body);

  // Add metrics if available
  if (meta.tokens) {
    parts.push(`\n**Tokens:** ${meta.tokens.total}`);
  }

  return enforceTokenBudget(parts.join('\n'), 'final');
}

/**
 * Recent mode: Latest 5 messages, compact
 * Target: ~300 tokens (1200 chars)
 * Use case: In-progress work, recent context (DEFAULT)
 */
function formatRecentMode(
  messages: ChatMessage[],
  meta: SessionMeta,
  parts: string[]
): string {
  parts.push(`**Agent:** ${meta.agent}`);
  parts.push(`**Status:** ${meta.status || 'running'}\n`);

  if (messages.length === 0) {
    parts.push('*No messages yet*\n');
    return enforceTokenBudget(parts.join('\n'), 'recent');
  }

  // Get last 5 messages
  const recentMessages = messages.slice(-5);

  for (let i = 0; i < recentMessages.length; i++) {
    const msg = recentMessages[i];
    const msgNum = messages.length - recentMessages.length + i + 1;

    parts.push(`### Message ${msgNum}: ${msg.title}`);

    // Compact body (truncate per message if needed)
    const body = formatMessageBody(msg.body, 200); // Max 200 chars per message
    parts.push(body + '\n');
  }

  return enforceTokenBudget(parts.join('\n'), 'recent');
}

/**
 * Overview mode: Session metadata + checkpoints
 * Target: ~400 tokens (1600 chars)
 * Use case: High-level status, orchestration dashboards
 */
function formatOverviewMode(
  messages: ChatMessage[],
  meta: SessionMeta,
  parts: string[]
): string {
  parts.push(`**Agent:** ${meta.agent}`);
  parts.push(`**Status:** ${meta.status || 'unknown'}`);

  if (meta.executor) {
    parts.push(`**Executor:** ${meta.executor}`);
  }

  if (meta.model) {
    parts.push(`**Model:** ${meta.model}`);
  }

  // Token metrics
  if (meta.tokens) {
    const { input, output, total } = meta.tokens;
    parts.push(`**Tokens:** ${total} (in: ${input}, out: ${output})`);
  }

  // Tool usage
  if (meta.toolCalls && meta.toolCalls.length > 0) {
    const toolSummary = meta.toolCalls
      .map(tc => `${tc.name}:${tc.count}`)
      .join(', ');
    parts.push(`**Tools:** ${toolSummary}`);
  }

  // Message count
  parts.push(`**Messages:** ${messages.length}\n`);

  // Checkpoints (every 5th message or key milestones)
  if (messages.length > 0) {
    parts.push('### Key Checkpoints\n');

    const checkpoints: ChatMessage[] = [];

    // Always include first and last
    checkpoints.push(messages[0]);

    // Add every 5th message
    for (let i = 4; i < messages.length - 1; i += 5) {
      checkpoints.push(messages[i]);
    }

    // Add last if different from first
    if (messages.length > 1) {
      checkpoints.push(messages[messages.length - 1]);
    }

    for (const msg of checkpoints) {
      parts.push(`- **${msg.title}**: ${truncateText(msg.body.join(' '), 80)}`);
    }
  }

  return enforceTokenBudget(parts.join('\n'), 'overview');
}

/**
 * Full mode: Complete transcript with all messages
 * Target: No limit (Infinity)
 * Use case: Debugging, full context review, --full flag
 */
function formatFullMode(
  messages: ChatMessage[],
  meta: SessionMeta,
  parts: string[]
): string {
  parts.push(`**Agent:** ${meta.agent}`);
  parts.push(`**Status:** ${meta.status || 'unknown'}`);

  if (meta.executor) {
    parts.push(`**Executor:** ${meta.executor}`);
  }

  if (meta.model) {
    parts.push(`**Model:** ${meta.model}`);
  }

  // Message count
  parts.push(`**Messages:** ${messages.length}\n`);

  if (messages.length === 0) {
    parts.push('*No messages available*\n');
    return parts.join('\n');
  }

  // Show all messages with full content
  parts.push('### Full Transcript\n');

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    parts.push(`#### Message ${i + 1}: ${msg.title}`);

    // Show complete message body without truncation
    const body = formatMessageBody(msg.body);
    parts.push(body + '\n');
  }

  // Add metrics if available (no token budget enforcement)
  if (meta.tokens) {
    const { input, output, total } = meta.tokens;
    parts.push(`\n**Tokens:** ${total} (in: ${input}, out: ${output})`);
  }

  return parts.join('\n'); // No budget enforcement
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format message body with optional truncation
 */
function formatMessageBody(body: string[], maxChars?: number): string {
  if (body.length === 0) {
    return '*(empty)*';
  }

  const combined = body.join('\n');

  if (maxChars && combined.length > maxChars) {
    return truncateText(combined, maxChars);
  }

  return combined;
}

/**
 * Truncate text to specified length with ellipsis
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Trim session ID for display (keep first 8 chars)
 */
function trimSessionId(sessionId: string): string {
  if (sessionId.length <= 10) {
    return sessionId;
  }
  return `${sessionId.slice(0, 8)}...`;
}

/**
 * Enforce token budget by truncating if necessary
 */
function enforceTokenBudget(content: string, mode: OutputMode): string {
  const budget = TOKEN_BUDGET[mode];
  const maxChars = budget * CHARS_PER_TOKEN;

  if (content.length <= maxChars) {
    return content;
  }

  // Truncate to budget with warning
  const truncated = content.slice(0, maxChars - 50);
  return truncated + '\n\n*[Output truncated to meet token budget]*\n';
}
