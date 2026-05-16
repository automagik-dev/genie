/**
 * TerminalPane — OpenTUI Renderable that displays an `@xterm/headless` cell
 * buffer fed by a `tmux -L genie -C` control-mode connection.
 *
 * Group 3 deliverable (wish: tui-opentui-host). The widget:
 *  - owns ONE xterm.Terminal + ONE ControlSession
 *  - blits xterm cells into its frame buffer each render frame
 *  - forwards keystrokes to the agent pane via send-keys -H when focused
 *  - debounces refresh-client -C resize hints
 *  - re-applies the native-selection drag-track override on mount
 *  - caps initial-replay at `historyLimit` lines (default 10 000)
 *
 * Architecture decisions (see WISH.md decisions table):
 *  - Single pane mounted at a time (decision #9). No multi-instance bookkeeping.
 *  - Mouse contract identical to render.tsx's `disableDragTracking` (decision #6).
 *  - Resize debounce 50 ms (decision #10 + Group 2 spec).
 *
 * Architecturally the file is split into two layers so the state machine is
 * testable without spinning a real OpenTUI renderer:
 *  - {@link TerminalPaneCore} — pure controller. Owns the xterm Terminal, the
 *    ControlSession (or a fake), focus state, replay state, and the resize
 *    debouncer. No OpenTUI dependency.
 *  - {@link TerminalPane}    — `FrameBufferRenderable` glue that delegates to
 *    a core and paints the xterm buffer into the frame buffer each render frame.
 */
import {
  type FrameBufferOptions,
  FrameBufferRenderable,
  type OptimizedBuffer,
  type RenderContext,
} from '@opentui/core';
import { Terminal } from '@xterm/headless';
import { disableDragTracking } from '../render.js';
import { ControlSession } from '../tmux-control/control.js';
import { sendInput } from '../tmux-control/input.js';
import { type ResizeForwarder, createResizeForwarder } from '../tmux-control/resize.js';
import { paintXtermBufferToFrame } from './xterm-cell-paint.js';

/** Default replay cap — `max(tmux history-limit, 10 000)` per wish decision #7. */
export const DEFAULT_HISTORY_LIMIT = 10_000;

/** Default xterm viewport when no layout size is known yet. */
const FALLBACK_COLS = 80;
const FALLBACK_ROWS = 24;

/** Source of `data` events when the pane is focused. */
export interface StdinLike {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

/** Stdout sink for the mouse-contract override (defaults to `process.stdout`). */
export interface StdoutLike {
  write(chunk: string | Buffer): boolean | undefined;
}

/** Subset of ControlSession the core needs. Lets tests swap in a fake. */
export interface ControlSessionLike {
  stdin: NodeJS.WritableStream | null;
  on(event: 'output', listener: (paneId: string, data: Buffer) => void): unknown;
  off(event: 'output', listener: (paneId: string, data: Buffer) => void): unknown;
  detach(): void;
}

/** Internal dependency-injection surface — kept off the public API for ergonomics. */
export interface TerminalPaneCoreDeps {
  /** Factory for the control-mode connection. Return `null` to skip wire-up. */
  controlSessionFactory?: (sessionName: string) => ControlSessionLike | null;
  /** Factory for the xterm-headless Terminal. */
  terminalFactory?: (cols: number, rows: number) => Terminal;
  /** Keystroke source (defaults to `process.stdin`). */
  stdin?: StdinLike;
  /** Byte sink used by the mouse-contract override. */
  stdout?: StdoutLike;
  /** Custom drag-track override (handy for asserting bytes). */
  disableDragTracking?: (stdout: StdoutLike) => void;
  /** Resize-forwarder factory (lets tests skip the timer). */
  resizeForwarderFactory?: (
    stdinAccessor: () => NodeJS.WritableStream | null,
    options?: { debounceMs?: number },
  ) => ResizeForwarder;
}

export interface TerminalPaneCoreOptions {
  /** Agent tmux session on the `-L genie` socket. */
  sessionName: string;
  /** Optional pane filter; when set, `%output` lines for other panes are ignored. */
  paneId?: string;
  /** Replay cap. Defaults to {@link DEFAULT_HISTORY_LIMIT}. */
  historyLimit?: number;
  /** Initial viewport. Real layout dimensions arrive via `resize()`. */
  cols?: number;
  rows?: number;
  /** Whether keystrokes should forward to the agent on construction. */
  focused?: boolean;
  /** Notified after the xterm/tmux resize fires. */
  onResize?: (cols: number, rows: number) => void;
  /** Test-only deps. */
  deps?: TerminalPaneCoreDeps;
}

/**
 * Stateful controller for one focused agent's data link + cell buffer.
 * Has no OpenTUI dependency — the wrapping {@link TerminalPane} drives
 * `paintInto()` once per render frame.
 */
export class TerminalPaneCore {
  readonly sessionName: string;
  readonly paneIdFilter: string | undefined;
  readonly historyLimit: number;
  private readonly onResizeForward: ((cols: number, rows: number) => void) | undefined;

