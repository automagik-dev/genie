import fs from 'fs';
import { SessionStore, saveSessions } from '../session-store';
import { ChatMessage, sliceForLatest, sliceForRecent, summarizeClaudeMetrics, ClaudeMetrics, aggregateToolCalls } from './transcript-utils';
import { formatTranscriptMarkdown, OutputMode, SessionMeta } from '../lib/markdown-formatter';

export interface RenderOptions {
  entry: Record<string, any>;
  jsonl: Array<Record<string, any>>;
  raw: string;
}

export interface JsonlViewContext {
  render: RenderOptions;
  parsed: any;
  paths: any;
  store: SessionStore;
  save: typeof saveSessions;
  formatPathRelative: (targetPath: string, baseDir: string) => string;
}

export function readSessionIdFromLog(logFile: string): string | null {
  if (!logFile) return null;
  try {
    const content = fs.readFileSync(logFile, 'utf8');
    return extractSessionIdFromContent(content);
  } catch {
    return null;
  }
}

export function extractSessionIdFromContent(content: string | string[]): string | null {
  const lines = Array.isArray(content) ? content : String(content).split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') continue;
      if (parsed.type === 'system' && parsed.session_id) {
        return parsed.session_id;
      }
      if (parsed.session_id) {
        return parsed.session_id;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Parse Claude JSONL events into ChatMessage[] for conversation view.
 * Extracts all message types: assistant, user, reasoning, tool calls/results.
 */
function parseConversation(jsonl: Array<Record<string, any>>): ChatMessage[] {
  const messages: ChatMessage[] = [];

  jsonl.forEach((event) => {
    if (!event || typeof event !== 'object') return;

    if (event.type === 'assistant' && event.message?.content) {
      const content = event.message.content;
      if (!Array.isArray(content)) return;

      const textParts: string[] = [];
      const toolCalls: string[] = [];

      content.forEach((item: any) => {
        if (item.type === 'text' && item.text) {
          textParts.push(item.text.trim());
        } else if (item.type === 'tool_use') {
          const toolName = item.name || 'unknown';
          const toolInput = JSON.stringify(item.input || {}, null, 2);
          const toolId = item.id ? ` (${item.id})` : '';
          toolCalls.push(`${toolName}${toolId}\n${toolInput}`);
        }
      });

      if (textParts.length > 0) {
        messages.push({
          role: 'assistant',
          title: 'Assistant',
          body: textParts
        });
      }

      if (toolCalls.length > 0) {
        messages.push({
          role: 'tool',
          title: `Tool Call${toolCalls.length > 1 ? 's' : ''}`,
          body: toolCalls
        });
      }
      return;
    }

    if (event.type === 'user' && event.message?.content) {
      const content = event.message.content;
      if (!Array.isArray(content)) return;

      const textParts: string[] = [];
      const toolResults: string[] = [];

      content.forEach((item: any) => {
        if (item.type === 'text' && item.text) {
          textParts.push(item.text.trim());
        } else if (item.type === 'tool_result') {
          const toolId = item.tool_use_id ? ` [${item.tool_use_id}]` : '';
          const resultContent = typeof item.content === 'string' ? item.content : JSON.stringify(item.content, null, 2);
          toolResults.push(`${toolId}\n${resultContent}`);
        }
      });

      if (textParts.length > 0) {
        messages.push({
          role: 'action',
          title: 'User',
          body: textParts
        });
      }

      if (toolResults.length > 0) {
        messages.push({
          role: 'tool',
          title: `Tool Result${toolResults.length > 1 ? 's' : ''}`,
          body: toolResults
        });
      }
      return;
    }

    if (event.type === 'result' && event.result) {
      const resultText = typeof event.result === 'string' ? event.result : JSON.stringify(event.result, null, 2);
      messages.push({
        role: 'assistant',
        title: 'Final Result',
        body: [resultText]
      });
      return;
    }
  });

  return messages;
}

/**
 * Extract metrics from Claude JSONL events and format for header meta items.
 * Follows Metrics Summarization Specification from wish.
 */
function extractMetrics(jsonl: Array<Record<string, any>>): Array<{ label: string; value: string; tone?: string }> {
  const metrics: Array<{ label: string; value: string; tone?: string }> = [];

  type TokenInfo = { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  let tokenInfo: TokenInfo | null = null;
  let model: string | null = null;
  const toolCallCounts = new Map<string, number>();

  jsonl.forEach((event) => {
    if (!event || typeof event !== 'object') return;

    if (event.type === 'system' && event.model) {
      model = event.model;
      return;
    }

    if (event.type === 'assistant' && event.message?.content) {
      const content = event.message.content;
      if (Array.isArray(content)) {
        content.forEach((item: any) => {
          if (item.type === 'tool_use' && item.name) {
            const toolName = item.name;
            toolCallCounts.set(toolName, (toolCallCounts.get(toolName) || 0) + 1);
          }
        });
      }
      return;
    }

    if (event.type === 'result' && event.usage) {
      tokenInfo = {
        input_tokens: event.usage.input_tokens || 0,
        output_tokens: event.usage.output_tokens || 0,
        total_tokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0)
      };
      return;
    }
  });

  if (tokenInfo) {
    const info: TokenInfo = tokenInfo;
    const inp = info.input_tokens ?? 0;
    const out = info.output_tokens ?? 0;
    const total = info.total_tokens ?? (inp + out);
    metrics.push({ label: 'Tokens', value: `in:${inp} out:${out} total:${total}` });
  }

  if (toolCallCounts.size > 0) {
    const totalCalls = Array.from(toolCallCounts.values()).reduce((sum, count) => sum + count, 0);
    const topTools = Array.from(toolCallCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);
    const topToolsStr = topTools.map(([tool, count]) => `${tool}:${count}`).join(' ');
    const moreCount = toolCallCounts.size > 2 ? ` +${toolCallCounts.size - 2} more` : '';
    metrics.push({ label: 'Tool Calls', value: `${totalCalls} calls (${topToolsStr}${moreCount})` });
  }

  if (model) {
    metrics.push({ label: 'Model', value: model });
  }

  return metrics;
}

export function buildJsonlView(ctx: JsonlViewContext): string {
  const { render, parsed, paths, store, save } = ctx;
  const { entry, jsonl } = render;

  let sessionIdFromEvents: string | null = null;
  jsonl.forEach((event) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'system' && event.session_id) {
      sessionIdFromEvents = sessionIdFromEvents || event.session_id;
    }
  });

  if (sessionIdFromEvents && !entry.sessionId) {
    entry.sessionId = sessionIdFromEvents;
    save(paths, store);
  }

  let allMessages = parseConversation(jsonl);

  let messages: ChatMessage[];
  let mode: OutputMode = 'recent';

  if (parsed.options.full) {
    messages = allMessages;
    mode = 'overview';
  } else if (parsed.options.live) {
    messages = sliceForLatest(allMessages);
    mode = 'final';
  } else {
    messages = allMessages.slice(-5);
    mode = 'recent';
  }

  const metricsArray = extractMetrics(jsonl);

  // Convert metrics array to SessionMeta format
  const tokens = metricsArray.find(m => m.label === 'Tokens');
  const model = metricsArray.find(m => m.label === 'Model');
  const toolCalls = metricsArray.find(m => m.label === 'Tool Calls');

  const meta: SessionMeta = {
    sessionId: entry.sessionId || null,
    agent: entry.agent || 'claude',
    status: entry.status || null,
    executor: 'claude',
    model: model?.value || undefined,
    tokens: tokens ? parseTokenString(tokens.value) : undefined,
    toolCalls: toolCalls ? parseToolCallsString(toolCalls.value) : undefined
  };

  return formatTranscriptMarkdown(messages, meta, mode);
}

/**
 * Parse "in:X out:Y total:Z" format into token object
 */
function parseTokenString(value: string): { input: number; output: number; total: number } | undefined {
  const match = value.match(/in:(\d+) out:(\d+) total:(\d+)/);
  if (!match) return undefined;
  return {
    input: parseInt(match[1], 10),
    output: parseInt(match[2], 10),
    total: parseInt(match[3], 10)
  };
}

/**
 * Parse "N calls (tool1:M tool2:K)" format into tool calls array
 */
function parseToolCallsString(value: string): Array<{ name: string; count: number }> | undefined {
  const match = value.match(/\(([^)]+)\)/);
  if (!match) return undefined;

  const toolsStr = match[1];
  const tools = toolsStr.split(' ')
    .filter(t => t.includes(':'))
    .map(t => {
      const [name, count] = t.split(':');
      return { name, count: parseInt(count, 10) };
    });

  return tools.length > 0 ? tools : undefined;
}


export default {
  readSessionIdFromLog,
  extractSessionIdFromContent,
  buildJsonlView
};