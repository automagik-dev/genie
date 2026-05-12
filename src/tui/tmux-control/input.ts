/**
 * Keystroke writer for the tmux control-mode link.
 *
 * Routes input bytes to the focused pane via `send-keys -H` (hex mode). Long
 * pastes and `;`-bearing payloads fall back to `load-buffer` +
 * `paste-buffer -p` (the same escape hatch khal-os shipped — semicolons in a
 * hex payload race with tmux command-line separators on some versions).
 *
 * Ported from khal-os `packages/genie-app/views/genie/service/tmux-control.ts`
 * (`ControlSession.sendKeys`, commit 102a501). See PORT-NOTES.md.
 */

/**
 * Maximum hex-encoded payload size for the fast path. Larger writes go through
 * the `load-buffer` / `paste-buffer -p` fallback so we don't blast tmux's
 * 4 KiB command-line buffer (`-H` payloads are space-delimited two-char hex —
 * each input byte costs three characters, so 4096 / 3 ≈ 1365 bytes).
 */
export const PASTE_FALLBACK_THRESHOLD_BYTES = 1024;

/** Match the byte that historically tripped tmux's command parser. */
const SEMICOLON_BYTE = 0x3b;

export interface InputWriterDeps {
  /** Stdin of the `tmux -CC attach` child process. */
  stdin: NodeJS.WritableStream | null;
}

/**
 * Encode a UTF-8 string (or buffer) as space-delimited two-digit hex.
 * Exported for tests.
 */
export function encodeHex(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  if (buf.length === 0) return '';
  const out: string[] = new Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i].toString(16).padStart(2, '0');
  }
  return out.join(' ');
}

/**
 * Decide whether a payload should bypass the `send-keys -H` fast path.
 * Heuristic mirrors the khal-os production rule: prefer `paste-buffer -p`
 * once the payload is large OR contains a semicolon byte (tmux 3.5a's
 * command parser splits on `;` in certain quoting contexts; the buffer path
 * is unconditionally safe).
 */
export function shouldUsePasteFallback(data: string | Buffer): boolean {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  if (buf.length >= PASTE_FALLBACK_THRESHOLD_BYTES) return true;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === SEMICOLON_BYTE) return true;
  }
  return false;
}

/** Quote a value for a tmux command-line literal. */
function tmuxQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Encode bytes as a tmux `-b` buffer literal. */
function encodeBufferLiteral(data: Buffer): string {
  let out = '';
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (byte === 0x27) {
      // single quote → close-escape-reopen
      out += `'\\''`;
      continue;
    }
    if (byte >= 0x20 && byte <= 0x7e) {
      out += String.fromCharCode(byte);
      continue;
    }
    // octal escape for everything outside printable ASCII
    out += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return out;
}

/**
 * Send keystrokes to a tmux pane via `send-keys -H` (hex mode).
 * Returns `true` on a successful write, `false` if stdin was unavailable.
 *
 * Long or `;`-bearing payloads transparently fall back to
 * `load-buffer` + `paste-buffer -p`.
 */
export function sendInput(deps: InputWriterDeps, paneId: string, data: string | Buffer): boolean {
  const { stdin } = deps;
  if (
    !stdin ||
    (typeof (stdin as { writable?: boolean }).writable === 'boolean' && !(stdin as { writable?: boolean }).writable)
  ) {
    return false;
  }

  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  if (buf.length === 0) return true;

  if (shouldUsePasteFallback(buf)) {
    return writeViaPasteBuffer(stdin, paneId, buf);
  }

  const hex = encodeHex(buf);
  return stdin.write(`send-keys -H -t ${tmuxQuote(paneId)} ${hex}\n`);
}

/**
 * Explicit `paste-buffer -p` path. Loads the payload into a private buffer
 * and pastes it with `-p` (bracketed paste, if the pane has enabled it).
 * Exposed for callers that already know they want the buffer route
 * (e.g. an OpenTUI paste handler).
 */
export function writeViaPasteBuffer(stdin: NodeJS.WritableStream, paneId: string, data: string | Buffer): boolean {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  const literal = encodeBufferLiteral(buf);
  const command =
    `load-buffer -b genie-tui-paste -- '${literal}'\n` +
    `paste-buffer -p -b genie-tui-paste -t ${tmuxQuote(paneId)} -d\n`;
  return stdin.write(command);
}