  readonly terminal: Terminal;
  readonly controlSession: ControlSessionLike | null;
  private readonly resizer: ResizeForwarder;
  private readonly stdin: StdinLike;
  private readonly stdoutSink: StdoutLike;
  private readonly disableDragTrackingFn: (stdout: StdoutLike) => void;

  private focusedFlag: boolean;
  private replayedLines: number;
  private replayComplete: boolean;
  private stdinHandler: ((chunk: Buffer | string) => void) | null = null;
  private outputUnsubscribe: (() => void) | null = null;
  private disposed = false;

  /**
   * Change-detection gate (wish risk R2). Without it `paintInto()` ran a full
   * O(rows × cols) `setCell` blit on EVERY OpenTUI frame (30–60 fps) even for a
   * static screen, burning ~300k–600k `setCell`/sec doing nothing.
   *
   * xterm-headless 5.5.0 exposes NO parse/render event (verified at runtime:
   * only onBell/onBinary/onCursorMove/onData/onLineFeed/onResize/onScroll/
   * onTitleChange — neither `onWriteParsed` nor `onRender` exists). Every
   * content mutation flows through this core's own `terminal.write()` calls,
   * so we mark dirty in xterm's `write(data, cb)` parse-complete callback (cb
   * fires after the chunk is parsed, so the buffer is current). `resize()`
   * reflows synchronously and sets the flag directly. Starts `true` so the
   * first paint is unconditional.
   */
  private dirty = true;
  /** Painted-cell count from the last real paint, returned on skipped frames. */
  private lastPaintedCells = 0;

  /** Mark the buffer dirty once xterm has finished parsing a written chunk. */
  private readonly markDirty = (): void => {
    this.dirty = true;
  };

  /** Single write path: feed xterm and arm the dirty flag post-parse. */
  private writeToTerminal(data: Buffer | string): void {
    this.terminal.write(data, this.markDirty);
  }

  constructor(options: TerminalPaneCoreOptions) {
    this.sessionName = options.sessionName;
    this.paneIdFilter = options.paneId;
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.onResizeForward = options.onResize;
    this.focusedFlag = options.focused ?? false;
    this.replayedLines = 0;
    this.replayComplete = false;

    const deps = options.deps ?? {};
    this.stdin = deps.stdin ?? (process.stdin as unknown as StdinLike);
    this.stdoutSink = deps.stdout ?? (process.stdout as unknown as StdoutLike);
    this.disableDragTrackingFn =
      deps.disableDragTracking ??
      ((stdout) => {
        disableDragTracking(stdout as unknown as NodeJS.WritableStream);
      });

    const cols = Math.max(1, options.cols ?? FALLBACK_COLS);
    const rows = Math.max(1, options.rows ?? FALLBACK_ROWS);
    this.terminal =
      deps.terminalFactory?.(cols, rows) ??
      new Terminal({
        cols,
        rows,
        scrollback: this.historyLimit,
        allowProposedApi: true,
      });

    const factory =
      deps.controlSessionFactory ?? ((session: string) => new ControlSession(session) as unknown as ControlSessionLike);
    this.controlSession = factory(this.sessionName);
    if (this.controlSession) {
      const handler = (paneId: string, data: Buffer): void => {
        if (this.paneIdFilter && paneId !== this.paneIdFilter) return;
        this.writeToTerminal(data);
      };
      this.controlSession.on('output', handler);
      this.outputUnsubscribe = () => {
        this.controlSession?.off('output', handler);
      };
    }

    this.resizer =
      deps.resizeForwarderFactory?.(() => this.controlSession?.stdin ?? null) ??
      createResizeForwarder(() => this.controlSession?.stdin ?? null);

    // Mouse contract: one-shot ?1002l?1003l on mount. The renderer-level wrap
    // installed by `render.tsx` re-applies it after every `enableMouse()`
    // invocation; we are the "on mount" half of the contract.
    this.disableDragTrackingFn(this.stdoutSink);

    if (this.focusedFlag) this.installStdinHandler();
  }

