/**
 * Resize forwarder for the tmux control-mode link.
 *
 * Coalesces rapid `(cols, rows)` updates and emits a single
 * `refresh-client -C <cols>x<rows>` to the control-mode stdin once the
 * 50 ms debounce window settles. Final-value-wins — a burst of resizes
 * yields exactly one tmux command with the last size observed.
 */

/** Debounce window (ms). Matches khal-os's empirically tuned value. */
export const DEFAULT_DEBOUNCE_MS = 50;

export interface ResizeDimensions {
  cols: number;
  rows: number;
}

export type StdinAccessor = () => NodeJS.WritableStream | null;

export interface ResizeForwarderOptions {
  debounceMs?: number;
  /** Override `setTimeout` for deterministic tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Override `clearTimeout` for deterministic tests. */
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface ResizeForwarder {
  /** Schedule (or update) the next resize emission. */
  schedule(dims: ResizeDimensions): void;
  /** Force-flush any pending emission. Returns the dims that were emitted, or null. */
  flush(): ResizeDimensions | null;
  /** Discard a pending emission without writing. */
  cancel(): void;
  /** Inspect the currently pending dimensions (for tests). */
  pending(): ResizeDimensions | null;
  /** Tear down listeners + any pending timer. */
  dispose(): void;
}

function formatResizeCommand(dims: ResizeDimensions): string {
  // tmux 3.2+ accepts `WxH` AND `W,H`; we use `WxH` because the comma form
  // collides with the inline `; <cmd>` separator on a few older 3.0 builds
  // still floating around in the smoke matrix.
  return `refresh-client -C ${dims.cols}x${dims.rows}\n`;
}

/**
 * Create a debounced resize forwarder bound to a stdin accessor.
 * The accessor is called at flush time so reconnect transitions (stdin
 * replaced) are handled transparently.
 */
export function createResizeForwarder(stdin: StdinAccessor, options: ResizeForwarderOptions = {}): ResizeForwarder {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const setTimeoutImpl = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutFn ?? clearTimeout;

  let pendingDims: ResizeDimensions | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function clearTimer(): void {
    if (timer) {
      clearTimeoutImpl(timer);
      timer = null;
    }
  }

  function emit(): ResizeDimensions | null {
    if (!pendingDims) return null;
    const dims = pendingDims;
    pendingDims = null;
    const out = stdin();
    if (
      out &&
      (typeof (out as { writable?: boolean }).writable !== 'boolean' || (out as { writable?: boolean }).writable)
    ) {
      try {
        out.write(formatResizeCommand(dims));
      } catch {
        // stdin closed mid-write — surface as cancelled flush.
        return null;
      }
    }
    return dims;
  }

  return {
    schedule(dims: ResizeDimensions): void {
      if (disposed) return;
      pendingDims = { cols: dims.cols, rows: dims.rows };
      clearTimer();
      timer = setTimeoutImpl(() => {
        timer = null;
        emit();
      }, debounceMs);
    },
    flush(): ResizeDimensions | null {
      if (disposed) return null;
      clearTimer();
      return emit();
    },
    cancel(): void {
      clearTimer();
      pendingDims = null;
    },
    pending(): ResizeDimensions | null {
      return pendingDims ? { ...pendingDims } : null;
    },
    dispose(): void {
      disposed = true;
      clearTimer();
      pendingDims = null;
    },
  };
}
