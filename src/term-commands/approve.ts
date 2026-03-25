/**
 * Approve command - Auto-approve engine management and manual approval
 *
 * Usage:
 *   genie agent approve --status                  - Show pending/approved/denied requests
 *   genie agent approve <request-id>              - Manually approve a pending request
 *   genie agent approve --deny <request-id>       - Manually deny a pending request
 *   genie agent approve --start                   - Start the auto-approve engine
 *   genie agent approve --stop                    - Stop the auto-approve engine
 */

import { type AutoApproveEngine, createAutoApproveEngine, sendApprovalViaTmux } from '../lib/auto-approve-engine.js';
import { loadAutoApproveConfig } from '../lib/auto-approve.js';
import { getConnection } from '../lib/db.js';
import type { PermissionRequestQueue } from '../lib/event-listener.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Status entry representing a request's current state
 */
interface StatusEntry {
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
interface GetStatusOptions {
  /** The permission request queue for pending items */
  queue: PermissionRequestQueue;
  /** @deprecated No longer used — audit events are read from PG. Kept for backward compat. */
  auditDir?: string;
}

/**
 * Options for manual approve/deny
 */
interface ManualActionOptions {
  /** The permission request queue */
  queue: PermissionRequestQueue;
}

/**
 * Options for starting the engine
 */
interface StartEngineOptions {
  /** Repository path for config loading */
  repoPath: string;
}

// ============================================================================
// Module State
// ============================================================================

let currentEngine: AutoApproveEngine | null = null;

// ============================================================================
// Status
// ============================================================================

/**
 * Map an audit event_type to a status string
 */
function eventTypeToStatus(eventType: string): StatusEntry['status'] {
  switch (eventType) {
    case 'approve':
      return 'approved';
    case 'deny':
      return 'denied';
    case 'escalate':
      return 'escalated';
    default:
      return 'escalated';
  }
}

/**
 * Get all status entries (pending from queue + completed from audit_events PG).
 *
 * @param options - Options containing queue
 * @returns Array of StatusEntry, audit log entries first then pending
 */
export async function getStatusEntries(options: GetStatusOptions): Promise<StatusEntry[]> {
  const entries: StatusEntry[] = [];

  // 1. Read completed entries from audit_events PG table
  try {
    const sql = await getConnection();
    const auditRows = await sql`
      SELECT id, entity_type, entity_id, event_type, actor, details, created_at
      FROM audit_events WHERE entity_type = 'approval'
      ORDER BY created_at DESC LIMIT 100
    `;
    for (const row of auditRows) {
      entries.push({
        requestId: row.entity_id,
        toolName: (row.details?.toolName as string) ?? '',
        paneId: (row.details?.paneId as string) ?? undefined,
        status: eventTypeToStatus(row.event_type),
        reason: (row.details?.reason as string) ?? '',
        timestamp: row.created_at,
      });
    }
  } catch {
    // PG may be unavailable — continue with pending only
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
  // biome-ignore lint/complexity/useOptionalChain: optional chain returns boolean|undefined, breaking the return type
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
  if (currentEngine?.isRunning()) {
    return;
  }

  const config = await loadAutoApproveConfig(options.repoPath);

  currentEngine = createAutoApproveEngine({
    config,
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