  /** Whether keystrokes should forward to the agent. */
  get isFocused(): boolean {
    return this.focusedFlag;
  }

  /** Programmatically toggle focus. */
  setFocused(value: boolean): void {
    if (this.focusedFlag === value) return;
    this.focusedFlag = value;
    if (value) this.installStdinHandler();
    else this.uninstallStdinHandler();
  }

  /** 1 when a stdin listener is currently installed, 0 otherwise. */
  get installedStdinListeners(): number {
    return this.stdinHandler ? 1 : 0;
  }

  /** Lines actually written during `replayHistory()`. */
  get replayedLineCount(): number {
    return this.replayedLines;
  }

  /** Replay history lines into xterm, honouring `historyLimit`. */
  replayHistory(lines: ReadonlyArray<string | Buffer>): number {
    if (this.replayComplete) return this.replayedLines;
    let written = 0;
    for (const line of lines) {
      if (this.replayedLines >= this.historyLimit) break;
      this.writeToTerminal(line);
      this.replayedLines++;
      written++;
    }
    this.replayComplete = true;
    return written;
  }

  /** Forward bytes to the focused pane via send-keys -H. */
  forwardInput(data: Buffer | string): boolean {
    if (!this.focusedFlag) return false;
    if (!this.controlSession || !this.paneIdFilter) return false;
    return sendInput({ stdin: this.controlSession.stdin }, this.paneIdFilter, data);
  }

  /** Schedule a `refresh-client -C <cols>x<rows>` after the debounce window. */
  scheduleResize(cols: number, rows: number): void {
    this.resizer.schedule({ cols, rows });
  }

  /** Pending resize dims (for tests). */
  get pendingResize(): { cols: number; rows: number } | null {
    return this.resizer.pending();
  }

  /** Resize xterm + queue a refresh-client hint. Called by `TerminalPane.onResize`. */
  resize(cols: number, rows: number): void {
    const c = Math.max(1, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    if (c !== this.terminal.cols || r !== this.terminal.rows) {
      this.terminal.resize(c, r);
      // resize() reflows the buffer synchronously (no write callback) — arm
      // the gate directly so the next frame repaints the new geometry.
      this.dirty = true;
    }
    this.resizer.schedule({ cols: c, rows: r });
    if (this.onResizeForward) this.onResizeForward(c, r);
  }

  /** Paint the xterm cell buffer into the given OpenTUI buffer. */
  paintInto(out: OptimizedBuffer, originX = 0, originY = 0): number {
    if (this.disposed) return 0;
    // Change-detection gate: skip the full O(rows × cols) blit when nothing
    // changed since the last paint. Return the prior painted-cell count
    // WITHOUT walking the buffer.
    if (!this.dirty) return this.lastPaintedCells;
    const painted = paintXtermBufferToFrame(this.terminal.buffer.active, out, originX, originY, {
      cols: this.terminal.cols,
      rows: this.terminal.rows,
    });
    this.dirty = false;
    this.lastPaintedCells = painted;
    return painted;
  }

  /** Tear down xterm + control session + stdin listener + debouncer. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.uninstallStdinHandler();
    if (this.outputUnsubscribe) {
      this.outputUnsubscribe();
      this.outputUnsubscribe = null;
    }
    this.resizer.dispose();
    if (this.controlSession) this.controlSession.detach();
    try {
      this.terminal.dispose();
    } catch {
      // already disposed
    }
  }

  /** Whether `dispose()` has been called. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  private installStdinHandler(): void {
    if (this.stdinHandler) return;
    const handler = (chunk: Buffer | string): void => {
      this.forwardInput(chunk);
    };
    this.stdinHandler = handler;
    this.stdin.on('data', handler);
  }

  private uninstallStdinHandler(): void {
    if (!this.stdinHandler) return;
    this.stdin.off('data', this.stdinHandler);
    this.stdinHandler = null;
  }
}

export interface TerminalPaneOptions extends Omit<FrameBufferOptions, 'width' | 'height'> {
  /** Agent tmux session on the `-L genie` socket. */
  sessionName: string;
  /** Optional pane filter — when set, the widget only consumes `%output` lines for this pane. */
  paneId?: string;
  /** Whether keystrokes should forward to the agent. Defaults to false. */
  focused?: boolean;
  /** Replay cap (`max(history-limit, 10 000)`). */
  historyLimit?: number;
  /** Layout-resize forwarder; called after the internal xterm is resized. */
  onResize?: (cols: number, rows: number) => void;
  /**
   * Initial framebuffer width. OpenTUI's flexbox resolves the actual dim via
   * `onResize`; this is just the seed size before layout runs. Accepts the
   * same shape as other OpenTUI renderables (number | "auto" | "<N>%").
   */
  width?: number | 'auto' | `${number}%`;
  /** Initial framebuffer height. See {@link TerminalPaneOptions.width}. */
  height?: number | 'auto' | `${number}%`;
  /** Internal test-only deps (forwarded to `TerminalPaneCore`). */
  _deps?: TerminalPaneCoreDeps;
}

/**
 * OpenTUI Renderable that wraps a {@link TerminalPaneCore}. Each render frame
 * walks the xterm buffer and paints into the embedded `frameBuffer`; the base
 * `FrameBufferRenderable` then blits that frame buffer into the outer
 * `OptimizedBuffer`.
 */
export class TerminalPane extends FrameBufferRenderable {
  readonly core: TerminalPaneCore;

