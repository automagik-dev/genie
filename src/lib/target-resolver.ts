/**
 * Target Resolver - Resolves target strings to tmux pane IDs
 *
 * Resolution chain (DEC-1 from wish-26):
 *   1. Raw pane ID (starts with %) -> passthrough
 *   2. Worker[:index] (left side is registered worker) -> registry lookup + subpane index
 *   3. Session:window (contains :, left side is tmux session) -> tmux lookup
 *   4. Session name (fallback) -> legacy behavior
 *
 * Returns { paneId, session, workerId?, paneIndex?, resolvedVia }
 */

import type { Worker } from './worker-registry.js';

// ============================================================================
// Types
// ============================================================================

export type ResolutionMethod = 'raw' | 'worker' | 'session:window' | 'session';

export interface ResolvedTarget {
  /** The resolved tmux pane ID (e.g., "%17") */
  paneId: string;
  /** The tmux session name (when known) */
  session?: string;
  /** The worker ID if resolved via worker registry */
  workerId?: string;
  /** The pane index if resolved via worker:N notation */
  paneIndex?: number;
  /** How the target was resolved */
  resolvedVia: ResolutionMethod;
}

/**
 * Options for controlling resolver behavior.
 * Test code can inject mocks via these options.
 */
export interface ResolveOptions {
  /** Whether to validate pane liveness via tmux (default: true in production) */
  checkLiveness?: boolean;

  /** Override registry path for testing */
  registryPath?: string;

  /** Inject workers directly (bypasses file-based registry) */
  workers?: Record<string, Worker>;

  /** Custom tmux lookup function (for session:window and session fallback) */
  tmuxLookup?: (sessionName: string, windowName?: string) => Promise<{ paneId: string; session: string } | null>;

  /** Custom pane liveness check (for testing) */
  isPaneLive?: (paneId: string) => Promise<boolean>;

  /** Custom dead pane cleanup callback (for testing) */
  cleanupDeadPane?: (workerId: string, paneId: string) => Promise<void>;

  /** Custom session derivation from pane ID (for testing) */
  deriveSession?: (paneId: string) => Promise<string | null>;
}

// ============================================================================
// Debug logging
// ============================================================================

function debug(msg: string): void {
  if (process.env.DEBUG) {
    console.error(`[target-resolver] ${msg}`);
  }
}

// ============================================================================
// Default tmux operations (used when no mocks injected)
// ============================================================================

async function defaultTmuxLookup(
  sessionName: string,
  windowName?: string
): Promise<{ paneId: string; session: string } | null> {
  try {
    const tmux = await import('./tmux.js');

    const session = await tmux.findSessionByName(sessionName);
    if (!session) return null;

    const windows = await tmux.listWindows(session.id);
    if (!windows || windows.length === 0) return null;

    let targetWindow;
    if (windowName) {
      targetWindow = windows.find(w => w.name === windowName);
      if (!targetWindow) return null;
    } else {
      targetWindow = windows.find(w => w.active) || windows[0];
    }

    const panes = await tmux.listPanes(targetWindow.id);
    if (!panes || panes.length === 0) return null;

    const targetPane = panes.find(p => p.active) || panes[0];
    return { paneId: targetPane.id, session: sessionName };
  } catch {
    return null;
  }
}

async function defaultIsPaneLive(paneId: string): Promise<boolean> {
  try {
    const tmux = await import('./tmux.js');
    // Try to query the pane; if it throws or returns empty, pane is dead
    const output = await tmux.executeTmux(`display-message -p -t '${paneId}' '#{pane_id}'`);
    return output.trim() === paneId;
  } catch {
    return false;
  }
}

async function defaultCleanupDeadPane(workerId: string, paneId: string): Promise<void> {
  try {
    const registry = await import('./worker-registry.js');
    await registry.removeSubPane(workerId, paneId);
  } catch {
    // Best-effort cleanup
  }
}

