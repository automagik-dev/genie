/**
 * OTel OTLP Receiver — Lightweight HTTP/JSON receiver for Claude Code telemetry.
 *
 * Receives OTLP HTTP/JSON log and metric exports from Claude Code sessions,
 * maps them to audit_events rows, and INSERTs to PostgreSQL.
 *
 * - POST /v1/logs   → parse OTLP log events → audit_events
 * - POST /v1/metrics → parse OTLP metrics → audit_events
 *
 * Lazy start: called on first `genie spawn`, not on CLI boot.
 * Graceful: if port busy, logs warning and returns (non-fatal).
 */

import { getAuxiliaryPortBase } from './db.js';

// ============================================================================
// Types — OTLP JSON protocol (subset we care about)
// ============================================================================

interface OtlpKeyValue {
  key: string;
  value: { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean };
}

interface OtlpResource {
  attributes?: OtlpKeyValue[];
}

interface OtlpLogRecord {
  timeUnixNano?: string;
  severityText?: string;
  body?: { stringValue?: string; kvlistValue?: { values?: OtlpKeyValue[] } };
  attributes?: OtlpKeyValue[];
}

interface OtlpScopeLog {
  logRecords?: OtlpLogRecord[];
}

interface OtlpResourceLog {
  resource?: OtlpResource;
  scopeLogs?: OtlpScopeLog[];
}

interface OtlpLogsPayload {
  resourceLogs?: OtlpResourceLog[];
}

interface OtlpNumberDataPoint {
  timeUnixNano?: string;
  asInt?: string | number;
  asDouble?: number;
  attributes?: OtlpKeyValue[];
}

interface OtlpMetric {
  name?: string;
  description?: string;
  unit?: string;
  sum?: { dataPoints?: OtlpNumberDataPoint[] };
  gauge?: { dataPoints?: OtlpNumberDataPoint[] };
  histogram?: { dataPoints?: Array<{ sum?: number; count?: string | number; attributes?: OtlpKeyValue[] }> };
}

interface OtlpScopeMetric {
  metrics?: OtlpMetric[];
}

interface OtlpResourceMetric {
  resource?: OtlpResource;
  scopeMetrics?: OtlpScopeMetric[];
}

interface OtlpMetricsPayload {
  resourceMetrics?: OtlpResourceMetric[];
}

// ============================================================================
// State
// ============================================================================

let server: ReturnType<typeof Bun.serve> | null = null;
let boundOtelPort: number | null = null;

const DEFAULT_OTEL_PORT_PROBE_MAX = 8;

// ============================================================================
// Helpers
// ============================================================================

/** Extract value from OTLP key-value pair. */
function extractValue(kv: OtlpKeyValue): string | number | boolean | undefined {
  const v = kv.value;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return typeof v.intValue === 'string' ? Number.parseInt(v.intValue, 10) : v.intValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  return undefined;
}

/** Convert OTLP attributes array to a plain object. */
function attrsToObject(attrs?: OtlpKeyValue[]): Record<string, unknown> {
  if (!attrs) return {};
  const obj: Record<string, unknown> = {};
  for (const kv of attrs) {
    obj[kv.key] = extractValue(kv);
  }
  return obj;
}

/** Extract resource attributes (agent.name, team.name, session.id, etc.). */
function extractResourceContext(resource?: OtlpResource): {
  agentName?: string;
  teamName?: string;
  wishSlug?: string;
  sessionId?: string;
  agentRole?: string;
} {
  const attrs = attrsToObject(resource?.attributes);
  return {
    agentName: attrs['agent.name'] as string | undefined,
    teamName: attrs['team.name'] as string | undefined,
    wishSlug: attrs['wish.slug'] as string | undefined,
    sessionId: attrs['session.id'] as string | undefined,
    agentRole: attrs['agent.role'] as string | undefined,
  };
}

/**
 * Map a Claude Code event name to an audit_events entity_type.
 *
 * Known event names from Claude Code OTel:
 *   claude_code.tool_result   → otel_tool
 *   claude_code.api_request   → otel_api
 *   claude_code.api_error     → otel_api
 *   claude_code.user_prompt   → otel_prompt
 *   claude_code.tool_decision → otel_decision
 */
function mapEventToEntityType(eventName: string): string {
  if (eventName.includes('tool_result')) return 'otel_tool';
  if (eventName.includes('api_request') || eventName.includes('api_error')) return 'otel_api';
  if (eventName.includes('user_prompt')) return 'otel_prompt';
  if (eventName.includes('tool_decision')) return 'otel_decision';
  return 'otel_event';
}

function parseValidPort(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) return parsed;
  return null;
}