  constructor(ctx: RenderContext, options: TerminalPaneOptions) {
    // FrameBufferRenderable's constructor allocates an OptimizedBuffer using
    // numeric width/height. JSX layout values (`"100%"`, `"auto"`, undefined)
    // can't size that initial buffer, so coerce to safe fallbacks; OpenTUI's
    // flexbox will deliver the real dims through `onResize` once it settles.
    const initialCols = typeof options.width === 'number' ? Math.max(1, options.width) : FALLBACK_COLS;
    const initialRows = typeof options.height === 'number' ? Math.max(1, options.height) : FALLBACK_ROWS;
    super(ctx, { ...options, width: initialCols, height: initialRows } as FrameBufferOptions);
    this.core = new TerminalPaneCore({
      sessionName: options.sessionName,
      paneId: options.paneId,
      historyLimit: options.historyLimit,
      cols: initialCols,
      rows: initialRows,
      focused: options.focused,
      onResize: options.onResize,
      deps: options._deps,
    });
  }

  /** Public passthrough — Group 4 wires `<Nav>` click → `pane.setFocused()`. */
  setFocused(value: boolean): void {
    this.core.setFocused(value);
  }

  /** Public passthrough — `Group 4` calls this after `tmux capture-pane`. */
  replayHistory(lines: ReadonlyArray<string | Buffer>): number {
    return this.core.replayHistory(lines);
  }

  protected onResize(width: number, height: number): void {
    super.onResize(width, height);
    this.core.resize(width, height);
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    this.core.paintInto(this.frameBuffer);
    super.renderSelf(buffer);
  }

  /**
   * React reconciler removes children via `parent.remove(id)` rather than
   * `destroyRecursively()`, so `destroySelf` never fires on unmount. Dispose
   * the core here to guarantee the tmux -CC child process / xterm buffer /
   * stdin listener are released when React unmounts the widget (e.g. on
   * `key={sessionName}` change).
   */
  protected onRemove(): void {
    this.core.dispose();
    super.onRemove();
  }

  protected destroySelf(): void {
    this.core.dispose();
    super.destroySelf();
  }
}

/**
 * Augment `@opentui/react`'s component catalogue so `<terminal-pane>` is a
 * type-aware JSX element. Pair with `extend({ 'terminal-pane': TerminalPane })`
 * at runtime to mount it from React.
 */
declare module '@opentui/react' {
  interface OpenTUIComponents {
    'terminal-pane': typeof TerminalPane;
  }
}
