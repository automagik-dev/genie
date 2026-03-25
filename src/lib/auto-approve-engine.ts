/**
 * Auto-Approve Engine
 *
 * Ties together config loading (Group A), event subscription (Group B),
 * and rule matching (Group C) to automatically approve safe operations.
 *
 * Flow:
 * 1. Watch for permission_request events (from event-listener)
 * 2. Evaluate each request against config (from auto-approve evaluateRequest)
 * 3. If approved: send approval via tmux send-keys -t <pane> Enter
 * 4. Log every decision to audit_events PG table via recordAuditEvent()
 * 5. If denied/escalated: log it but don't send keys (human must decide)
 * 6. Expose start/stop for the engine
 */

import type { NormalizedEvent } from '../term-commands/events.js';
import { recordAuditEvent } from './audit.js';
import { type AutoApproveConfig, type Decision, evaluateRequest } from './auto-approve.js';
import { type PermissionRequest, extractPermissionRequest } from './event-listener.js';
import { executeTmux } from './tmux.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Audit log entry written to audit_events PG table
 */
export interface AuditLogEntry {
  /** ISO timestamp of the decision */
  timestamp: string;
  /** tmux pane ID (e.g., "%42") */
  paneId: string | undefined;
  /** Tool name that was evaluated */
  toolName: string;
  /** Decision action: approve, deny, or escalate */
  action: 'approve' | 'deny' | 'escalate';
  /** Human-readable reason for the decision */
  reason: string;
  /** Associated wish ID */
  wishId: string | undefined;
  /** The permission request ID */
  requestId: string;
}

/**
 * Engine statistics
 */
export interface EngineStats {
  /** Number of approved requests */
  approved: number;
  /** Number of denied requests */
  denied: number;
  /** Number of escalated requests */
  escalated: number;
  /** Total number of processed requests */
  total: number;
}

/**
 * Options for creating an auto-approve engine
 */
interface AutoApproveEngineOptions {
  /** The merged auto-approve configuration */
  config: AutoApproveConfig;
  /**
   * Function to send approval to a tmux pane.
   * Defaults to sendApprovalViaTmux if not provided.
   * Can be overridden for testing.
   */
  sendApproval: (paneId: string) => Promise<void>;
  /** @deprecated No longer used — audit events are written to PG via recordAuditEvent(). Kept for backward compat. */
  auditDir?: string;
}

/**
 * Auto-approve engine instance
 */
export interface AutoApproveEngine {
  /** Start the engine (begins processing requests) */
  start: () => void;
  /** Stop the engine (stops processing requests) */
  stop: () => void;
  /** Check if the engine is currently running */
  isRunning: () => boolean;
  /** Process a single permission request and return the decision */
  processRequest: (request: PermissionRequest) => Promise<Decision>;
  /** Process a normalized event (extracts permission request if applicable) */
  processEvent: (event: NormalizedEvent) => Promise<void>;
  /** Get engine statistics */
  getStats: () => EngineStats;
}

// ============================================================================
// Pane ID Validation
// ============================================================================

/**
 * Validate that a tmux pane ID matches the expected format: %<digits>.
 * This prevents command injection via crafted pane IDs.
 *
 * @param paneId - The pane ID to validate
 * @returns true if the paneId matches /^%\d+$/, false otherwise
 */
export function isValidPaneId(paneId: string): boolean {
  return /^%\d+$/.test(paneId);
}

// ============================================================================
// Tmux Approval
// ============================================================================

/**
 * Send an approval to a tmux pane by sending the Enter key.
 * This is the default implementation that uses the existing tmux wrapper.
 *
 * @param paneId - The tmux pane ID (e.g., "%42")
 */
export async function sendApprovalViaTmux(paneId: string): Promise<void> {
  await executeTmux(`send-keys -t '${paneId}' Enter`);
}

// ============================================================================
// Engine
// ============================================================================

/**
 * Create an auto-approve engine instance.
 *
 * The engine evaluates permission requests against a configuration and:
 * - Approves safe requests by sending Enter to the tmux pane
 * - Denies or escalates unsafe requests (logged but not acted on)
 * - Logs every decision to the audit file
 *
 * @param options - Engine configuration options
 * @returns AutoApproveEngine instance
 */
export function createAutoApproveEngine(options: AutoApproveEngineOptions): AutoApproveEngine {
  const { config, sendApproval } = options;

  let running = false;
  let stats: EngineStats = { approved: 0, denied: 0, escalated: 0, total: 0 };

  function resetStats(): void {
    stats = { approved: 0, denied: 0, escalated: 0, total: 0 };
  }

  /** Record an auto-approve decision to audit_events in PG (best-effort). */
  function auditDecision(request: PermissionRequest, decision: Decision): void {
    recordAuditEvent('approval', request.id, decision.action, request.paneId ?? null, {
      toolName: request.toolName,
      reason: decision.reason,
      wishId: request.wishId,
      paneId: request.paneId,
    }).catch(() => {});
  }

  function recordStat(action: Decision['action']): void {
    stats.total++;
    if (action === 'approve') stats.approved++;
    else if (action === 'deny') stats.denied++;
    else stats.escalated++;
  }

  function escalate(reason: string): Decision {
    return { action: 'escalate', reason };
  }

  async function deliverApproval(request: PermissionRequest): Promise<void> {
    if (!request.paneId) return;
    try {
      await sendApproval(request.paneId);
    } catch (err) {
      auditDecision(
        request,
        escalate(
          `Approval delivery failed via sendApproval (${err instanceof Error ? err.message : String(err)}); send-keys did not reach pane`,
        ),
      );
    }
  }

  async function processRequest(request: PermissionRequest): Promise<Decision> {
    if (!running) {
      return escalate('Auto-approve engine is not running; request requires human review');
    }

    // SECURITY: Validate paneId to prevent command injection
    if (request.paneId && !isValidPaneId(request.paneId)) {
      const decision = escalate(
        `Security: invalid pane ID "${request.paneId}" — possible command injection; escalating to human review`,
      );
      auditDecision(request, decision);
      recordStat(decision.action);
      return decision;
    }

    const decision = evaluateRequest(request, config);

    // Record audit event to PG (best-effort, never blocks)
    auditDecision(request, decision);

    recordStat(decision.action);

    if (decision.action === 'approve') {
      await deliverApproval(request);
    }

    return decision;
  }

  async function processEvent(event: NormalizedEvent): Promise<void> {
    // Only process when running
    if (!running) {
      return;
    }

    // Only handle permission_request events
    if (event.type !== 'permission_request') {
      return;
    }

    // Extract the permission request from the event
    const request = extractPermissionRequest(event);
    if (!request) {
      return;
    }

    // Process the extracted request
    await processRequest(request);
  }

  return {
    start(): void {
      if (running) return;
      resetStats();
      running = true;
    },

    stop(): void {
      if (!running) return;
      running = false;
    },

    isRunning(): boolean {
      return running;
    },

    processRequest,
    processEvent,

    getStats(): EngineStats {
      return { ...stats };
    },
  };
}
