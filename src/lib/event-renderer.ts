/**
 * Event renderer registry — per-kind formatters for streaming event output.
 *
 * Each event type gets its own natural format instead of a rigid table layout.
 * Renderers extract the meaningful fields and format them compactly.
 */

import { color, stripAnsi } from './term-format.js';

interface RenderedEvent {
  /** Icon or prefix (e.g. '💬', colored '→'). */
  indicator: string;
  /** Main content (already colored, can be multi-line). */
  content: string;
  /** Optional context shown dimmed at end (agent, entity). */
  context?: string;
}

// ============================================================================
// Audit event renderers
// ============================================================================

type AuditInput = {
  entity_type: string;
  entity_id: string;
  event_type: string;
  details: Record<string, unknown>;
};

const shortEntity = (id: string): string => id.split(':')[0] ?? id;

const auditRenderers: Record<string, (e: AuditInput) => RenderedEvent> = {
  'sdk.assistant.message': (e) => ({
    indicator: color('brightCyan', '💬'),
    content: color('brightCyan', `"${e.details.textPreview ?? ''}"`),
    context: shortEntity(e.entity_id),
  }),
  'sdk.user.message': (e) => {
    const d = e.details;
    const kind = d.isReplay ? 'replay' : d.isSynthetic ? 'synthetic' : 'turn';
    return {
      indicator: color('cyan', '👤'),
      content: color('dim', `user ${kind}`),
      context: shortEntity(e.entity_id),
    };
  },
  'sdk.hook.started': (e) => ({
    indicator: color('yellow', '🪝'),
    content: `${e.details.hookName ?? '?'} ${color('dim', 'started')}`,
    context: shortEntity(e.entity_id),
  }),
  'sdk.hook.response': (e) => {
    const outcome = e.details.outcome === 'success' ? color('green', '✓') : color('red', '✗');
    return {
      indicator: color('yellow', '🪝'),
      content: `${e.details.hookName ?? '?'} ${outcome}`,
      context: shortEntity(e.entity_id),
    };
  },
  'sdk.system': (e) => {
    const model = String(e.details.model ?? '?').replace(/^claude-/, '');
    const tools = e.details.tools ?? 0;
    return {
      indicator: color('gray', '⚙'),
      content: `init ${color('cyan', model)} · ${tools} tools`,
      context: shortEntity(e.entity_id),
    };
  },
  'sdk.result.success': (e) => {
    const d = e.details;
    const dur = d.durationMs ? formatDuration(d.durationMs as number) : '';
    const cost = typeof d.totalCostUsd === 'number' ? `$${(d.totalCostUsd as number).toFixed(4)}` : '';
    const preview = d.resultPreview ? ` · "${d.resultPreview}"` : '';
    return {
      indicator: color('green', '✨'),
      content: `${color('brightGreen', dur)} · ${color('yellow', cost)}${color('dim', preview)}`,
      context: shortEntity(e.entity_id),
    };
  },
  'sdk.rate_limit': (e) => ({
    indicator: color('gray', '⏱'),
    content: color('dim', `rate limit: ${e.details.status ?? '?'}`),
    context: shortEntity(e.entity_id),
  }),
  'sdk.api.retry': (e) => {
    const d = e.details;
    const attempt = d.attempt ?? '?';
    const max = d.maxRetries ?? '?';
    const delay = d.retryDelayMs ? `${Math.round(d.retryDelayMs as number)}ms` : '';
    return {
      indicator: color('yellow', '↻'),
      content: color('yellow', `retry ${attempt}/${max} · ${d.error ?? '?'}${delay ? ` · ${delay}` : ''}`),
      context: shortEntity(e.entity_id),
    };
  },
  'executor.spawn': (e) => ({
    indicator: color('green', '▶'),
    content: color('green', `spawn ${e.details.source ?? ''}`),
    context: e.entity_id,
  }),
  'executor.terminate': (e) => ({
    indicator: color('yellow', '■'),
    content: color('yellow', `terminate ${e.details.source ?? ''}`),
    context: e.entity_id,
  }),
  'executor.deliver': (e) => {
    const d = e.details;
    const dur = d.durationMs ? formatDuration(d.durationMs as number) : '';
    const tokens = d.tokens as { input?: number; output?: number } | undefined;
    const tokStr = tokens ? `${tokens.input ?? 0}→${tokens.output ?? 0}` : '';
    const parts = [dur, tokStr].filter(Boolean);
    return {
      indicator: color('blue', '→'),
      content: parts.join(' · '),
      context: e.entity_id,
    };
  },
  'task.error': (e) => ({
    indicator: color('red', '✗'),
    content: color('red', String(e.details.error ?? 'unknown error')),
    context: e.entity_id,
  }),
  command_success: (e) => ({
    indicator: color('dim', '·'),
    content: color('dim', `${e.details.duration_ms ?? 0}ms`),
    context: e.entity_id,
  }),
};

