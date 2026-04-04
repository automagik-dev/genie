/**
 * SDKMessage Streaming Formatter
 *
 * Formats SDKMessages for real-time streaming output.
 * Supports text (human-readable), JSON (pretty), and NDJSON (machine-piping).
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export type StreamFormat = 'text' | 'json' | 'ndjson';

/**
 * Format an SDKMessage for streaming output.
 *
 * - 'text': Human-readable output -- assistant text, tool summaries, errors
 * - 'json': Pretty-printed JSON per message
 * - 'ndjson': One JSON object per line (for piping)
 *
 * Returns null when the message should be skipped (e.g. non-text types in text mode).
 */
export function formatSdkMessage(msg: SDKMessage, format: StreamFormat): string | null {
  switch (format) {
    case 'text':
      return formatText(msg);
    case 'json':
      return JSON.stringify(msg, null, 2);
    case 'ndjson':
      return JSON.stringify(msg);
  }
}

// ============================================================================
// Text formatter — human-readable streaming output
// ============================================================================

function formatText(msg: SDKMessage): string | null {
  switch (msg.type) {
    case 'assistant':
      return formatAssistant(msg);
    case 'stream_event':
      return formatStreamEvent(msg);
    case 'result':
      return formatResult(msg);
    case 'tool_progress':
      return `[${msg.tool_name}] progress... (${msg.elapsed_time_seconds}s)\n`;
    case 'tool_use_summary':
      return `[tool] ${msg.summary}\n`;
    case 'system':
      return formatSystem(msg);
    default:
      return null;
  }
}

function formatAssistant(msg: SDKMessage & { type: 'assistant' }): string | null {
  const parts: string[] = [];
  const content = msg.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        parts.push(block.text);
      } else if (block.type === 'tool_use') {
        const toolBlock = block as { type: 'tool_use'; name?: string };
        parts.push(`[using ${toolBlock.name ?? 'tool'}]`);
      }
    }
  }
  if (msg.error) {
    parts.push(`\x1b[31m[error: ${msg.error}]\x1b[0m`);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function formatStreamEvent(msg: SDKMessage & { type: 'stream_event' }): string | null {
  const event = msg.event;
  if (event.type === 'content_block_delta') {
    const delta = (event as { type: 'content_block_delta'; delta: { type: string; text?: string } }).delta;
    if (delta.type === 'text_delta' && delta.text) {
      return delta.text;
    }
  }
  return null;
}

function formatResult(msg: SDKMessage & { type: 'result' }): string {
  if (msg.subtype === 'success') {
    const success = msg as {
      subtype: 'success';
      result: string;
      num_turns: number;
      total_cost_usd: number;
      usage: { input_tokens: number; output_tokens: number };
    };
    const lines = ['\n--- Result ---'];
    if (success.result) lines.push(success.result);
    lines.push(
      `Turns: ${success.num_turns} | Cost: $${success.total_cost_usd.toFixed(4)} | Tokens: ${success.usage.input_tokens}in/${success.usage.output_tokens}out`,
    );
    return `${lines.join('\n')}\n`;
  }
  // Error result
  const error = msg as { subtype: string; errors?: string[] };
  const errMsg = Array.isArray(error.errors) && error.errors.length > 0 ? error.errors.join('; ') : error.subtype;
  return `\x1b[31m\n--- Error ---\n${errMsg}\x1b[0m\n`;
}

function formatSystem(msg: SDKMessage & { type: 'system' }): string | null {
  const rec = msg as unknown as Record<string, unknown>;
  if (rec.subtype === 'status' && rec.status) {
    return `[status] ${rec.status}\n`;
  }
  return null;
}
