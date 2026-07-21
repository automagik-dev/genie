// pty-session.ts — the PTY boundary. Nothing above this module knows about node-pty.
//
// PtySession        : one real terminal (spawn/write/resize/kill) + a TerminalMirror
//                     (headless xterm) so a late-joining or reconnecting client can
//                     replay the exact screen state — the salvaged snapshot engine
//                     replacing fresh's 256 KB raw-byte ring (design D11 / R4).
// PtySessionManager : owns the fleet of sessions keyed by pane id; emits lifecycle
//                     + data events. This is the interface the transport layer talks
//                     to. THE SINGLE node-pty importer + the only TerminalMirror
//                     importer. No ACP, no genie.db imports.

import { EventEmitter } from 'node:events';
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import type { PaneSpec } from './fleet-config';
import { TerminalMirror } from './reused/TerminalMirror';
import type { PaneInfo, SessionStatus } from './transport';

export class PtySession extends EventEmitter {
  readonly id: string;
  private spec: PaneSpec;
  private proc: IPty | null = null;
  private mirror: TerminalMirror;
  private cols: number;
  private rows: number;
  status: SessionStatus = 'idle';
  private lastExitCode: number | null = null;

  constructor(spec: PaneSpec) {
    super();
    this.spec = spec;
    this.id = spec.id;
    this.cols = spec.cols;
    this.rows = spec.rows;
    this.mirror = new TerminalMirror(this.cols, this.rows);
  }

  start(): void {
    if (this.proc) return; // already running
    // Fresh screen on (re)start: drop the previous mirror so replay never shows
    // pre-restart content (the sync equivalent of fresh's `buffer = ''`).
    this.mirror.dispose();
    this.mirror = new TerminalMirror(this.cols, this.rows);
    const env = { ...process.env, ...this.spec.env } as Record<string, string>;
    this.proc = pty.spawn(this.spec.command, this.spec.args, {
      name: env.TERM || 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.spec.cwd,
      env,
    });
    this.status = 'running';
    this.lastExitCode = null;

    this.proc.onData((data) => {
      this.mirror.write(data);
      this.emit('data', data);
    });

    this.proc.onExit(({ exitCode }) => {
      this.status = 'exited';
      this.lastExitCode = exitCode;
      this.proc = null;
      // Emit `status:exited` BEFORE `exit`: restart() listens on `exit` and calls
      // start() synchronously, which emits `status:running`. Emitting status first
      // keeps the observable sequence honest (exited -> running), never reversed.
      this.emit('status', this.status);
      this.emit('exit', exitCode);
    });

    this.emit('status', this.status);
  }

  write(data: string): void {
    this.proc?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.mirror.resize(cols, rows);
    if (this.proc) {
      try {
        this.proc.resize(cols, rows);
      } catch {
        /* pty may have exited between check and call */
      }
    }
  }

  kill(): void {
    this.proc?.kill();
  }

  /** Screen replay for a client attaching to a running (or last-exited) session. */
  replay(): Promise<string> {
    return this.mirror.serialize();
  }

  dispose(): void {
    this.mirror.dispose();
  }

  info(): PaneInfo {
    return {
      id: this.id,
      name: this.spec.name,
      role: this.spec.role,
      wishId: this.spec.wishId,
      command: this.spec.command,
      args: this.spec.args,
      cwd: this.spec.cwd,
      status: this.status,
      exitCode: this.lastExitCode,
    };
  }
}

export class PtySessionManager extends EventEmitter {
  private sessions = new Map<string, PtySession>();

  constructor(specs: PaneSpec[]) {
    super();
    for (const spec of specs) {
      this.sessions.set(spec.id, this.wire(new PtySession(spec)));
    }
  }

  private wire(session: PtySession): PtySession {
    session.on('data', (data: string) => this.emit('data', session.id, data));
    session.on('exit', (code: number) => this.emit('exit', session.id, code));
    session.on('status', (status: SessionStatus) => this.emit('status', session.id, status));
    return session;
  }

  get(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  list(): PaneInfo[] {
    return [...this.sessions.values()].map((s) => s.info());
  }

  /** Start every idle session (called once at boot). */
  startAll(): void {
    for (const s of this.sessions.values()) s.start();
  }

  spawn(id: string): void {
    const s = this.get(id);
    if (s && s.status !== 'running') s.start();
  }

  kill(id: string): void {
    this.get(id)?.kill();
  }

  restart(id: string): void {
    const s = this.get(id);
    if (!s) return;
    if (s.status === 'running') {
      // start() is a no-op while running; re-spawn once the old proc exits.
      s.once('exit', () => s.start());
      s.kill();
    } else {
      s.start();
    }
  }

  write(id: string, data: string): void {
    this.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.get(id)?.resize(cols, rows);
  }

  replay(id: string): Promise<string> {
    return this.get(id)?.replay() ?? Promise.resolve('');
  }

  killAll(): void {
    for (const s of this.sessions.values()) s.kill();
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) s.dispose();
  }
}