function parseProbeMax(): number {
  const parsed = Number.parseInt(process.env.GENIE_OTEL_PORT_PROBE_MAX ?? '', 10);
  if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  return DEFAULT_OTEL_PORT_PROBE_MAX;
}

function getConfiguredOtelPort(): { port: number; explicit: boolean } {
  const envPort = parseValidPort(process.env.GENIE_OTEL_PORT);
  if (envPort !== null) return { port: envPort, explicit: true };
  return { port: getAuxiliaryPortBase() + 1, explicit: false };
}

function getCandidatePorts(startPort: number, explicit: boolean): number[] {
  if (explicit) return [startPort];
  const probeCount = Math.min(parseProbeMax(), Math.max(1, 65535 - startPort + 1));
  return Array.from({ length: probeCount }, (_, index) => startPort + index);
}

function formatPortList(ports: number[]): string {
  if (ports.length === 1) return String(ports[0]);
  return `${ports[0]}-${ports[ports.length - 1]}`;
}

export function isPortBusyError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err && err.code === 'EADDRINUSE') return true;

  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('EADDRINUSE') ||
    message.includes('address already in use') ||
    /Failed to start server\. Is port \d+ in use\?/i.test(message) ||
    /\bis in use\b/i.test(message)
  );
}

// ============================================================================
// Event processing
// ============================================================================

interface AuditRow {
  entity_type: string;
  entity_id: string;
  event_type: string;
  actor: string | null;
  details: Record<string, unknown>;
}

/** Resolve entity ID from resource context. */
function resolveEntityId(ctx: ReturnType<typeof extractResourceContext>): string {
  return ctx.sessionId ?? (ctx.agentName ? `agent:${ctx.agentName}` : 'unknown');
}

/** Merge context fields into a details object. */
function mergeContext(details: Record<string, unknown>, ctx: ReturnType<typeof extractResourceContext>): void {
  if (ctx.teamName) details.team = ctx.teamName;
  if (ctx.wishSlug) details.wish_slug = ctx.wishSlug;
  if (ctx.agentRole) details.agent_role = ctx.agentRole;
  if (ctx.sessionId) details.session_id = ctx.sessionId;
}

/** Convert a single OTel log record into an AuditRow. */
function logRecordToRow(record: OtlpLogRecord, ctx: ReturnType<typeof extractResourceContext>): AuditRow {
  const logAttrs = attrsToObject(record.attributes);
  const eventName = (logAttrs['event.name'] as string) ?? record.body?.stringValue ?? 'unknown';
  const details: Record<string, unknown> = { ...logAttrs, event_name: eventName };
  mergeContext(details, ctx);
  if (record.severityText) details.severity = record.severityText;
  if (record.body?.kvlistValue?.values) {
    Object.assign(details, attrsToObject(record.body.kvlistValue.values));
  }
  return {
    entity_type: mapEventToEntityType(eventName),
    entity_id: resolveEntityId(ctx),
    event_type: eventName,
    actor: ctx.agentName ?? null,
    details,
  };
}

/** Process OTLP logs payload into audit_events rows. */
function processLogs(payload: OtlpLogsPayload): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const resourceLog of payload.resourceLogs ?? []) {
    const ctx = extractResourceContext(resourceLog.resource);
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const record of scopeLog.logRecords ?? []) {
        rows.push(logRecordToRow(record, ctx));
      }
    }
  }
  return rows;
}

/** Build a metric AuditRow from common fields. */
function buildMetricRow(
  metricName: string,
  entityId: string,
  actor: string | null,
  details: Record<string, unknown>,
): AuditRow {
  return { entity_type: 'otel_metric', entity_id: entityId, event_type: metricName, actor, details };
}

/** Extract sum/gauge data points into AuditRows. */
function processSumGaugePoints(
  dataPoints: OtlpNumberDataPoint[],
  metricName: string,
  unit: string | undefined,
  entityId: string,
  ctx: ReturnType<typeof extractResourceContext>,
): AuditRow[] {
  return dataPoints.map((dp) => {
    const dpAttrs = attrsToObject(dp.attributes);
    const value = dp.asDouble ?? (dp.asInt !== undefined ? Number(dp.asInt) : undefined);
    const details: Record<string, unknown> = { metric_name: metricName, value, ...dpAttrs };
    if (unit) details.unit = unit;
    mergeContext(details, ctx);
    return buildMetricRow(metricName, entityId, ctx.agentName ?? null, details);
  });
}

