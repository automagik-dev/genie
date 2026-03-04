/**
 * Idle Timeout — Suspend workers that have been idle too long.
 *
 * The watchdog polls all registered workers and suspends any that
 * have been idle longer than the configured timeout. Suspended
 * workers preserve their Claude session ID for resume-on-message.
 */

import * as registry from './agent-registry.js';
import { executeTmux, isPaneAlive } from './tmux.js';

// ============================================================================
// Configuration
// ============================================================================

/** Default idle timeout in milliseconds (30 minutes). */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Watchdog poll interval in milliseconds (60 seconds). */
export const WATCHDOG_POLL_INTERVAL_MS = 60_000;

/**
 * Get the idle timeout from env or default.
 * Set GENIE_IDLE_TIMEOUT_MS to override (0 = disabled).
 */
export function getIdleTimeoutMs(): number {
  const env = process.env.GENIE_IDLE_TIMEOUT_MS;
  if (env !== undefined) {
    if (env === '') return DEFAULT_IDLE_TIMEOUT_MS;
    const parsed = Number(env);
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_IDLE_TIMEOUT_MS;
}

// ============================================================================
// Suspend
// ============================================================================

/**
 * Suspend a single worker — kill its tmux pane but preserve registry
 * entry with `suspended` state and `suspendedAt` timestamp.
 *
 * Returns true if the worker was successfully suspended.
 */
export async function suspendWorker(workerId: string): Promise<boolean> {
  const worker = await registry.get(workerId);
  if (!worker) return false;
  if (worker.state === 'suspended') return true;

  // Kill tmux pane (best-effort)
  if (worker.paneId && worker.paneId !== 'inline') {
    try {
      await executeTmux(`kill-pane -t '${worker.paneId}'`);
    } catch {
      // Pane may already be dead
    }
  }

  // Update registry to suspended state
  await registry.update(workerId, {
    state: 'suspended',
    suspendedAt: new Date().toISOString(),
  });

  return true;
}

// ============================================================================
// Watchdog
// ============================================================================

/**
 * Check all workers and suspend any that have been idle too long.
 * Returns the list of worker IDs that were suspended.
 */
export async function checkIdleWorkers(): Promise<string[]> {
  const timeoutMs = getIdleTimeoutMs();
  if (timeoutMs === 0) return []; // Disabled

  const workers = await registry.list();
  const suspended: string[] = [];

  for (const w of workers) {
    // Only suspend idle workers with live panes
    if (w.state !== 'idle') continue;

    const idleMs = Date.now() - new Date(w.lastStateChange).getTime();
    if (idleMs < timeoutMs) continue;

    // Verify pane is still alive before suspending
    const alive = await isPaneAlive(w.paneId);
    if (!alive) {
      // Pane already dead — mark suspended directly
      await registry.update(w.id, {
        state: 'suspended',
        suspendedAt: new Date().toISOString(),
      });
      suspended.push(w.id);
      continue;
    }

    const ok = await suspendWorker(w.id);
    if (ok) suspended.push(w.id);
  }

  return suspended;
}

/**
 * Run the watchdog loop — polls every WATCHDOG_POLL_INTERVAL_MS.
 * Designed to run in a background tmux pane via scripts/watchdog.ts.
 *
 * @param signal — AbortSignal to stop the loop (for testing).
 */
export async function runWatchdogLoop(signal?: AbortSignal): Promise<void> {
  const poll = async () => {
    try {
      const suspended = await checkIdleWorkers();
      if (suspended.length > 0) {
        console.log(`[watchdog] Suspended ${suspended.length} idle worker(s): ${suspended.join(', ')}`);
      }
    } catch (err) {
      console.error('[watchdog] Error checking idle workers:', err);
    }
  };

  // Initial check
  await poll();

  // Poll loop
  while (!signal?.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, WATCHDOG_POLL_INTERVAL_MS);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    if (signal?.aborted) break;
    await poll();
  }
}
