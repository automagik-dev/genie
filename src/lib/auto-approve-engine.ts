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
 * 4. Log every decision to audit file: .genie/auto-approve-audit.jsonl
 * 5. If denied/escalated: log it but don't send keys (human must decide)
 * 6. Expose start/stop for the engine
 */

import { join } from 'path';
import { mkdirSync, appendFileSync, existsSync } from 'fs';
import { evaluateRequest, type AutoApproveConfig, type Decision } from './auto-approve.js';
import { extractPermissionRequest, type PermissionRequest } from './event-listener.js';
import { executeTmux } from './tmux.js';
import type { NormalizedEvent } from '../term-commands/events.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Audit log entry written to .genie/auto-approve-audit.jsonl
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
export interface AutoApproveEngineOptions {
  /** The merged auto-approve configuration */
  config: AutoApproveConfig;
  /** Base directory for the audit log (audit log goes in <auditDir>/.genie/auto-approve-audit.jsonl) */
  auditDir: string;
  /**
   * Function to send approval to a tmux pane.
   * Defaults to sendApprovalViaTmux if not provided.
   * Can be overridden for testing.
   */
  sendApproval: (paneId: string) => Promise<void>;
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
// Audit Log
// ============================================================================

const AUDIT_LOG_FILENAME = 'auto-approve-audit.jsonl';

/**
 * Get the path to the audit log file
 */
function getAuditLogPath(auditDir: string): string {
  return join(auditDir, '.genie', AUDIT_LOG_FILENAME);
}

/**
 * Ensure the directory for the audit log exists
 */
function ensureAuditDir(auditDir: string): void {
  const dir = join(auditDir, '.genie');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Append an audit log entry to the JSONL audit file
 */
function writeAuditEntry(auditDir: string, entry: AuditLogEntry): void {
  ensureAuditDir(auditDir);
  const logPath = getAuditLogPath(auditDir);
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(logPath, line, 'utf-8');
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
  const { config, auditDir, sendApproval } = options;

  let running = false;
  let stats: EngineStats = { approved: 0, denied: 0, escalated: 0, total: 0 };

  function resetStats(): void {
    stats = { approved: 0, denied: 0, escalated: 0, total: 0 };
  }

  async function processRequest(request: PermissionRequest): Promise<Decision> {
    // If the engine is not running, escalate with a clear reason
    if (!running) {
      return {
        action: 'escalate',
        reason: 'Auto-approve engine is not running; request requires human review',
      };
    }

    // SECURITY: Validate paneId to prevent command injection
    if (request.paneId && !isValidPaneId(request.paneId)) {
      const escalateDecision: Decision = {
        action: 'escalate',
        reason: `Security: invalid pane ID "${request.paneId}" — possible command injection; escalating to human review`,
      };

      const auditEntry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        paneId: request.paneId,
        toolName: request.toolName,
        action: escalateDecision.action,
        reason: escalateDecision.reason,
        wishId: request.wishId,
        requestId: request.id,
      };

      try {
        writeAuditEntry(auditDir, auditEntry);
      } catch (_err) {
        // Best-effort audit for invalid paneId; escalation still happens
      }

      stats.total++;
      stats.escalated++;
      return escalateDecision;
    }

    // Evaluate the request against the config
    const decision = evaluateRequest(request, config);

    // Build the audit log entry
    const auditEntry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      paneId: request.paneId,
      toolName: request.toolName,
      action: decision.action,
      reason: decision.reason,
      wishId: request.wishId,
      requestId: request.id,
    };

    // Write audit log entry — escalate if audit trail cannot be written
    try {
      writeAuditEntry(auditDir, auditEntry);
    } catch (err) {
      // Cannot guarantee audit trail; escalate instead of approving silently
      const auditFailDecision: Decision = {
        action: 'escalate',
        reason: `Audit log write failed (${err instanceof Error ? err.message : String(err)}); escalating to human review to preserve audit trail`,
      };
      stats.total++;
      stats.escalated++;
      return auditFailDecision;
    }

    // Update stats
    stats.total++;
    if (decision.action === 'approve') {
      stats.approved++;
    } else if (decision.action === 'deny') {
      stats.denied++;
    } else {
      stats.escalated++;
    }

    // If approved and we have a pane ID, send approval
    if (decision.action === 'approve' && request.paneId) {
      try {
        await sendApproval(request.paneId);
      } catch (err) {
        // Approval was logged but delivery failed — write a delivery failure audit entry
        const deliveryFailEntry: AuditLogEntry = {
          timestamp: new Date().toISOString(),
          paneId: request.paneId,
          toolName: request.toolName,
          action: 'escalate',
          reason: `Approval delivery failed via sendApproval (${err instanceof Error ? err.message : String(err)}); send-keys did not reach pane`,
          wishId: request.wishId,
          requestId: request.id,
        };
        try {
          writeAuditEntry(auditDir, deliveryFailEntry);
        } catch (_auditErr) {
          // Best-effort: if audit also fails here, we already logged the decision above
        }
      }
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
