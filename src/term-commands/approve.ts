/**
 * Approve command - Auto-approve engine management and manual approval
 *
 * Usage:
 *   term approve --status                  - Show pending/approved/denied requests
 *   term approve <request-id>              - Manually approve a pending request
 *   term approve --deny <request-id>       - Manually deny a pending request
 *   term approve --start                   - Start the auto-approve engine
 *   term approve --stop                    - Stop the auto-approve engine
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  createAutoApproveEngine,
  sendApprovalViaTmux,
  type AuditLogEntry,
  type AutoApproveEngine,
} from '../lib/auto-approve-engine.js';
import { loadAutoApproveConfig } from '../lib/auto-approve.js';
import {
  createPermissionRequestQueue,
  type PermissionRequestQueue,
} from '../lib/event-listener.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Status entry representing a request's current state
 */
export interface StatusEntry {
  /** Request ID */
  requestId: string;
  /** Tool name */
  toolName: string;
  /** Pane ID */
  paneId: string | undefined;
  /** Current status */
  status: 'pending' | 'approved' | 'denied' | 'escalated';
  /** Reason for the decision (empty for pending) */
  reason: string;
  /** ISO timestamp */
  timestamp: string;
}

/**
 * Options for getStatusEntries
 */
export interface GetStatusOptions {
  /** Base directory where .genie/auto-approve-audit.jsonl lives */
  auditDir: string;
  /** The permission request queue for pending items */
  queue: PermissionRequestQueue;
}

/**
 * Options for manual approve/deny
 */
export interface ManualActionOptions {
  /** The permission request queue */
  queue: PermissionRequestQueue;
}

/**
 * Options for starting the engine
 */
export interface StartEngineOptions {
  /** Base directory for the audit log */
  auditDir: string;
  /** Repository path for config loading */
  repoPath: string;
}

// ============================================================================
// Module State
// ============================================================================

let currentEngine: AutoApproveEngine | null = null;
let sharedQueue: PermissionRequestQueue = createPermissionRequestQueue();

/**
 * Get the shared queue (for use by other modules)
 */
export function getSharedQueue(): PermissionRequestQueue {
  return sharedQueue;
}

// ============================================================================
// Status
// ============================================================================

const AUDIT_LOG_FILENAME = 'auto-approve-audit.jsonl';

/**
 * Read audit log entries from disk
 */
