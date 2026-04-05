/**
 * Shared audit event types and recording helper.
 *
 * Used by the SDK executor (Group 5) and resume logic (Group 7).
 * Writes to the `audit_events` table via safePgCall so degraded-mode
 * (no PG) silently skips — no throw, no data loss risk.
 */

import type { SafePgCallFn } from './safe-pg-call.js';

// ============================================================================
// Audit event type union
// ============================================================================

export type AuditEventType =
  // Lifecycle
  | 'executor.spawn'
  | 'executor.shutdown'
  | 'executor.state_transition'
  // Delivery
  | 'deliver.start'
  | 'deliver.end'
  | 'deliver.error'
  | 'deliver.tool_use'
  // Resume (Group 7)
  | 'session.resumed'
  | 'session.resume_rejected'
  | 'session.created_fresh';

// ============================================================================
// Record helper
// ============================================================================

/**
 * Write an audit event row via safePgCall.
 *
 * Maps to the real audit_events schema:
 *   entity_type, entity_id, event_type, actor, details, created_at
 *
 * `entityType` defaults to 'executor' when not provided in attrs.
 * `entityId` defaults to attrs.executor_id.
 * `actor` defaults to attrs.agent_id.
 */
export async function recordAuditEvent(
  safePgCall: SafePgCallFn,
  type: AuditEventType,
  attrs: Record<string, unknown>,
): Promise<void> {
  const entityType = (attrs.entity_type as string) ?? 'executor';
  const entityId = (attrs.entity_id as string) ?? (attrs.executor_id as string) ?? '';
  const actor = (attrs.actor as string) ?? (attrs.agent_id as string) ?? null;

  // Strip meta keys from details — they're top-level columns already.
  const { entity_type: _et, entity_id: _eid, actor: _a, ...details } = attrs;

  await safePgCall(
    `audit:${type}`,
    (sql) =>
      sql`INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details)
          VALUES (${entityType}, ${entityId}, ${type}, ${actor}, ${JSON.stringify(details)})`,
    undefined,
    { executorId: entityId, chatId: (attrs.chat_id as string) ?? '' },
  );
}
