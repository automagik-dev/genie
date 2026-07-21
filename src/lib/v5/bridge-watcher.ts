/**
 * Genie v5 ui-bridge lifetime primitives — the in-child change watcher and the
 * ppid backstop that keep the bridge daemon-free.
 *
 * SQLite has no cross-process notify, so the bridge polls `PRAGMA data_version`
 * (which increments on any OTHER connection's commit) and uses an fs-watch on
 * the db directory as a wake hint. Both concerns are pure mechanism here — the
 * db read and the ppid read are injected — so they are unit-testable without
 * spawning processes or racing the clock.
 */

import { type FSWatcher, existsSync, watch } from 'node:fs';
import { dirname } from 'node:path';

/** A started background loop that must be stopped for the event loop to drain. */
export interface Stoppable {
  stop(): void;
}

// ============================================================================
// Change watcher (PRAGMA data_version poll + fs-watch wake hint)
// ============================================================================

export interface ChangeWatcherOptions {
  /** Absolute path to `genie.db`; its containing dir is fs-watched as a hint. */
  dbPath: string;
  /**
   * Read the current `PRAGMA data_version` from a dedicated read connection, or
   * `null` when the db is unavailable. Injected so tests drive it deterministically.
   */
  readDataVersion: () => number | null;
  /** Invoked with the new data_version whenever the db changed since the last poll. */
  onChange: (dataVersion: number) => void;
  /** Poll interval (design range 250–500 ms). Default 300. */
  pollMs?: number;
}

/**
 * Start watching for external db changes. Returns a handle whose `stop()` clears
 * the interval and closes the fs watcher — required for the bridge to exit on
 * stdin EOF. The poll is the correctness guarantee (bounded by `pollMs`); the
 * fs-watch only wakes the poll early to cut latency, and is best-effort.
 */
export function startChangeWatcher(opts: ChangeWatcherOptions): Stoppable {
  const pollMs = opts.pollMs ?? 300;
  let last = opts.readDataVersion();

  const poll = (): void => {
    const current = opts.readDataVersion();
    if (current !== null && current !== last) {
      last = current;
      opts.onChange(current);
    }
  };

  const interval = setInterval(poll, pollMs);
  const watcher = startDirWatch(opts.dbPath, poll);

  return {
    stop(): void {
      clearInterval(interval);
      if (watcher) {
        try {
          watcher.close();
        } catch {
          /* already closed */
        }
      }
    },
  };
}

/**
 * Watch the db's directory (catching `genie.db-wal` writes AND the `-wal` file's
 * creation on the first write) and call `wake` on any event. Best-effort: a
 * missing dir or an unsupported platform degrades to poll-only.
 */
function startDirWatch(dbPath: string, wake: () => void): FSWatcher | null {
  try {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) return null;
    return watch(dir, () => wake());
  } catch {
    return null;
  }
}

// ============================================================================
// ppid backstop (orphan detection when stdin EOF never arrives)
// ============================================================================

/**
 * True when the current parent pid differs from the one recorded at startup —
 * i.e. the original parent died and the child was reparented. Subreaper-aware:
 * it does NOT assume reparenting to pid 1, so it works under systemd/user
 * subreapers too. `0` (the platform "unknown ppid" sentinel) is never treated
 * as reparenting, guarding against a spurious orphan trip.
 */
export function isOrphaned(originalPpid: number, currentPpid: number): boolean {
  if (currentPpid === 0) return false;
  return currentPpid !== originalPpid;
}

export interface PpidBackstopOptions {
  /** The parent pid captured at bridge startup. */
  originalPpid: number;
  /** Invoked once when the parent is detected to have changed. */
  onOrphaned: () => void;
  /** Read the current parent pid. Injected for tests; defaults to `process.ppid`. */
  getPpid?: () => number;
  /** Poll interval. Default 1000 ms. */
  intervalMs?: number;
}

/**
 * Start the orphan backstop. Complements stdin EOF: a parent that dies while
 * something else holds the stdin write-end open would leave the child running,
 * so this polls the parent pid and fires `onOrphaned` on change. Returns a
 * handle whose `stop()` clears the interval.
 */
export function startPpidBackstop(opts: PpidBackstopOptions): Stoppable {
  const getPpid = opts.getPpid ?? (() => process.ppid);
  const intervalMs = opts.intervalMs ?? 1000;
  let fired = false;

  const timer = setInterval(() => {
    if (fired) return;
    if (isOrphaned(opts.originalPpid, getPpid())) {
      fired = true;
      opts.onOrphaned();
    }
  }, intervalMs);

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
