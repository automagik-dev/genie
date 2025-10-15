import fs from 'fs';
import { SessionStore, saveSessions } from '../session-store';
import { ChatMessage, sliceForLatest, sliceForRecent, summarizeCodexMetrics, CodexMetrics } from './transcript-utils';
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
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = lines[i];
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') continue;
      const candidate =
        parsed.session_id ||
        parsed.sessionId ||
        (parsed.session && (parsed.session.id || parsed.session.session_id || parsed.session.sessionId)) ||
        (parsed.data && (parsed.data.session_id || parsed.data.sessionId));
      if (candidate) return candidate;
      if (parsed.type === 'session.created' && parsed.id) {
        return parsed.id;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Parse Codex JSONL events into ChatMessage[] for conversation view.
 * Extracts all message types: reasoning, tool calls, assistant messages.
 */
function parseConversation(jsonl: Array<Record<string, any>>): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const responseBuffers = new Map<string, string>();

  jsonl.forEach((event) => {
    const envelope = event && typeof event === 'object' ? event : {};

    // Handle both wrapped format from genie.ts and raw format
    // Wrapped: { timestamp, type: 'response_item', payload: {...} }
    // Raw: { type, item: {...} }
    const actualEvent = envelope.payload || envelope;
    const explicitType = actualEvent.type;
    const wrapperType = envelope.type;

    // Handle genie.ts wrapped events (agent_message, reasoning, user_message)
    if (wrapperType === 'response_item' || wrapperType === 'agent_message' || wrapperType === 'reasoning' || wrapperType === 'user_message') {
      if (wrapperType === 'agent_message' || (explicitType === 'message' && actualEvent.role === 'assistant')) {
        const content = actualEvent.content;
        if (Array.isArray(content)) {
          const textParts: string[] = [];
          content.forEach((part: any) => {
            if (part.type === 'output_text' && part.text) {
              textParts.push(part.text);
            } else if (part.type === 'input_text' && part.text) {
              textParts.push(part.text);
            } else if (typeof part.text === 'string') {
              textParts.push(part.text);
            }
          });
          if (textParts.length > 0) {
            messages.push({
              role: 'assistant',
              title: 'Assistant',
              body: textParts
            });
          }
        }
        return;
      }

      if (wrapperType === 'reasoning') {
        const content = actualEvent.content;
        if (Array.isArray(content)) {
          const textParts: string[] = [];
          content.forEach((part: any) => {
            if (part.type === 'text' && part.text) {
              textParts.push(part.text);
            } else if (typeof part.text === 'string') {
              textParts.push(part.text);
            }
          });
          if (textParts.length > 0) {
            messages.push({
              role: 'reasoning',
              title: 'Reasoning',
              body: textParts
            });
          }
        }
        return;
      }

      if (wrapperType === 'user_message' || (explicitType === 'message' && actualEvent.role === 'user')) {
        const content = actualEvent.content;
        if (Array.isArray(content)) {
          const textParts: string[] = [];
          content.forEach((part: any) => {
            if (part.type === 'input_text' && part.text) {
              textParts.push(part.text);
            } else if (typeof part.text === 'string') {
              textParts.push(part.text);
            }
          });
          if (textParts.length > 0) {
            messages.push({
              role: 'action',
              title: 'User',
              body: textParts
            });
          }
        }
        return;
      }
    }

    // Handle raw item.completed events (Codex format from raw log)
    if (explicitType === 'item.completed') {
      const item = actualEvent.item || {};
      const text = typeof item.text === 'string' ? item.text.trim() : '';

      switch (item.item_type) {
        case 'assistant_message':
          if (text) {
            messages.push({
              role: 'assistant',
              title: 'Assistant',
              body: [text]
            });
          }
          break;
        case 'reasoning':
          if (text) {
            messages.push({
              role: 'reasoning',
              title: 'Reasoning',
              body: [text]
            });
          }
          break;
        case 'tool_call':
          if (text || item.id) {
            messages.push({
              role: 'tool',
              title: `Tool Call${item.id ? ` (${item.id})` : ''}`,
              body: [text || JSON.stringify(item)]
            });
          }
          break;
        case 'tool_result':
          if (text || item.id) {
            messages.push({
              role: 'tool',
              title: `Tool Result${item.id ? ` (${item.id})` : ''}`,
              body: [text || JSON.stringify(item)]
            });
          }
          break;
        default:
          if (text) {
            messages.push({
              role: 'reasoning',
              title: item.item_type || 'Item',
              body: [text]
            });
          }
      }
      return;
    }

    // Handle streaming response events
    const payload = (actualEvent as any).msg || actualEvent;
    const type = payload && payload.type;

    if (type === 'response.output_text.delta') {
      const responseId = (actualEvent as any).response_id || payload.response_id;
      if (responseId) {
        const delta = (actualEvent as any).delta || payload.delta || '';
        const prev = responseBuffers.get(responseId) || '';
        responseBuffers.set(responseId, prev + delta);
      }
    } else if (type === 'response.output_text.completed' || type === 'response.completed') {
      const responseId = (actualEvent as any).response_id || payload.response_id;
      if (responseId && responseBuffers.has(responseId)) {
        const text = responseBuffers.get(responseId)?.trim();
        if (text) {
          messages.push({
            role: 'assistant',
            title: 'Assistant',
            body: [text]
          });
        }
        responseBuffers.delete(responseId);
      }
    }
  });

  // Flush any remaining buffered responses
  responseBuffers.forEach((text) => {
    const cleaned = text.trim();
    if (cleaned) {
      messages.push({
        role: 'assistant',
        title: 'Assistant',
        body: [cleaned]
      });
    }
  });

  return messages;
}

