/**
 * tmux control-mode client — one `tmux -L genie -C attach -t <session>`
 * connection per ControlSession instance. Emits `output` for every `%output`
 * line, `exit` for `%exit`, `error` for `%error`/spawn failures.
 *
 * Ported from khal-os `packages/genie-app/views/genie/service/tmux-control.ts`
 * (commit 102a501; EPIPE fix 6c50d1d). See PORT-NOTES.md for the diff —
 * notably, this port uses single `-C` instead of khal-os's `-CC` because on
 * Linux tmux 3.5a the latter silently suppresses notifications when stdin is
 * a pipe (iTerm2-integration mode expects terminal-side cooperation).
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as readline from 'node:readline';
import { type ResizeForwarder, createResizeForwarder } from './resize.js';

const DEFAULT_SOCKET = 'genie';
const RECONNECT_DELAY_MS = 1000;

function isOctalDigit(ch: string): boolean {
  return ch >= '0' && ch <= '7';
}

function pushUtf8Bytes(bytes: number[], code: number): void {
  if (code <= 0x7f) {
    bytes.push(code);
  } else if (code <= 0x7ff) {
    bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
  } else if (code <= 0xffff) {
    bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  } else {
    bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
}

/**
 * Decode tmux control-mode `%output` octal escape format.
 * - `\\` → literal backslash
 * - `\ooo` (three octal digits) → byte value
 * - everything else → UTF-8 codepoint
 */
export function decodeOctalEscapes(input: string): Buffer {
  const bytes: number[] = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] === '\\' && i + 1 < input.length) {
      if (input[i + 1] === '\\') {
        bytes.push(0x5c);
        i += 2;
        continue;
      }
      if (
        i + 3 < input.length &&
        isOctalDigit(input[i + 1]) &&
        isOctalDigit(input[i + 2]) &&
        isOctalDigit(input[i + 3])
      ) {
        bytes.push(Number.parseInt(input.substring(i + 1, i + 4), 8));
        i += 4;
        continue;
      }
      bytes.push(input.charCodeAt(i));
      i += 1;
      continue;
    }
    const code = input.codePointAt(i) ?? input.charCodeAt(i);
    pushUtf8Bytes(bytes, code);
    i += code > 0xffff ? 2 : 1;
  }
  return Buffer.from(bytes);
}

export interface ControlSessionOptions {
  /** tmux socket name; defaults to `genie` (the agent server). */
  socketName?: string;
  /** Override the tmux binary path. Defaults to `tmux`. */
  tmuxBin?: string;
  /** Disable the 1 s auto-reconnect loop on process close. */
  autoReconnect?: boolean;
  /** Stand-in spawner for unit tests; defaults to `node:child_process.spawn`. */
  spawnFn?: typeof spawn;
}

/**
 * A control-mode connection to one tmux session on the `-L genie` socket.
 * Streams `%output` per pane, accepts hex-encoded keystrokes, forwards
 * `refresh-client -C` resize hints. Zero linked sessions are created.
 */
export class ControlSession extends EventEmitter {
  private proc: ChildProcess | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectedFlag = false;
  private detachedFlag = false;
  private readonly socketName: string;
  private readonly tmuxBin: string;
  private readonly autoReconnect: boolean;
  private readonly spawnFn: typeof spawn;
  private resizeForwarder: ResizeForwarder | null = null;

  constructor(
    readonly sessionName: string,
    options: ControlSessionOptions = {},
  ) {
    super();
    this.socketName = options.socketName ?? DEFAULT_SOCKET;
    this.tmuxBin = options.tmuxBin ?? 'tmux';
    this.autoReconnect = options.autoReconnect ?? true;
    this.spawnFn = options.spawnFn ?? spawn;
    this.connect();
  }

  get connected(): boolean {
    return this.connectedFlag;
  }

  get detached(): boolean {
    return this.detachedFlag;
  }

  /** Stdin handle for `input.ts` writers. `null` when disconnected. */
  get stdin(): NodeJS.WritableStream | null {
    return this.proc?.stdin ?? null;
  }

  private connect(): void {
    if (this.detachedFlag) return;

    try {
      this.proc = this.spawnFn(this.tmuxBin, ['-L', this.socketName, '-C', 'attach-session', '-t', this.sessionName], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' },
      });
    } catch (err) {
      this.connectedFlag = false;
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // Prevent unhandled EPIPE when tmux exits mid-write (khal-os fix 6c50d1d).
    this.proc.stdin?.on('error', () => {
      /* swallow EPIPE */
    });

    this.proc.on('error', (err) => {
      this.emit('error', err);
    });

    if (!this.proc.stdout) {
      this.emit('error', new Error('tmux control mode: stdout unavailable'));
      return;
    }

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this.handleLine(line));

    this.proc.on('close', (code) => {
      this.connectedFlag = false;
      this.proc = null;
      if (this.autoReconnect && !this.detachedFlag) {
        this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      }
      this.emit('close', code);
    });

    this.connectedFlag = true;
  }

  private handleLine(line: string): void {
    if (!line.startsWith('%')) return;

    if (line.startsWith('%output ')) {
      this.handleOutput(line);
      return;
    }

    if (line.startsWith('%exit')) {
      this.connectedFlag = false;
      this.emit('exit', line.slice(6).trim());
      return;
    }

    if (line.startsWith('%error')) {
      this.emit('error', new Error(line.slice(7).trim() || 'tmux control mode: %error'));
      return;
    }

    // %begin / %end / %session-changed / %window-* — not consumed at this layer.
  }

  private handleOutput(line: string): void {
    // Format: `%output %<pane_id> <octal-encoded data>`
    const afterOutput = line.substring(8); // skip "%output "
    const spaceIdx = afterOutput.indexOf(' ');
    if (spaceIdx === -1) return;

    const paneId = afterOutput.substring(0, spaceIdx);
    const rawData = afterOutput.substring(spaceIdx + 1);
    this.emit('output', paneId, decodeOctalEscapes(rawData));
  }

  /** Bound `Resizer` for this connection. Lazily created. */
  resizer(): ResizeForwarder {
    if (!this.resizeForwarder) {
      this.resizeForwarder = createResizeForwarder(() => this.stdin);
    }
    return this.resizeForwarder;
  }

  /** Detach + clean up. Idempotent. */
  detach(): void {
    this.detachedFlag = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.resizeForwarder) {
      this.resizeForwarder.dispose();
      this.resizeForwarder = null;
    }
    if (this.proc) {
      try {
        this.proc.stdin?.end();
      } catch {
        // already closed
      }
      this.proc.kill();
      this.proc = null;
    }
    this.connectedFlag = false;
    this.removeAllListeners();
  }
}
