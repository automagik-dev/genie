import type { CLIOptions } from './types';

/**
 * emitView - Token-efficient markdown output (replaces Ink rendering)
 *
 * This helper now outputs markdown directly to stdout instead of using Ink.
 * The function signature is preserved for backwards compatibility.
 *
 * @deprecated - Commands should use formatTranscriptMarkdown directly instead
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