/** Render an audit event into a formatted line. */
export function renderAuditEvent(input: AuditInput): RenderedEvent {
  const renderer = auditRenderers[input.event_type];
  if (renderer) return renderer(input);

  // Fallback: generic format with compact JSON
  const json = JSON.stringify(input.details);
  return {
    indicator: color('dim', '○'),
    content: `${color('gray', input.event_type)} ${json === '{}' ? '' : color('dim', json)}`,
    context: `${input.entity_type}:${input.entity_id}`,
  };
}

// ============================================================================
// Runtime event renderers
// ============================================================================

type RuntimeInput = {
  kind: string;
  agent: string;
  team?: string;
  text: string;
};

const runtimeRenderers: Record<string, (e: RuntimeInput) => RenderedEvent> = {
  user: (e) => ({
    indicator: color('brightCyan', '👤'),
    content: e.text,
    context: e.agent,
  }),
  assistant: (e) => ({
    indicator: color('cyan', '🤖'),
    content: color('cyan', e.text),
    context: e.agent,
  }),
  message: (e) => ({
    indicator: color('magenta', '✉'),
    content: e.text,
    context: e.agent,
  }),
  tool_call: (e) => ({
    indicator: color('yellow', '🔧'),
    content: color('yellow', e.text),
    context: e.agent,
  }),
  tool_result: (e) => ({
    indicator: color('gray', '⮐'),
    content: color('dim', e.text),
    context: e.agent,
  }),
  state: (e) => ({
    indicator: color('gray', '◉'),
    content: color('dim', e.text),
    context: e.agent,
  }),
  system: (e) => ({
    indicator: color('gray', '⚙'),
    content: color('dim', e.text),
    context: e.agent,
  }),
  qa: (e) => ({
    indicator: color('magenta', '🧪'),
    content: e.text,
    context: e.agent,
  }),
};

/** Render a runtime event into a formatted line. */
export function renderRuntimeEvent(input: RuntimeInput): RenderedEvent {
  const renderer = runtimeRenderers[input.kind];
  if (renderer) return renderer(input);

  return {
    indicator: color('dim', '○'),
    content: `${color('gray', input.kind)} ${input.text}`,
    context: input.agent,
  };
}

// ============================================================================
// Layout
// ============================================================================

/**
 * Format a rendered event as a single printable line (or multi-line if wrapped).
 *
 * Layout: `TIME  ICON  CONTENT                                 CONTEXT`
 * - Time is fixed-width (8 chars HH:MM:SS)
 * - Icon is single-width after time
 * - Content takes most of the space, wrapped across lines if needed
 * - Context is dimmed, right-aligned on the first line only
 */
export function formatEventLine(timeStr: string, rendered: RenderedEvent): string {
  const termWidth = process.stdout.columns || 120;

  const timeCol = color('gray', timeStr);
  const timeWidth = stripAnsi(timeCol).length;
  const iconWidth = stripAnsi(rendered.indicator).length;

  // 2 spaces after time, 2 spaces after icon, 2 spaces before context
  const prefixWidth = timeWidth + 2 + iconWidth + 2;

  const contextStr = rendered.context ? color('dim', rendered.context) : '';
  const contextWidth = contextStr ? stripAnsi(contextStr).length + 2 : 0;

  const contentWidth = Math.max(20, termWidth - prefixWidth - contextWidth);
  const content = stripAnsi(rendered.content).replace(/[\r\n]+/g, ' ');

  // If content fits on first line, single-line layout
  if (content.length <= contentWidth) {
    const paddedContent = padToWidth(rendered.content, contentWidth);
    return `${timeCol}  ${rendered.indicator}  ${paddedContent}${contextStr ? `  ${contextStr}` : ''}`;
  }

  // Multi-line: first line has content + context, continuation lines indented
  const chunks = wrapText(content, contentWidth);
  const indent = ' '.repeat(prefixWidth);
  const firstLine = `${timeCol}  ${rendered.indicator}  ${padToWidth(chunks[0], contentWidth)}${contextStr ? `  ${contextStr}` : ''}`;
  const rest = chunks.slice(1).map((c) => `${indent}${c}`);
  return [firstLine, ...rest].join('\n');
}

function padToWidth(coloredText: string, width: number): string {
  const visible = stripAnsi(coloredText).length;
  const pad = Math.max(0, width - visible);
  return coloredText + ' '.repeat(pad);
}

function wrapText(text: string, width: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > width) {
    let breakAt = remaining.lastIndexOf(' ', width);
    if (breakAt <= 0 || breakAt < width / 2) breakAt = width;
    chunks.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}
