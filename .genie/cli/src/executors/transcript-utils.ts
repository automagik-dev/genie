/**
 * Shared Transcript Utilities for Log Viewers
 *
 * Provides common functionality for parsing conversations, extracting metrics,
 * and slicing message arrays for both Codex and Claude executors.
 */

// ============================================================================
// Types
// ============================================================================

export type ChatRole = 'assistant' | 'reasoning' | 'tool' | 'action';

export interface ChatMessage {
  role: ChatRole;
  title: string;
  body: string[];
}

// ============================================================================
// Message Slicing Utilities
// ============================================================================

/**
 * Slice messages to show only the latest assistant message plus any
 * immediately preceding reasoning messages.
 *
 * Used for --live mode to show just the most recent output.
 *
 * @param messages - Full array of chat messages in temporal order
 * @returns Sliced array containing latest assistant + optional preceding reasoning
 */
export function sliceForLatest(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.length) return [];

  // Find the last assistant message
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIndex = i;
      break;
    }
  }

  // If no assistant message found, return empty
  if (lastAssistantIndex === -1) return [];

  // Find the start index by including preceding reasoning messages
  let startIndex = lastAssistantIndex;
  for (let i = lastAssistantIndex - 1; i >= 0; i--) {
    if (messages[i].role === 'reasoning') {
      startIndex = i;
    } else {
      // Stop at the first non-reasoning message
      break;
    }
  }

  return messages.slice(startIndex);
}

/**
 * Slice messages to show the last N messages (default 5).
 *
 * Used for default mode to show recent conversation context.
 * No filtering by message type - includes reasoning, tool, assistant, user, etc.
 *
 * @param messages - Full array of chat messages in temporal order
 * @param count - Number of messages to show (default: 5)
 * @returns Last N messages
 */
export function sliceForRecent(messages: ChatMessage[], count: number = 5): ChatMessage[] {
  if (!messages.length) return [];
  return messages.slice(-count);
}

// ============================================================================
// Metrics Extraction & Summarization
// ============================================================================

export interface MetricItem {
  label: string;
  value: string;
  tone?: string; // Optional tone indicator (not used in markdown output)
}

/**
 * Codex metrics extracted from JSONL events
 */
export interface CodexMetrics {
  tokens: { input: number; output: number; total: number } | null;
  mcpCalls: Array<{ server: string; tool: string; secs: number }>;
  patches: { add: number; update: number; move: number; delete: number };
  execs: Array<{ cmd: string; exit: number | null; dur?: { secs: number; nanos?: number } }>;
  rateLimits: { used_percent?: number; resets_in_seconds?: number } | null;
}

/**
 * Claude metrics extracted from JSONL events
 */
export interface ClaudeMetrics {
  tokens: { input: number; output: number; total: number } | null;
  toolCalls: Array<{ name: string; count: number }>;
  model: string | null;
}

/**
 * Summarize Codex metrics into header-friendly meta items.
 *
 * Format: concise single-line strings (<100 chars per value)
 *
 * @param metrics - Extracted Codex metrics
 * @returns Array of meta items for header display
 */
