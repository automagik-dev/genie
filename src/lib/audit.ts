/**
 * Audit Events — write to the `audit_events` table.
 *
 * Best-effort: never throws, never blocks the CLI. If the DB is
 * unavailable the event is silently dropped.
 *
 * Usage:
 *   import { recordAuditEvent } from './audit.js';
 *   await recordAuditEvent('command', 'spawn', 'command_start', 'engineer', { args: ['myagent'] });
 */

import { getConnection, isAvailable } from './db.js';

/**
 * Record an audit event in the `audit_events` table.
 *
 * @param entityType  - Category (e.g., 'command', 'task', 'worker')
 * @param entityId    - Specific entity identifier (e.g., command name, task id, worker id)
 * @param eventType   - What happened (e.g., 'command_start', 'stage_change', 'spawn')
 * @param actor       - Who triggered it (GENIE_AGENT_NAME or 'cli')
 * @param details     - Arbitrary JSON payload
 */
export async function recordAuditEvent(
  entityType: string,
  entityId: string,
  eventType: string,
  actor?: string | null,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    if (!(await isAvailable())) return;
    const sql = await getConnection();
    await sql`
      INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details)
      VALUES (${entityType}, ${entityId}, ${eventType}, ${actor ?? null}, ${sql.json(details ?? {})})
    `;
  } catch {
    // Best effort — never block the CLI on audit failure
  }
}

/**
 * Query audit events with optional filters.
 */
export interface AuditEventRow {
  id: number;
  entity_type: string;
  entity_id: string;
  event_type: string;
  actor: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface AuditQueryOptions {
  type?: string;
  entity?: string;
  since?: string;
  errorsOnly?: boolean;
  limit?: number;
}

/**
 * Parse a human-friendly duration like "1h", "30m", "2d" into an ISO timestamp.
 */
function parseSince(since: string): string {
  const match = since.match(/^(\d+)([smhd])$/);
  if (!match) {
    // Assume it's already an ISO timestamp
    return since;
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const ms = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 3_600_000;
  return new Date(Date.now() - amount * ms).toISOString();
}

export async function queryAuditEvents(options: AuditQueryOptions = {}): Promise<AuditEventRow[]> {
  const sql = await getConnection();
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (options.type) {
    conditions.push(`event_type = $${paramIdx++}`);
    values.push(options.type);
  }
  if (options.entity) {
    conditions.push(`(entity_type = $${paramIdx} OR entity_id = $${paramIdx})`);
    paramIdx++;
    values.push(options.entity);
  }
  if (options.since) {
    conditions.push(`created_at >= $${paramIdx++}::timestamptz`);
    values.push(parseSince(options.since));
  }
  if (options.errorsOnly) {
    conditions.push(`event_type LIKE '%error%' OR (details::text LIKE '%error%')`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? 50;

  const rows = await sql.unsafe(
    `SELECT id, entity_type, entity_id, event_type, actor, details, created_at
     FROM audit_events ${where}
     ORDER BY created_at DESC
     LIMIT ${limit}`,
    values,
  );

  return rows as unknown as AuditEventRow[];
}

/**
 * Get aggregated error patterns from audit events.
 */
export interface ErrorPattern {
  event_type: string;
  entity_id: string;
  error_message: string;
  count: number;
  last_seen: string;
}

export async function queryErrorPatterns(since?: string): Promise<ErrorPattern[]> {
  const sql = await getConnection();
  const sinceTs = since ? parseSince(since) : new Date(Date.now() - 86_400_000).toISOString();

  const rows = await sql.unsafe(
    `SELECT
       event_type,
       entity_id,
       COALESCE(details->>'error', details->>'message', '(no message)') as error_message,
       COUNT(*)::int as count,
       MAX(created_at) as last_seen
     FROM audit_events
     WHERE (event_type LIKE '%error%' OR details::text LIKE '%"error"%')
       AND created_at >= $1::timestamptz
     GROUP BY event_type, entity_id, COALESCE(details->>'error', details->>'message', '(no message)')
     ORDER BY count DESC
     LIMIT 50`,
    [sinceTs],
  );

  return rows as unknown as ErrorPattern[];
}

/**
 * Get the actor string for audit events.
 * Uses GENIE_AGENT_NAME if set, otherwise 'cli'.
 */
export function getActor(): string {
  return process.env.GENIE_AGENT_NAME ?? 'cli';
}