function readAuditLog(auditDir: string): AuditLogEntry[] {
  const logPath = join(auditDir, '.genie', AUDIT_LOG_FILENAME);
  if (!existsSync(logPath)) {
    return [];
  }

  try {
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n').filter((line) => line.trim());
    const entries: AuditLogEntry[] = [];

    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as AuditLogEntry);
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * Map an audit action to a status string
 */
function actionToStatus(action: 'approve' | 'deny' | 'escalate'): StatusEntry['status'] {
  switch (action) {
    case 'approve':
      return 'approved';
    case 'deny':
      return 'denied';
    case 'escalate':
      return 'escalated';
  }
}

/**
 * Get all status entries (pending from queue + completed from audit log).
 *
 * @param options - Options containing auditDir and queue
 * @returns Array of StatusEntry, audit log entries first then pending
 */
export function getStatusEntries(options: GetStatusOptions): StatusEntry[] {
  const entries: StatusEntry[] = [];

  // 1. Read completed entries from audit log
  const auditEntries = readAuditLog(options.auditDir);
  for (const audit of auditEntries) {
    entries.push({
      requestId: audit.requestId,
      toolName: audit.toolName,
      paneId: audit.paneId,
      status: actionToStatus(audit.action),
      reason: audit.reason,
      timestamp: audit.timestamp,
    });
  }

  // 2. Add pending entries from queue
  const pending = options.queue.getAll();
  for (const req of pending) {
    entries.push({
      requestId: req.id,
      toolName: req.toolName,
      paneId: req.paneId,
      status: 'pending',
      reason: '',
      timestamp: req.timestamp,
    });
  }

  return entries;
}

// ============================================================================
// Manual Approve / Deny
// ============================================================================

/**
 * Manually approve a pending request by removing it from the queue.
 * In a full implementation, this would also send approval via tmux.
 *
 * @param requestId - The request ID to approve
 * @param options - Options containing the queue
 * @returns true if the request was found and approved, false otherwise
 */
export function manualApprove(requestId: string, options: ManualActionOptions): boolean {
  const request = options.queue.get(requestId);
  if (!request) {
    return false;
  }

  options.queue.remove(requestId);
  return true;
}

/**
 * Manually deny a pending request by removing it from the queue.
 *
 * @param requestId - The request ID to deny
 * @param options - Options containing the queue
 * @returns true if the request was found and denied, false otherwise
 */
export function manualDeny(requestId: string, options: ManualActionOptions): boolean {
  const request = options.queue.get(requestId);
  if (!request) {
    return false;
  }

  options.queue.remove(requestId);
  return true;
}

// ============================================================================
// Engine Lifecycle
// ============================================================================

/**
 * Check if the auto-approve engine is currently running.
 */
export function isEngineRunning(): boolean {
  return currentEngine !== null && currentEngine.isRunning();
}

/**
 * Start the auto-approve engine.
 *
 * Loads config from the repo path and creates an engine instance.
 *
 * @param options - Options with auditDir and repoPath
 */
export async function startEngine(options: StartEngineOptions): Promise<void> {
  // If already running, do nothing
  if (currentEngine && currentEngine.isRunning()) {
    return;
  }

  const config = await loadAutoApproveConfig(options.repoPath);

  currentEngine = createAutoApproveEngine({
    config,
    auditDir: options.auditDir,
    sendApproval: sendApprovalViaTmux,
  });

  currentEngine.start();
}

/**
 * Stop the auto-approve engine.
 */
export function stopEngine(): void {
  if (currentEngine) {
    currentEngine.stop();
    currentEngine = null;
  }
}

// ============================================================================
// CLI Command Handler
// ============================================================================

export interface ApproveCommandOptions {
  status?: boolean;
  deny?: string;
  start?: boolean;
  stop?: boolean;
}

/**
 * Main CLI command handler for `term approve`.
 *
 * Dispatches to the appropriate sub-function based on options:
 * - --status: show pending/approved/denied requests
 * - --start: start the auto-approve engine
 * - --stop: stop the auto-approve engine
 * - --deny <id>: manually deny a pending request
 * - <request-id> (argument): manually approve a pending request
 */
export async function approveCommand(
  requestId: string | undefined,
  options: ApproveCommandOptions
): Promise<void> {
  const repoPath = process.cwd();
  const auditDir = repoPath;

  // --status: show all requests
  if (options.status) {
    const entries = getStatusEntries({ auditDir, queue: sharedQueue });
    if (entries.length === 0) {
      console.log('No auto-approve requests found.');
      return;
    }

    console.log('Auto-Approve Requests:');
    console.log('');
    for (const entry of entries) {
      const statusLabel = entry.status.toUpperCase().padEnd(10);
      const pane = entry.paneId ?? 'N/A';
      console.log(`  [${statusLabel}] ${entry.requestId}  ${entry.toolName}  pane:${pane}  ${entry.timestamp}`);
      if (entry.reason) {
        console.log(`              Reason: ${entry.reason}`);
      }
    }
    return;
  }

  // --start: start the auto-approve engine
  if (options.start) {
    if (isEngineRunning()) {
      console.log('Auto-approve engine is already running.');
      return;
    }
    await startEngine({ auditDir, repoPath });
    console.log('Auto-approve engine started.');
    return;
  }

  // --stop: stop the auto-approve engine
  if (options.stop) {
    if (!isEngineRunning()) {
      console.log('Auto-approve engine is not running.');
      return;
    }
    stopEngine();
    console.log('Auto-approve engine stopped.');
    return;
  }

  // --deny <id>: manually deny a pending request
  if (options.deny) {
    const denied = manualDeny(options.deny, { queue: sharedQueue });
    if (denied) {
      console.log(`Denied request: ${options.deny}`);
    } else {
      console.error(`Request "${options.deny}" not found in pending queue.`);
      process.exit(1);
    }
    return;
  }

  // <request-id>: manually approve a pending request
  if (requestId) {
    const approved = manualApprove(requestId, { queue: sharedQueue });
    if (approved) {
      console.log(`Approved request: ${requestId}`);
    } else {
      console.error(`Request "${requestId}" not found in pending queue.`);
      process.exit(1);
    }
    return;
  }

  // No option provided - show help
  console.log('Usage:');
  console.log('  term approve --status              Show pending/approved/denied requests');
  console.log('  term approve <request-id>          Manually approve a pending request');
  console.log('  term approve --deny <request-id>   Manually deny a pending request');
  console.log('  term approve --start               Start the auto-approve engine');
  console.log('  term approve --stop                Stop the auto-approve engine');
}
