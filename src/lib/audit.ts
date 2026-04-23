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
    // Historically `--type` only matched `event_type`, which silently
    // dropped OTel-sourced rows (they set `entity_type='otel_tool'` etc.
    // but carry a generic `event_type` like `otel_event`). Widen to
    // match either column so `--type otel_tool` does the obvious thing.
    // Closes #1259 bug 1. Strictly non-regressive — every prior match
    // still matches; the filter just returns a superset.
    conditions.push(`(event_type = $${paramIdx} OR entity_type = $${paramIdx})`);
    paramIdx++;
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
 * Follow audit events in real-time via LISTEN/NOTIFY.
 * Falls back to polling every 2s for safety (missed notifications).
 */
interface FollowAuditEventsHandle {
  stop: () => Promise<void>;
}

export async function followAuditEvents(
  options: AuditQueryOptions,
  onEvent: (row: AuditEventRow) => void,
): Promise<FollowAuditEventsHandle> {
  const sql = await getConnection();
  // Seed with latest id so we only see new events
  const seed = await sql<{ max_id: number | null }[]>`
    SELECT COALESCE(MAX(id), 0)::int AS max_id FROM audit_events
  `;
  let lastSeenId = Number(seed[0]?.max_id ?? 0);
  let active = true;
  let drainChain = Promise.resolve();

  const drain = async () => {
    if (!active) return;
    const conditions: string[] = ['id > $1'];
    const values: unknown[] = [lastSeenId];
    let paramIdx = 2;

    if (options.type) {
      // Match the widened semantics from queryAuditEvents — `--type`
      // hits both `event_type` and `entity_type` so OTel-sourced rows
      // flow through the follow path too. Closes #1259 bug 1.
      conditions.push(`(event_type = $${paramIdx} OR entity_type = $${paramIdx})`);
      paramIdx++;
      values.push(options.type);
    }
    if (options.entity) {
      conditions.push(`(entity_type = $${paramIdx} OR entity_id = $${paramIdx})`);
      paramIdx++;
      values.push(options.entity);
    }
    if (options.errorsOnly) {
      conditions.push(`(event_type LIKE '%error%' OR details::text LIKE '%error%')`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const rows = (await sql.unsafe(
      `SELECT id, entity_type, entity_id, event_type, actor, details, created_at
       FROM audit_events ${where}
       ORDER BY id ASC
       LIMIT 200`,
      values,
    )) as unknown as AuditEventRow[];

    for (const row of rows) {
      lastSeenId = row.id;
      onEvent(row);
    }
  };

  const queueDrain = () => {
    drainChain = drainChain.then(drain).catch(() => {
      /* swallow transient errors */
    });
  };

  // LISTEN on genie_audit_event channel (trigger in migration 027)
  const listener = await sql.listen('genie_audit_event', () => {
    queueDrain();
  });

  // Safety net: poll every 2s in case we miss a notification
  const pollTimer = setInterval(queueDrain, 2000);

  // Drain anything that arrived between seed and listen registration
  await drain();

  return {
    stop: async () => {
      active = false;
      clearInterval(pollTimer);
      await drainChain;
      await listener.unlisten();
    },
  };
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

  // Filter on structural signals, not substring matches:
  // - event_type names that denote failure (error / failed / rot.*)
  // - JSONB key 'error' or 'error_type' present on details (explicit error payload)
  // - state_changed where the new state value is literally 'error'
  //
  // Note: `reason` / `stderr` intentionally do NOT widen the filter. They're
  // extracted from details (see COALESCE below) but only when the event has
  // ALREADY qualified as an error via another predicate — otherwise benign
  // events like `turn_close.done` (which carries `reason: "user_requested"`)
  // would pollute the result set.
  //
  // Extract the human message from whichever key the producer used: error,
  // message, error_type, reason (state_changed carries this), or stderr.
  // NOTE: keep the COALESCE expression in SELECT and GROUP BY identical.
  const messageExpr = `COALESCE(
       NULLIF(details->>'error', ''),
       NULLIF(details->>'message', ''),
       NULLIF(details->>'error_type', ''),
       NULLIF(details->>'reason', ''),
       NULLIF(details->>'stderr', ''),
       '(no message)'
     )`;

  const rows = await sql.unsafe(
    `SELECT
       event_type,
       entity_id,
       ${messageExpr} AS error_message,
       COUNT(*)::int AS count,
       MAX(created_at) AS last_seen
     FROM audit_events
     WHERE (
         event_type LIKE '%error%'
         OR event_type LIKE '%failed%'
         OR event_type LIKE 'rot.%'
         OR details ? 'error'
         OR details ? 'error_type'
         OR (event_type = 'state_changed' AND details->>'state' = 'error')
       )
       AND created_at >= $1::timestamptz
     GROUP BY event_type, entity_id, ${messageExpr}
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

// ============================================================================
// Cost Breakdown — aggregate cost_usd from otel_api events
// ============================================================================

export interface CostBreakdownRow {
  group_key: string;
  total_cost: number;
  request_count: number;
  avg_cost: number;
}

export async function queryCostBreakdown(
  since: string,
  groupBy: 'agent' | 'wish' | 'model' = 'agent',
): Promise<CostBreakdownRow[]> {
  const sql = await getConnection();
  const sinceTs = parseSince(since);

  const groupExpr =
    groupBy === 'agent'
      ? "COALESCE(actor, 'unknown')"
      : groupBy === 'wish'
        ? "COALESCE(details->>'wish_slug', entity_id)"
        : "COALESCE(details->>'model', 'unknown')";

  const rows = await sql.unsafe(
    `SELECT
       ${groupExpr} AS group_key,
       COALESCE(SUM((details->>'cost_usd')::numeric), 0)::float AS total_cost,
       COUNT(*)::int AS request_count,
       COALESCE(AVG((details->>'cost_usd')::numeric), 0)::float AS avg_cost
     FROM audit_events
     WHERE entity_type = 'otel_api'
       AND created_at >= $1::timestamptz
     GROUP BY ${groupExpr}
     ORDER BY total_cost DESC
     LIMIT 100`,
    [sinceTs],
  );

  return rows as unknown as CostBreakdownRow[];
}

// ============================================================================
// Tool Usage — aggregate tool results from otel_tool events
// ============================================================================

export interface ToolUsageRow {
  group_key: string;
  total_calls: number;
  success_count: number;
  error_count: number;
  avg_duration_ms: number | null;
}

export async function queryToolUsage(since: string, groupBy: 'tool' | 'agent' = 'tool'): Promise<ToolUsageRow[]> {
  const sql = await getConnection();
  const sinceTs = parseSince(since);

  const groupExpr = groupBy === 'tool' ? "COALESCE(details->>'tool_name', entity_id)" : "COALESCE(actor, 'unknown')";

  const rows = await sql.unsafe(
    `SELECT
       ${groupExpr} AS group_key,
       COUNT(*)::int AS total_calls,
       COUNT(*) FILTER (WHERE event_type NOT LIKE '%error%' AND NOT (details ? 'error'))::int AS success_count,
       COUNT(*) FILTER (WHERE event_type LIKE '%error%' OR (details ? 'error'))::int AS error_count,
       AVG((details->>'duration_ms')::numeric)::float AS avg_duration_ms
     FROM audit_events
     WHERE entity_type = 'otel_tool'
       AND created_at >= $1::timestamptz
     GROUP BY ${groupExpr}
     ORDER BY total_calls DESC
     LIMIT 100`,
    [sinceTs],
  );

  return rows as unknown as ToolUsageRow[];
}

// ============================================================================
// Timeline — all events for an entity, ordered by time
// ============================================================================

export async function queryTimeline(entityId: string): Promise<AuditEventRow[]> {
  const sql = await getConnection();

  const rows = await sql.unsafe(
    `SELECT id, entity_type, entity_id, event_type, actor, details, created_at
     FROM audit_events
     WHERE (entity_id = $1
        OR actor = $1
        OR details->>'traceId' = $1
        OR details->>'session_id' = $1)
       AND event_type != 'sdk.stream.partial'
     ORDER BY created_at ASC
     LIMIT 500`,
    [entityId],
  );

  return rows as unknown as AuditEventRow[];
}

// ============================================================================
// Summary — high-level stats
// ============================================================================

export interface EventSummary {
  agents_spawned: number;
  tasks_moved: number;
  total_cost: number;
  error_count: number;
  total_events: number;
  tool_calls: number;
  api_requests: number;
}

export async function querySummary(since: string): Promise<EventSummary> {
  const sql = await getConnection();
  const sinceTs = parseSince(since);

  const rows = await sql.unsafe(
    `SELECT
       COUNT(*) FILTER (WHERE entity_type = 'worker' AND event_type = 'spawn')::int AS agents_spawned,
       COUNT(*) FILTER (WHERE entity_type = 'task' AND event_type = 'stage_change')::int AS tasks_moved,
       COALESCE(SUM((details->>'cost_usd')::numeric) FILTER (WHERE entity_type = 'otel_api'), 0)::float AS total_cost,
       COUNT(*) FILTER (WHERE event_type LIKE '%error%' OR (details ? 'error'))::int AS error_count,
       COUNT(*)::int AS total_events,
       COUNT(*) FILTER (WHERE entity_type = 'otel_tool')::int AS tool_calls,
       COUNT(*) FILTER (WHERE entity_type = 'otel_api')::int AS api_requests
     FROM audit_events
     WHERE created_at >= $1::timestamptz`,
    [sinceTs],
  );

  const r = rows[0] ?? {};
  return {
    agents_spawned: r.agents_spawned ?? 0,
    tasks_moved: r.tasks_moved ?? 0,
    total_cost: r.total_cost ?? 0,
    error_count: r.error_count ?? 0,
    total_events: r.total_events ?? 0,
    tool_calls: r.tool_calls ?? 0,
    api_requests: r.api_requests ?? 0,
  };
}

// ============================================================================
// traceId generation for cross-repo correlation
// ============================================================================

export function generateTraceId(): string {
  return crypto.randomUUID();
}
