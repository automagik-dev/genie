/**
 * One gate for every ANSI escape genie writes.
 *
 * Colour is a property of the DESTINATION STREAM, not of the process: a run
 * whose stdout is a TTY but whose stderr is a pipe (`genie task create 2>err`)
 * must colour stdout and leave stderr plain. The 2026-09-15 dogfood found the
 * commander error path writing the same red escape in every case, so a piped
 * or redirected diagnostic carried `\x1b[31m` into log files and CI output and
 * neither `NO_COLOR` nor `TERM=dumb` changed anything.
 *
 * The rules, in precedence order:
 *   1. `NO_COLOR` set to anything (https://no-color.org) — never colour.
 *   2. `TERM=dumb` — never colour; the terminal cannot render the escapes.
 *   3. `FORCE_COLOR` set to anything but `0` — always colour (CI renderers).
 *   4. otherwise — colour only when THAT stream is a TTY.
 *
 * Evaluated per call, never cached at module load: tests (and `genie update`,
 * which re-executes in-process) change `NO_COLOR`/`TERM` after import.
 */

export type ColorStream = 'stdout' | 'stderr';

/** Whether ANSI escapes may be written to `stream` right now. */
export function colorEnabled(stream: ColorStream = 'stdout'): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.TERM === 'dumb') return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '' && force !== '0') return true;
  return Boolean(stream === 'stderr' ? process.stderr.isTTY : process.stdout.isTTY);
}

/**
 * Wrap `text` in `open`…`\x1b[0m` when `stream` may carry colour, otherwise
 * return it untouched. `open` may be several escapes (`'\x1b[1m\x1b[33m'`).
 */
export function colorizeFor(stream: ColorStream, open: string, text: string): string {
  return colorEnabled(stream) ? `${open}${text}\x1b[0m` : text;
}

/** Strip every CSI/SGR escape from `text` — for plain-text sinks and tests. */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point.
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}
