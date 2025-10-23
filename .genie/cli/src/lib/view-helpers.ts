import type { CLIOptions } from './types';

/**
 * emitView - Token-efficient markdown output (replaces Ink rendering)
 *
 * This helper now outputs markdown directly to stdout instead of using Ink.
 * The function signature is preserved for backwards compatibility.
 *
 * @deprecated Use `formatTranscriptMarkdown()` from `./markdown-formatter.js` instead.
 * 
 * **Why deprecated:**
 * This function was designed as a simple output wrapper but lacks the flexibility
 * needed for modern AI-to-AI orchestration scenarios. The new `formatTranscriptMarkdown()`
 * provides:
 * - Multiple output modes (final, recent, overview, full)
 * - Token budget management for efficient orchestration
 * - Rich metadata support (session info, token metrics, tool usage)
 * - Structured message formatting
 * 
 * **Migration Guide:**
 * 
 * For simple string output, use direct stream writing:
 * ```typescript
 * // Before
 * await emitView('Task completed', options);
 * 
 * // After
 * process.stdout.write('Task completed\n');
 * ```
 * 
 * For structured transcript output, use formatTranscriptMarkdown():
 * ```typescript
 * // Before
 * await emitView(statusText, options);
 * 
 * // After
 * import { formatTranscriptMarkdown } from './markdown-formatter.js';
 * import type { ChatMessage, SessionMeta } from './markdown-formatter.js';
 * 
 * const messages: ChatMessage[] = [
 *   { role: 'assistant', title: 'Task completed', body: ['All tests passing'] }
 * ];
 * const meta: SessionMeta = {
 *   sessionId: 'abc-123',
 *   agent: 'implementor',
 *   status: 'completed'
 * };
 * const output = formatTranscriptMarkdown(messages, meta, 'final');
 * process.stdout.write(output + '\n');
 * ```
 * 
 * **For complete migration guide, see:** `docs/markdown-output-guide.md`
 * 
 * **Differences in behavior:**
 * - `emitView()`: Simple string output, no structure or metadata
 * - `formatTranscriptMarkdown()`: Structured messages with rich metadata and multiple output modes
 * - `emitView()`: Single output format
 * - `formatTranscriptMarkdown()`: 4 modes (final/recent/overview/full) with token budgets
 * 
 * @see {@link formatTranscriptMarkdown} in ./markdown-formatter.js
 * @see docs/markdown-output-guide.md for detailed migration guide
 */
export async function emitView(
  content: string,
  options: CLIOptions,
  opts: { stream?: NodeJS.WriteStream; forceJson?: boolean } = {}
): Promise<void> {
  const stream = opts.stream || process.stdout;

  if (opts.forceJson) {
    // JSON output mode (rare, but supported)
    stream.write(JSON.stringify({ content }, null, 2));
    stream.write('\n');
  } else {
    // Markdown output (default)
    stream.write(content);
    stream.write('\n');
  }
}

export type EmitView = typeof emitView;
