/**
 * Idle Timeout — Suspend workers that have been idle too long.
 *
 * The watchdog polls all active executors and terminates any that
 * have been idle longer than the configured timeout. Executor state
 * is the source of truth (from executors table).
 */

import * as executorRegistry from './executor-registry.js';
import type { Executor } from './executor-types.js';
import { executeTmux, isPaneAlive } from './tmux.js';

// ============================================================================
// Dependency injection (testability without mock.module)
// ============================================================================

/** Dependencies used by idle-timeout functions. */
export interface IdleDeps {
  listExecutors: () => Promise<Executor[]>;
  terminateExecutor: (id: string) => Promise<void>;
  updateExecutorState: (id: string, state: Executor['state']) => Promise<void>;
  executeTmux: (cmd: string) => Promise<string>;
  isPaneAlive: (paneId: string) => Promise<boolean>;
}

/** Default production dependencies. */
const defaultDeps: IdleDeps = {
  listExecutors: () => executorRegistry.listExecutors(),
  terminateExecutor: executorRegistry.terminateExecutor,
  updateExecutorState: executorRegistry.updateExecutorState,
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
 * Suspend a single executor — kill its tmux pane and mark it terminated.
 *
 * Returns true if the executor was successfully suspended.
 */
export async function suspendWorker(executorId: string, deps: IdleDeps = defaultDeps): Promise<boolean> {
  const executors = await deps.listExecutors();
  const executor = executors.find((e) => e.id === executorId);
  if (!executor) return false;
  if (executor.state === 'terminated') return true;

  // Kill tmux pane (best-effort)
  if (executor.tmuxPaneId) {
    try {
      await deps.executeTmux(`kill-pane -t '${executor.tmuxPaneId}'`);
    } catch {
      // Pane may already be dead
    }
  }

  // Mark executor as terminated
  await deps.terminateExecutor(executorId);

  return true;
}

// ============================================================================
// Watchdog
// ============================================================================

/**
 * Check all active executors and suspend any that have been idle too long.
 * Returns the list of executor IDs that were suspended.
 */
export async function checkIdleWorkers(deps: IdleDeps = defaultDeps): Promise<string[]> {
  const timeoutMs = getIdleTimeoutMs();
  if (timeoutMs === 0) return []; // Disabled

  const executors = await deps.listExecutors();
  const suspended: string[] = [];

  for (const e of executors) {
    // Only suspend idle executors with live panes
    if (e.state !== 'idle') continue;

    // Use updatedAt as a proxy for last state change time
    const idleMs = Date.now() - new Date(e.updatedAt).getTime();
    if (idleMs < timeoutMs) continue;

    // Verify pane is still alive before suspending
    if (e.tmuxPaneId) {
      const alive = await deps.isPaneAlive(e.tmuxPaneId);
      if (!alive) {
        // Pane already dead — mark terminated directly
        await deps.terminateExecutor(e.id);
        suspended.push(e.id);
        continue;
      }
    }

    const ok = await suspendWorker(e.id, deps);
    if (ok) suspended.push(e.id);
  }

  return suspended;
}