/**
 * Extract metrics from Codex JSONL events and format for header meta items.
 * Follows Metrics Summarization Specification from wish.
 */
function extractMetrics(jsonl: Array<Record<string, any>>): Array<{ label: string; value: string; tone?: string }> {
  const metrics: Array<{ label: string; value: string; tone?: string }> = [];

  const byCall = new Map<string, { cmd?: string; mcp?: { server?: string; tool?: string } }>();
  const execs: Array<{ exit: number | null | undefined }> = [];
  const mcp: Array<{ server: string; tool: string }> = [];
  const patches = { add: 0, update: 0, move: 0, delete: 0 };
  let tokenInfo: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null = null;
  let rateLimits: any = null;

  jsonl.forEach((event) => {
    const envelope = event && typeof event === 'object' ? event : {};
    // Handle both wrapped format from genie.ts and raw format
    const actualEvent = envelope.payload || envelope;
    const payload = (actualEvent as any).msg || actualEvent;
    const type = payload && payload.type;
    const rate = (actualEvent as any).rate_limits || payload.rate_limits;

    switch (type) {
      case 'exec_command_begin':
        byCall.set(payload.call_id, { cmd: (payload.command || []).join(' ') });
        break;
      case 'exec_command_end': {
        execs.push({ exit: payload.exit_code });
        break;
      }
      case 'mcp_tool_call_begin':
        byCall.set(payload.call_id, { mcp: { server: payload.invocation?.server, tool: payload.invocation?.tool } });
        break;
      case 'mcp_tool_call_end': {
        const rec = byCall.get(payload.call_id) || { mcp: {} };
        mcp.push({ server: rec.mcp?.server || '?', tool: rec.mcp?.tool || '?' });
        break;
      }
      case 'patch_apply_begin': {
        const changes = payload.changes || {};
        Object.values(changes).forEach((chg: any) => {
          if (chg.add) patches.add += 1;
          if (chg.update) {
            patches.update += 1;
            if (chg.update.move_path) patches.move += 1;
          }
          if (chg.delete) patches.delete += 1;
        });
        break;
      }
      case 'token_count': {
        const info = (envelope as any).info || payload.info;
        if (info?.total_token_usage) tokenInfo = info.total_token_usage;
        if (rate) rateLimits = rate;
        break;
      }
      case 'token.usage': {
        if (payload.input_tokens || payload.output_tokens || payload.total_tokens) {
          tokenInfo = {
            input_tokens: payload.input_tokens,
            output_tokens: payload.output_tokens,
            total_tokens: payload.total_tokens || ((payload.input_tokens || 0) + (payload.output_tokens || 0))
          };
        }
        break;
      }
      case 'response.usage': {
        const usage = (envelope as any).usage || payload.usage || payload;
        if (usage) {
          tokenInfo = {
            input_tokens: usage.input_tokens || usage.prompt_tokens || 0,
            output_tokens: usage.output_tokens || usage.completion_tokens || 0,
            total_tokens: usage.total_tokens || usage.usage || ((usage.input_tokens || 0) + (usage.output_tokens || 0))
          };
        }
        break;
      }
    }
  });

  // Tokens metric
  if (tokenInfo) {
    const info: { input_tokens?: number; output_tokens?: number; total_tokens?: number } = tokenInfo;
    const inp = info.input_tokens ?? 0;
    const out = info.output_tokens ?? 0;
    const total = info.total_tokens ?? (inp + out);
    metrics.push({ label: 'Tokens', value: `in:${inp} out:${out} total:${total}` });
  }

  // MCP Calls metric (aggregate, top 2 servers)
  if (mcp.length > 0) {
    const serverCounts = new Map<string, number>();
    mcp.forEach((call) => {
      serverCounts.set(call.server, (serverCounts.get(call.server) || 0) + 1);
    });
    const topServers = Array.from(serverCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);
    const topServerStr = topServers.map(([srv, cnt]) => `${srv}:${cnt}`).join(' ');
    const moreCount = serverCounts.size > 2 ? ` +${serverCounts.size - 2} more` : '';
    metrics.push({ label: 'MCP Calls', value: `${mcp.length} calls (${topServerStr}${moreCount})` });
  }

  // Patches metric
  if (patches.add || patches.update || patches.move || patches.delete) {
    metrics.push({
      label: 'Patches',
      value: `add:${patches.add} update:${patches.update} move:${patches.move} delete:${patches.delete}`
    });
  }

  // Exec Commands metric
  if (execs.length > 0) {
    const okCount = execs.filter((e) => e.exit === 0).length;
    const errCount = execs.filter((e) => e.exit !== 0 && e.exit != null).length;
    metrics.push({
      label: 'Execs',
      value: `${execs.length} commands (${okCount} ok, ${errCount} err)`,
      tone: errCount > 0 ? 'warning' : undefined
    });
  }

  // Rate Limits metric
  if (rateLimits?.primary) {
    const usedPercent = rateLimits.primary.used_percent || 0;
    const resetSecs = rateLimits.primary.resets_in_seconds || 0;
    metrics.push({
      label: 'Rate Limit',
      value: `${usedPercent}% used, resets in ${resetSecs}s`,
      tone: usedPercent > 80 ? 'warning' : undefined
    });
  }

  return metrics;
}

