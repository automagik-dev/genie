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