export function summarizeCodexMetrics(metrics: CodexMetrics): MetricItem[] {
  const items: MetricItem[] = [];

  // Tokens
  if (metrics.tokens) {
    const { input, output, total } = metrics.tokens;
    items.push({
      label: 'Tokens',
      value: `in:${input} out:${output} total:${total}`
    });
  }

  // MCP Calls (aggregate by server)
  if (metrics.mcpCalls.length > 0) {
    const serverCounts = new Map<string, number>();
    metrics.mcpCalls.forEach((call) => {
      const count = serverCounts.get(call.server) || 0;
      serverCounts.set(call.server, count + 1);
    });

    const sorted = Array.from(serverCounts.entries())
      .sort((a, b) => b[1] - a[1]);

    const top2 = sorted.slice(0, 2);
    const remaining = sorted.length - 2;

    const summary = top2.map(([server, count]) => `${server}:${count}`).join(' ');
    const suffix = remaining > 0 ? ` +${remaining} more` : '';

    items.push({
      label: 'MCP Calls',
      value: `${metrics.mcpCalls.length} calls (${summary}${suffix})`
    });
  }

  // Patches
  const { add, update, move, delete: del } = metrics.patches;
  if (add || update || move || del) {
    items.push({
      label: 'Patches',
      value: `add:${add} update:${update} move:${move} delete:${del}`
    });
  }

  // Exec Commands
  if (metrics.execs.length > 0) {
    const okCount = metrics.execs.filter((e) => e.exit === 0).length;
    const errCount = metrics.execs.filter((e) => e.exit !== 0 && e.exit != null).length;
    items.push({
      label: 'Execs',
      value: `${metrics.execs.length} commands (${okCount} ok, ${errCount} err)`,
      tone: errCount > 0 ? 'warning' : undefined
    });
  }

  // Rate Limits
  if (metrics.rateLimits) {
    const percent = Math.round(metrics.rateLimits.used_percent || 0);
    const resetSec = Math.round(metrics.rateLimits.resets_in_seconds || 0);
    items.push({
      label: 'Rate Limit',
      value: `${percent}% used, resets in ${resetSec}s`,
      tone: percent > 80 ? 'warning' : undefined
    });
  }

  return items;
}

/**
 * Summarize Claude metrics into header-friendly meta items.
 *
 * Format: concise single-line strings (<100 chars per value)
 *
 * @param metrics - Extracted Claude metrics
 * @returns Array of meta items for header display
 */
export function summarizeClaudeMetrics(metrics: ClaudeMetrics): MetricItem[] {
  const items: MetricItem[] = [];

  // Tokens
  if (metrics.tokens) {
    const { input, output, total } = metrics.tokens;
    items.push({
      label: 'Tokens',
      value: `in:${input} out:${output} total:${total}`
    });
  }

  // Tool Calls
  if (metrics.toolCalls.length > 0) {
    const sorted = [...metrics.toolCalls].sort((a, b) => b.count - a.count);
    const top2 = sorted.slice(0, 2);
    const remaining = sorted.length - 2;

    const totalCalls = metrics.toolCalls.reduce((sum, tc) => sum + tc.count, 0);
    const summary = top2.map((tc) => `${tc.name}:${tc.count}`).join(' ');
    const suffix = remaining > 0 ? ` +${remaining} more` : '';

    items.push({
      label: 'Tool Calls',
      value: `${totalCalls} calls (${summary}${suffix})`
    });
  }

  // Model
  if (metrics.model) {
    items.push({
      label: 'Model',
      value: metrics.model
    });
  }

  return items;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Aggregate tool calls by name for Claude metrics
 */
export function aggregateToolCalls(toolCalls: Array<{ name: string }>): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();

  toolCalls.forEach((call) => {
    const count = counts.get(call.name) || 0;
    counts.set(call.name, count + 1);
  });

  return Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
}

// ============================================================================
// Transcript Building from Events
// ============================================================================

/**
 * Build a transcript of ChatMessages from an array of executor events.
 *
 * Supports both Codex session file format (response_item) and CLI streaming format (item.completed).
 * Also handles shell commands, MCP tool calls, and other event types.
 *
 * @param events - Array of JSONL event objects from executor logs
 * @returns Array of ChatMessages suitable for display
 */
