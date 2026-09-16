/**
 * The write sink for every human-facing CLI line.
 *
 * `term-color.ts` decides WHETHER a stream may carry colour; this module is
 * where that decision is enforced, once, at the only place the bytes actually
 * leave the process. Command modules compose their lines with plain `\x1b[..m`
 * escapes and hand them to `printOut`/`printErr`; when the destination stream
 * may not carry colour (not a TTY, or `NO_COLOR`/`TERM=dumb`) the escapes are
 * stripped here.
 *
 * Gating at the sink rather than at each call site is deliberate: the
 * 2026-09-15 dogfood found ~110 raw escape literals across eight command
 * modules, every one of them ungated, because a per-call-site gate is a rule
 * every new line has to remember. A sink cannot be forgotten — and it knows
 * which stream the line is going to, which a call site composing a string does
 * not.
 */

import { type ColorStream, colorEnabled, stripAnsi } from './term-color.js';

/** Render `text` for `stream`: unchanged when it may carry colour, stripped otherwise. */
export function renderFor(stream: ColorStream, text: string): string {
  return colorEnabled(stream) ? text : stripAnsi(text);
}

/** Write `text` to stdout verbatim (no trailing newline added), colour-gated. */
export function writeOut(text: string): void {
  process.stdout.write(renderFor('stdout', text));
}

/** Write `text` to stderr verbatim (no trailing newline added), colour-gated. */
export function writeErr(text: string): void {
  process.stderr.write(renderFor('stderr', text));
}

/** `console.log` for stdout, colour-gated. */
export function printOut(line = ''): void {
  writeOut(`${line}\n`);
}

/** `console.error` for stderr, colour-gated. */
export function printErr(line = ''): void {
  writeErr(`${line}\n`);
}

// ─── Broken-pipe guard ───────────────────────────────────────────────────────

/**
 * Whether `error` is the failure a downstream reader causes by closing the pipe
 * early (`genie task status <id> | head -1`).
 *
 * Bun surfaces it as an `EPIPE` error object carrying `errno: -32`; Node's
 * stream layer can also raise `ERR_STREAM_DESTROYED` for a write that lands
 * after the descriptor is gone. Both mean the same thing: nobody is reading any
 * more. Neither is a failure of the work the command already committed.
 */
export function isBrokenPipeError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') return true;
  return (error as { errno?: unknown }).errno === -32 && (error as { syscall?: unknown }).syscall === 'write';
}

/**
 * End the process the way every well-behaved Unix producer ends when its reader
 * goes away: silently, with a success status. The work the command committed
 * (a task claim, a state write) happened before the line that could not be
 * delivered; reporting a non-zero exit would make `genie task checkout <id> |
 * head -1` read as a failed claim on a card that is genuinely in progress.
 *
 * Any still-pending output is dropped on purpose — the destination is gone.
 */
function exitOnBrokenPipe(): never {
  process.exit(0);
}

/**
 * Install the one process-level broken-pipe guard, and return a wrapper that
 * runs the CLI under it.
 *
 * Two delivery routes have to be covered, because Bun uses both:
 *   - the stream `'error'` event (an async write failure; with no listener it
 *     becomes an uncaught exception plus a Bun stack trace and exit 1), and
 *   - a rejection/throw that escapes the command action (a synchronous write).
 *
 * Every other error is re-thrown untouched, so the default diagnostic and exit
 * code of a genuine failure are unchanged.
 */
export async function runUnderBrokenPipeGuard(run: () => Promise<void>): Promise<void> {
  const onStreamError = (error: unknown): void => {
    if (isBrokenPipeError(error)) exitOnBrokenPipe();
    throw error;
  };
  process.stdout.on('error', onStreamError);
  process.stderr.on('error', onStreamError);
  try {
    await run();
  } catch (error) {
    if (!isBrokenPipeError(error)) throw error;
    exitOnBrokenPipe();
  }
}