/** Convert a single OTel metric into AuditRows. */
function metricToRows(metric: OtlpMetric, ctx: ReturnType<typeof extractResourceContext>): AuditRow[] {
  const metricName = metric.name ?? 'unknown_metric';
  const entityId = resolveEntityId(ctx);
  const dataPoints = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
  const rows = processSumGaugePoints(dataPoints, metricName, metric.unit, entityId, ctx);

  for (const dp of metric.histogram?.dataPoints ?? []) {
    const dpAttrs = attrsToObject(dp.attributes);
    const details: Record<string, unknown> = {
      metric_name: metricName,
      sum: dp.sum,
      count: dp.count !== undefined ? Number(dp.count) : undefined,
      ...dpAttrs,
    };
    if (metric.unit) details.unit = metric.unit;
    mergeContext(details, ctx);
    rows.push(buildMetricRow(metricName, entityId, ctx.agentName ?? null, details));
  }
  return rows;
}

/** Process OTLP metrics payload into audit_events rows. */
function processMetrics(payload: OtlpMetricsPayload): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const resourceMetric of payload.resourceMetrics ?? []) {
    const ctx = extractResourceContext(resourceMetric.resource);
    for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
      for (const metric of scopeMetric.metrics ?? []) {
        rows.push(...metricToRows(metric, ctx));
      }
    }
  }
  return rows;
}

/** Batch-insert audit rows to PG. Fire-and-forget. */
async function flushToPg(rows: AuditRow[]): Promise<void> {
  if (rows.length === 0) return;

  try {
    const { getConnection, isAvailable } = await import('./db.js');
    if (!(await isAvailable())) return;
    const sql = await getConnection();

    // Batch insert using unnest for efficiency
    await sql`
      INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details)
      SELECT * FROM unnest(
        ${sql.array(rows.map((r) => r.entity_type))}::text[],
        ${sql.array(rows.map((r) => r.entity_id))}::text[],
        ${sql.array(rows.map((r) => r.event_type))}::text[],
        ${sql.array(rows.map((r) => r.actor ?? ''))}::text[],
        ${sql.array(rows.map((r) => JSON.stringify(r.details)))}::jsonb[]
      )
    `;
  } catch {
    // Best effort — never block on flush failure
  }
}

// ============================================================================
// Server
// ============================================================================

/**
 * Get the OTel receiver port. Default: pgserve port + 1.
 */
export function getOtelPort(): number {
  return boundOtelPort ?? getConfiguredOtelPort().port;
}

function serveOtelReceiver(port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const url = new URL(req.url);

      if (req.method === 'POST' && url.pathname === '/v1/logs') {
        try {
          const payload = (await req.json()) as OtlpLogsPayload;
          const rows = processLogs(payload);
          // Fire-and-forget — don't block the HTTP response
          flushToPg(rows).catch(() => {});
        } catch {
          // Malformed payload — ignore
        }
        return new Response('', { status: 200 });
      }

      if (req.method === 'POST' && url.pathname === '/v1/metrics') {
        try {
          const payload = (await req.json()) as OtlpMetricsPayload;
          const rows = processMetrics(payload);
          flushToPg(rows).catch(() => {});
        } catch {
          // Malformed payload — ignore
        }
        return new Response('', { status: 200 });
      }

      // Health check
      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json({ status: 'ok', port });
      }

      return new Response('Not Found', { status: 404 });
    },
  });
}

/**
 * Start the OTLP HTTP/JSON receiver.
 *
 * Lazy start: called on first `genie spawn`, not on CLI boot.
 * Idempotent: returns immediately if already running.
 * Graceful: if port busy, logs warning and returns false (non-fatal).
 */
export async function startOtelReceiver(): Promise<boolean> {
  if (server) return true;

  const { port: startPort, explicit } = getConfiguredOtelPort();
  const candidatePorts = getCandidatePorts(startPort, explicit);

  for (const port of candidatePorts) {
    try {
      server = serveOtelReceiver(port);
      boundOtelPort = server.port ?? port;
      return true;
    } catch (err) {
      if (isPortBusyError(err)) continue;

      const message = err instanceof Error ? err.message : String(err);
      console.warn(`OTel receiver: failed to start on port ${port}: ${message}`);
      return false;
    }
  }

  if (explicit) {
    console.warn(`OTel receiver: port ${startPort} already in use - skipping (another instance may be running)`);
  } else {
    console.warn(`OTel receiver: all probed ports busy (${formatPortList(candidatePorts)}) - skipping`);
  }
  return false;
}

/**
 * Stop the OTel receiver. Used in tests and graceful shutdown.
 *
 * Awaits `server.stop(true)` so the listening port is fully released before
 * the next start attempt. Also clears the remembered bound port so later
 * callers fall back to the configured default or explicit override.
 */
export async function stopOtelReceiver(): Promise<void> {
  const activeServer = server;
  server = null;
  boundOtelPort = null;
  if (activeServer) await activeServer.stop(true);
}

/**
 * Check if the OTel receiver is running.
 */
export function isOtelReceiverRunning(): boolean {
  return server !== null;
}
