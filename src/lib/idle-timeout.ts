/**
 * Idle Timeout — Suspend workers that have been idle too long.
 *
 * The watchdog polls all registered workers and suspends any that
 * have been idle longer than the configured timeout. Suspended
 * workers preserve their Claude session ID for resume-on-message.
 */

import type { Agent } from './agent-registry.js';
import * as registry from './agent-registry.js';
import { executeTmux, isPaneAlive } from './tmux.js';

// ============================================================================
// Dependency injection (testability without mock.module)
// ============================================================================

/** Dependencies used by idle-timeout functions. */
export interface IdleDeps {
  registryGet: (id: string) => Promise<Agent | null>;
  registryList: () => Promise<Agent[]>;
  registryUpdate: (id: string, updates: Partial<Agent>) => Promise<void>;
  executeTmux: (cmd: string) => Promise<string>;
  isPaneAlive: (paneId: string) => Promise<boolean>;
}

/** Default production dependencies. */
const defaultDeps: IdleDeps = {
  registryGet: registry.get,
  registryList: registry.list,
  registryUpdate: registry.update,
  executeTmux,
  isPaneAlive,
};

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
export async function suspendWorker(workerId: string, deps: IdleDeps = defaultDeps): Promise<boolean> {
  const worker = await deps.registryGet(workerId);
  if (!worker) return false;
  if (worker.state === 'suspended') return true;

  // Kill tmux pane (best-effort)
  if (worker.paneId && worker.paneId !== 'inline') {
    try {
      await deps.executeTmux(`kill-pane -t '${worker.paneId}'`);
    } catch {
      // Pane may already be dead
    }
  }

  // Update registry to suspended state
  await deps.registryUpdate(workerId, {
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
export async function checkIdleWorkers(deps: IdleDeps = defaultDeps): Promise<string[]> {
  const timeoutMs = getIdleTimeoutMs();
  if (timeoutMs === 0) return []; // Disabled

  const workers = await deps.registryList();
  const suspended: string[] = [];

  for (const w of workers) {
    // Only suspend idle workers with live panes
    if (w.state !== 'idle') continue;

    const idleMs = Date.now() - new Date(w.lastStateChange).getTime();
    if (idleMs < timeoutMs) continue;

    // Verify pane is still alive before suspending
    const alive = await deps.isPaneAlive(w.paneId);
    if (!alive) {
      // Pane already dead — mark suspended directly
      await deps.registryUpdate(w.id, {
        state: 'suspended',
        suspendedAt: new Date().toISOString(),
      });
      suspended.push(w.id);
      continue;
    }

    const ok = await suspendWorker(w.id, deps);
    if (ok) suspended.push(w.id);
  }

  return suspended;
}
