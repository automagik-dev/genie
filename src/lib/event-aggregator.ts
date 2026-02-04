/**
 * Event Aggregator - Per-worker state from event stream
 *
 * Subscribes to wish-21 NormalizedEvent stream and maintains in-memory state
 * per worker. Used by the dashboard to show current worker status.
 *
 * Features:
 * - Track worker status (running/waiting/idle/stopped) from events
 * - Handle session start/stop lifecycle
 * - Detect permission_request (waiting for approval)
 * - Fallback mode: build state from worker registry when event stream unavailable
 */

import type { NormalizedEvent } from '../term-commands/events.js';
import type { Worker } from './worker-registry.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Dashboard-facing worker state derived from the event stream.
 */
export interface WorkerDashboardState {
  /** tmux pane ID (e.g., "%42") */
  paneId: string;
  /** Associated wish slug */
  wishId?: string;
  /** Current worker status */
  status: 'running' | 'waiting' | 'idle' | 'stopped';
  /** Last event received for this worker */
  lastEvent?: {
    type: string;
    toolName?: string;
    timestamp: number;
  };
  /** Epoch ms of most recent activity */
  lastActivityAt: number;
  /** Total number of events processed for this worker */
  eventCount: number;
}

/**
 * Public interface for the event aggregator.
 */
export interface EventAggregator {
  /** Process a single NormalizedEvent and update worker state */
  processEvent: (event: NormalizedEvent) => void;
  /** Get current state of all tracked workers */
  getWorkerStates: () => WorkerDashboardState[];
  /** Get state for a single worker by pane ID */
  getWorkerState: (paneId: string) => WorkerDashboardState | undefined;
  /** Clear all tracked state */
  reset: () => void;
  /** Build fallback states from worker registry data (no event stream needed) */
  buildFallbackStates: (workers: Worker[]) => WorkerDashboardState[];
}

// ============================================================================
// Status Derivation
// ============================================================================

/**
 * Derive dashboard status from a NormalizedEvent type.
 */
function statusFromEventType(eventType: NormalizedEvent['type']): WorkerDashboardState['status'] {
  switch (eventType) {
    case 'session_start':
      return 'running';
    case 'tool_call':
      return 'running';
    case 'permission_request':
      return 'waiting';
    case 'session_end':
      return 'stopped';
    default:
      return 'idle';
  }
}

/**
 * Map a worker-registry state string to a dashboard status.
 */
function registryStateToDashboardStatus(state: string): WorkerDashboardState['status'] {
  switch (state) {
    case 'working':
    case 'spawning':
      return 'running';
    case 'idle':
      return 'idle';
    case 'permission':
    case 'question':
      return 'waiting';
    case 'done':
    case 'error':
      return 'stopped';
    default:
      return 'idle';
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a new EventAggregator instance.
 *
 * The aggregator maintains an in-memory map of paneId -> WorkerDashboardState
 * and exposes methods to feed events and query current state.
 */
export function createEventAggregator(): EventAggregator {
  /** Internal mutable state keyed by pane ID */
  const workerMap = new Map<string, WorkerDashboardState>();

  function processEvent(event: NormalizedEvent): void {
    // Events without a paneId cannot be attributed to a worker
    if (!event.paneId) {
      return;
    }

    const paneId = event.paneId;
    const eventTimestamp = new Date(event.timestamp).getTime();
    const existing = workerMap.get(paneId);

    const status = statusFromEventType(event.type);

    if (existing) {
      // Update existing worker state
      existing.status = status;
      existing.lastEvent = {
        type: event.type,
        toolName: event.toolName,
        timestamp: eventTimestamp,
      };
      existing.lastActivityAt = eventTimestamp;
      existing.eventCount += 1;

      // Update wishId if present on the event
      if (event.wishId) {
        existing.wishId = event.wishId;
      }
    } else {
      // Create new worker state
      workerMap.set(paneId, {
        paneId,
        wishId: event.wishId,
        status,
        lastEvent: {
          type: event.type,
          toolName: event.toolName,
          timestamp: eventTimestamp,
        },
        lastActivityAt: eventTimestamp,
        eventCount: 1,
      });
    }
  }

  function getWorkerStates(): WorkerDashboardState[] {
    return Array.from(workerMap.values());
  }

  function getWorkerState(paneId: string): WorkerDashboardState | undefined {
    return workerMap.get(paneId);
  }

  function reset(): void {
    workerMap.clear();
  }

  function buildFallbackStates(workers: Worker[]): WorkerDashboardState[] {
    return workers.map((w) => {
      const lastStateChangeMs = new Date(w.lastStateChange).getTime();
      return {
        paneId: w.paneId,
        wishId: w.wishSlug,
        status: registryStateToDashboardStatus(w.state),
        lastActivityAt: lastStateChangeMs,
        eventCount: 0,
      };
    });
  }

  return {
    processEvent,
    getWorkerStates,
    getWorkerState,
    reset,
    buildFallbackStates,
  };
}