export function buildJsonlView(ctx: JsonlViewContext): string {
  const { render, parsed, paths, store, save } = ctx;
  const { entry, jsonl } = render;

  // Extract session ID from events if needed
  let sessionIdFromEvents: string | null = null;
  jsonl.forEach((event) => {
    const envelope = event && typeof event === 'object' ? event : {};
    // Handle both wrapped format from genie.ts and raw format
    const actualEvent = envelope.payload || envelope;
    const payload = (actualEvent as any).msg || actualEvent;
    const type = payload && payload.type;
    if (type === 'session.created') {
      const found = payload.session_id || payload.sessionId || (payload.session && (payload.session.id || payload.session.session_id || payload.session.sessionId));
      if (found) sessionIdFromEvents = sessionIdFromEvents || found;
    }
  });

  if (sessionIdFromEvents && !entry.sessionId) {
    entry.sessionId = sessionIdFromEvents;
    save(paths, store);
  }

  // Parse conversation from JSONL events
  let allMessages = parseConversation(jsonl);

  // Determine slicing based on mode
  let messages: ChatMessage[];
  let mode: OutputMode = 'recent';

  if (parsed.options.full) {
    // Full mode: show all messages
    messages = allMessages;
    mode = 'overview';
  } else if (parsed.options.live) {
    // Live mode: show latest assistant message (+ optional preceding reasoning)
    messages = sliceForLatest(allMessages);
    mode = 'final';
  } else {
    // Default mode: show last 5 messages
    messages = allMessages.slice(-5);
    mode = 'recent';
  }

  // Extract metrics for header
  const metricsArray = extractMetrics(jsonl);

  // Convert metrics array to SessionMeta format
  const tokens = metricsArray.find(m => m.label === 'Tokens');
  const mcpCalls = metricsArray.find(m => m.label === 'MCP Calls');

  const meta: SessionMeta = {
    sessionId: entry.sessionId || null,
    agent: entry.agent || 'codex',
    status: entry.status || null,
    executor: 'codex',
    tokens: tokens ? parseTokenString(tokens.value) : undefined,
    toolCalls: mcpCalls ? parseMcpCallsString(mcpCalls.value) : undefined
  };

  // Build and return conversation as markdown
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
 * Parse "N calls (server1:M server2:K)" format into tool calls array
 */
function parseMcpCallsString(value: string): Array<{ name: string; count: number }> | undefined {
  const match = value.match(/\(([^)]+)\)/);
  if (!match) return undefined;

  const serversStr = match[1];
  const servers = serversStr.split(' ')
    .filter(s => s.includes(':'))
    .map(s => {
      const [name, count] = s.split(':');
      return { name, count: parseInt(count, 10) };
    });

  return servers.length > 0 ? servers : undefined;
}

export default {
  readSessionIdFromLog,
  extractSessionIdFromContent,
  buildJsonlView
};