export function buildTranscriptFromEvents(events: Array<Record<string, any>>): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const commandIndex = new Map<string, number>();
  const toolIndex = new Map<string, number>();

  const pushMessage = (message: ChatMessage): number => {
    messages.push({
      ...message,
      body: message.body.filter((line) => Boolean(line?.trim()))
    });
    return messages.length - 1;
  };

  events.forEach((event) => {
    if (!event || typeof event !== 'object') return;
    const type = String(event.type || '').toLowerCase();

    // Handle codex session file format (response_item with payload)
    if (type === 'response_item') {
      const payload = (event as any).payload;
      if (payload && payload.type === 'message') {
        // Map payload roles to ChatRole types
        const payloadRole = payload.role;
        const role: 'assistant' | 'reasoning' | 'tool' | 'action' =
          payloadRole === 'assistant' ? 'assistant' :
          payloadRole === 'user' ? 'action' :
          'reasoning';
        const title = payloadRole === 'assistant' ? 'Assistant' :
                     payloadRole === 'user' ? 'User' : 'System';

        const content = payload.content;
        if (Array.isArray(content)) {
          const textParts: string[] = [];
          content.forEach((part: any) => {
            if (part.type === 'text' && part.text) {
              textParts.push(part.text);
            } else if (part.type === 'input_text' && part.text) {
              textParts.push(part.text);
            } else if (part.type === 'output_text' && part.text) {
              textParts.push(part.text);
            }
          });
          if (textParts.length > 0) {
            pushMessage({ role, title, body: textParts });
          }
        } else if (typeof content === 'string' && content.trim()) {
          pushMessage({ role, title, body: [content] });
        }
      }
      return;
    }

    // Handle CLI streaming format (item.completed)
    if (type === 'item.completed') {
      const item = (event as any).item || {};
      const itemType = String(item.item_type || '').toLowerCase();
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      if (!text) return;
      if (itemType === 'assistant_message') {
        pushMessage({ role: 'assistant', title: 'Assistant', body: [text] });
      } else if (itemType === 'reasoning') {
        pushMessage({ role: 'reasoning', title: 'Reasoning', body: [text] });
      } else if (itemType === 'tool_call') {
        const header = item.tool_name || item.tool || 'Tool call';
        const idx = pushMessage({ role: 'tool', title: header, body: [text] });
        if (item.id) toolIndex.set(item.id, idx);
      } else if (itemType === 'tool_result') {
        const header = item.tool_name || item.tool || 'Tool result';
        const idx = item.id && toolIndex.has(item.id)
          ? toolIndex.get(item.id)!
          : pushMessage({ role: 'tool', title: header, body: [] });
        messages[idx].body.push(text);
      } else {
        pushMessage({ role: 'reasoning', title: itemType || 'Item', body: [text] });
      }
      return;
    }

    const payload = (event as any).msg || event;
    const callId = payload?.call_id || payload?.callId || null;

    switch (type) {
      case 'exec_command_begin': {
        const command = Array.isArray(payload?.command) ? payload.command.join(' ') : payload?.command || '(unknown)';
        const cwd = payload?.cwd ? `cwd: ${payload.cwd}` : null;
        const idx = pushMessage({
          role: 'action',
          title: 'Shell command',
          body: [`$ ${command}`, cwd || undefined].filter(Boolean) as string[]
        });
        if (callId) commandIndex.set(callId, idx);
        break;
      }
      case 'exec_command_end': {
        if (!callId || !commandIndex.has(callId)) break;
        const idx = commandIndex.get(callId)!;
        const exit = payload?.exit_code;
        const duration = payload?.duration?.secs != null ? `${payload.duration.secs}s` : null;
        const line = `→ exit ${exit ?? 'unknown'}${duration ? ` (${duration})` : ''}`;
        messages[idx].body.push(line);
        break;
      }
      case 'mcp_tool_call_begin': {
        const server = payload?.invocation?.server;
        const tool = payload?.invocation?.tool || 'MCP tool';
        const idx = pushMessage({
          role: 'tool',
          title: 'MCP call',
          body: [`${tool}${server ? ` @ ${server}` : ''}`]
        });
        if (callId) toolIndex.set(callId, idx);
        break;
      }
      case 'mcp_tool_call_end': {
        if (!callId || !toolIndex.has(callId)) break;
        const idx = toolIndex.get(callId)!;
        const duration = payload?.duration?.secs != null ? `${payload.duration.secs}s` : null;
        messages[idx].body.push(`→ completed${duration ? ` in ${duration}` : ''}`);
        break;
      }
      default:
        break;
    }
  });

  return messages;
}