async function defaultDeriveSession(paneId: string): Promise<string | null> {
  try {
    const tmux = await import('./tmux.js');
    const sessionName = await tmux.executeTmux(
      `display-message -p -t '${paneId}' '#{session_name}'`
    );
    const trimmed = sessionName.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

// ============================================================================
// Core Resolver
// ============================================================================

/**
 * Resolve a target string to a tmux pane ID using a 4-level resolution chain.
 *
 * @param target - The target string (e.g., "%17", "bd-42", "bd-42:1", "genie:OMNI", "genie")
 * @param options - Optional overrides for testing
 * @returns ResolvedTarget with paneId and metadata
 * @throws Error with prescriptive message if target cannot be resolved
 */
export async function resolveTarget(
  target: string,
  options: ResolveOptions = {}
): Promise<ResolvedTarget> {
  const {
    checkLiveness = false,
    workers: injectedWorkers,
    tmuxLookup = defaultTmuxLookup,
    isPaneLive = defaultIsPaneLive,
    cleanupDeadPane = defaultCleanupDeadPane,
    deriveSession = defaultDeriveSession,
  } = options;

  debug(`resolving "${target}"`);

  // ---- Level 1: Raw pane ID (starts with %) ----
  if (target.startsWith('%')) {
    debug(`"${target}" -> raw pane ID passthrough`);

    if (checkLiveness) {
      const live = await isPaneLive(target);
      if (!live) {
        throw new Error(
          `Pane ${target} is dead or does not exist. Check with: tmux list-panes -a`
        );
      }
    }

    // Derive session name from pane ID so downstream consumers (e.g., log-reader)
    // can look up the session. Best-effort: session is optional.
    const session = await deriveSession(target);
    debug(`"${target}" -> derived session: ${session || '(none)'}`);

    return {
      paneId: target,
      session: session ?? undefined,
      resolvedVia: 'raw',
    };
  }

  // ---- Level 1.5: Raw window ID (starts with @) -> worker lookup ----
  if (target.startsWith('@')) {
    debug(`"${target}" -> window ID lookup`);

    const workers = await getWorkers(injectedWorkers, options.registryPath);
    const normalizedId = target;
    const matchingWorker = Object.values(workers).find(w => w.windowId === normalizedId);

    if (matchingWorker) {
      debug(`"${target}" -> found worker "${matchingWorker.id}" with pane ${matchingWorker.paneId}`);

      if (checkLiveness) {
        const live = await isPaneLive(matchingWorker.paneId);
        if (!live) {
          throw new Error(
            `Window ${target}: worker ${matchingWorker.id} pane ${matchingWorker.paneId} is dead. ` +
            `Run 'term kill ${matchingWorker.id}' to clean up.`
          );
        }
      }

      return {
        paneId: matchingWorker.paneId,
        session: matchingWorker.session,
        workerId: matchingWorker.id,
        resolvedVia: 'worker',
      };
    }

    // No worker owns this window
    throw new Error(
      `Window "${target}" not found in worker registry.\n` +
      `Run 'term workers' to list workers or 'term session window ls <session>' to list windows.`
    );
  }

  // ---- Load workers (injected or from registry) ----
  const workers = await getWorkers(injectedWorkers, options.registryPath);

  // ---- Level 2: Worker[:index] ----
  const colonIndex = target.indexOf(':');
  if (colonIndex !== -1) {
    const leftSide = target.substring(0, colonIndex);
    const rightSide = target.substring(colonIndex + 1);
    const worker = workers[leftSide];

    if (worker) {
      // This is a worker:index pattern
      const index = parseInt(rightSide, 10);
      if (isNaN(index) || index < 0) {
        throw new Error(
          `Invalid sub-pane index "${rightSide}" for worker "${leftSide}". ` +
          `Use a non-negative integer (0 = primary, 1+ = sub-panes).`
        );
      }

      const paneId = getPaneByIndex(worker, index);
      if (!paneId) {
        const maxIndex = worker.subPanes ? worker.subPanes.length : 0;
        throw new Error(
          `Worker "${leftSide}" has no sub-pane index ${index}. ` +
          `Available: 0 (primary)${maxIndex > 0 ? `, 1-${maxIndex} (sub-panes)` : ''}. ` +
          `Split first with: term split ${leftSide}`
        );
      }

      debug(`"${target}" -> worker "${leftSide}" pane index ${index} -> ${paneId}`);

      if (checkLiveness) {
        const live = await isPaneLive(paneId);
        if (!live) {
          await cleanupDeadPane(leftSide, paneId);
          throw new Error(
            `Worker ${leftSide}: pane ${paneId} is dead. ` +
            `Run 'term kill ${leftSide}' to clean up.`
          );
        }
      }

      return {
        paneId,
        session: worker.session,
        workerId: leftSide,
        paneIndex: index,
        resolvedVia: 'worker',
      };
    }

    // Not a worker -- fall through to Level 3: session:window
    debug(`"${leftSide}" is not a registered worker, trying session:window`);
    const sessionWindowResult = await tmuxLookup(leftSide, rightSide);
    if (sessionWindowResult) {
      debug(`"${target}" -> session:window -> pane ${sessionWindowResult.paneId}`);

      if (checkLiveness) {
        const live = await isPaneLive(sessionWindowResult.paneId);
        if (!live) {
          throw new Error(
            `Session "${leftSide}" window "${rightSide}": pane ${sessionWindowResult.paneId} is dead.`
          );
        }
      }

      return {
        paneId: sessionWindowResult.paneId,
        session: sessionWindowResult.session,
        resolvedVia: 'session:window',
      };
    }

    // session:window not found either
    throw new Error(
      `Target "${target}" not found. No worker "${leftSide}" in registry and no tmux ` +
      `session:window "${leftSide}:${rightSide}" found.\n` +
      `Run 'term workers' to list workers or 'term session ls' to list sessions.`
    );
  }

  // ---- No colon: check worker registry first ----
  const worker = workers[target];
  if (worker) {
    debug(`"${target}" -> worker lookup -> pane ${worker.paneId}, session ${worker.session}`);

    if (checkLiveness) {
      const live = await isPaneLive(worker.paneId);
      if (!live) {
        await cleanupDeadPane(target, worker.paneId);
        throw new Error(
          `Worker ${target}: pane ${worker.paneId} is dead. ` +
          `Run 'term kill ${target}' to clean up.`
        );
      }
    }

    return {
      paneId: worker.paneId,
      session: worker.session,
      workerId: target,
      resolvedVia: 'worker',
    };
  }

  // ---- Level 4: Session name fallback ----
  debug(`"${target}" not in worker registry, trying session fallback`);
  const sessionResult = await tmuxLookup(target);
  if (sessionResult) {
    debug(`"${target}" -> session fallback -> pane ${sessionResult.paneId}`);

    if (checkLiveness) {
      const live = await isPaneLive(sessionResult.paneId);
      if (!live) {
        throw new Error(
          `Session "${target}": pane ${sessionResult.paneId} is dead.`
        );
      }
    }

    return {
      paneId: sessionResult.paneId,
      session: sessionResult.session,
      resolvedVia: 'session',
    };
  }

  // ---- Nothing found ----
  throw new Error(
    `Target "${target}" not found. Not a worker, tmux session, or pane ID.\n` +
    `Run 'term workers' to list workers or 'term session ls' to list sessions.`
  );
}

// ============================================================================
// Label formatting (shared by exec, send, orchestrate)
// ============================================================================

/**
 * Format a human-readable label from a resolved target.
 *
 * Examples:
 *   worker "bd-42" pane %17, session "genie"  -> "bd-42 (pane %17, session genie)"
 *   worker "bd-42:1" pane %22, session "genie" -> "bd-42:1 (pane %22, session genie)"
 *   session fallback "genie" pane %3           -> "genie (pane %3, session genie)"
 *   raw pane "%17"                             -> "%17 (pane %17)"
 */
export function formatResolvedLabel(resolved: ResolvedTarget, originalTarget: string): string {
  const parts: string[] = [];
  if (resolved.workerId) {
    parts.push(resolved.workerId);
    if (resolved.paneIndex !== undefined && resolved.paneIndex > 0) {
      parts[parts.length - 1] += `:${resolved.paneIndex}`;
    }
  } else {
    parts.push(originalTarget);
  }
  const details: string[] = [`pane ${resolved.paneId}`];
  if (resolved.session) {
    details.push(`session ${resolved.session}`);
  }
  return `${parts[0]} (${details.join(', ')})`;
}

// ============================================================================
// Helpers
// ============================================================================

async function getWorkers(
  injected?: Record<string, Worker>,
  registryPath?: string
): Promise<Record<string, Worker>> {
  if (injected !== undefined) {
    return injected;
  }

  try {
    const registry = await import('./worker-registry.js');
    const workersList = await registry.list();
    const map: Record<string, Worker> = {};
    for (const w of workersList) {
      map[w.id] = w;
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * Get pane ID by index from a worker.
 * Index 0 = primary paneId, 1+ = subPanes[index - 1].
 */
function getPaneByIndex(worker: Worker, index: number): string | null {
  if (index === 0) {
    return worker.paneId;
  }

  const subIndex = index - 1;
  if (!worker.subPanes || subIndex >= worker.subPanes.length || subIndex < 0) {
    return null;
  }

  return worker.subPanes[subIndex];
}
