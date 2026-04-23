/**
 * `genie events timeline <trace_id>` — causal tree of a trace.
 *
 * Uses a recursive CTE that walks from the trace-root span down through
 * `parent_span_id` to build a causal tree. Falls back to the JSONB-stashed
 * values (`data->>'_span_id'`, `data->>'_parent_span_id'`) for rows written
 * by the emit.ts scaffold (Group 2) before Group 3 populates the top-level
 * columns.
 *
 * Wish: genie-serve-structured-observability, Group 4.
 */

import { getConnection } from '../lib/db.js';
import { color } from '../lib/term-format.js';

interface TimelineRow {
  id: number;
  subject: string | null;
  kind: string;
  agent: string;
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  severity: string | null;
  duration_ms: number | null;
  text: string;
  data: Record<string, unknown> | null;
  created_at: string;
  depth: number;
}

export interface TimelineOptions {
  json?: boolean;
}

const TIMELINE_CTE = `
  WITH RECURSIVE
  base AS (
    SELECT
      id,
      subject,
      kind,
      agent,
      COALESCE(trace_id::text, data->>'_trace_id') AS trace_id,
      COALESCE(span_id::text, data->>'_span_id') AS span_id,
      COALESCE(parent_span_id::text, data->>'_parent_span_id') AS parent_span_id,
      COALESCE(severity, data->>'_severity') AS severity,
      COALESCE(duration_ms, NULLIF(data->>'_duration_ms', '')::int) AS duration_ms,
      text,
      data,
      created_at
      FROM genie_runtime_events
     WHERE COALESCE(trace_id::text, data->>'_trace_id') = $1
  ),
  tree AS (
    SELECT b.*, 0 AS depth
      FROM base b
     WHERE b.parent_span_id IS NULL
        OR b.parent_span_id NOT IN (SELECT span_id FROM base WHERE span_id IS NOT NULL)
    UNION ALL
    SELECT b.*, t.depth + 1 AS depth
      FROM base b
      JOIN tree t ON b.parent_span_id = t.span_id
     WHERE t.depth < 64
  )
  SELECT id, subject, kind, agent, trace_id, span_id, parent_span_id,
         severity, duration_ms, text, data, created_at::text AS created_at, depth
    FROM tree
   ORDER BY created_at ASC, id ASC
`;

async function loadTimelineRows(traceId: string): Promise<TimelineRow[]> {
  const sql = await getConnection();
  const rows = (await sql.unsafe(TIMELINE_CTE, [traceId])) as unknown as TimelineRow[];
  return rows;
}

function indent(depth: number): string {
  if (depth === 0) return '';
  const bars = '│ '.repeat(Math.max(0, depth - 1));
  return `${bars}├─ `;
}

function severityLabel(sev: string | null): string {
  const label = (sev ?? '-').padEnd(5);
  const raw = sev ?? '-';
  if (raw === 'error' || raw === 'fatal') return color('red', label);
  if (raw === 'warn') return color('yellow', label);
  if (raw === 'debug') return color('dim', label);
  return color('cyan', label);
}

function renderTimelineRow(r: TimelineRow): string {
  const ts = new Date(r.created_at).toISOString().replace('T', ' ').slice(11, 19);
  const sevColor = severityLabel(r.severity);
  const span = r.span_id ? color('dim', ` [${r.span_id.slice(0, 8)}]`) : '';
  const dur = r.duration_ms != null ? color('dim', ` (${r.duration_ms}ms)`) : '';
  const subject = r.subject ?? r.text ?? 'unknown';
  return `${color('dim', ts)}  ${sevColor} ${indent(r.depth)}${color('brightCyan', subject)}${span}${dur}`;
}

function renderTreeAscii(rows: TimelineRow[]): string[] {
  return rows.map(renderTimelineRow);
}

export async function timelineCommand(traceId: string, options: TimelineOptions = {}): Promise<void> {
  const rows = await loadTimelineRows(traceId);

  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(`No events found for trace_id=${traceId}`);
    return;
  }

  console.log(color('dim', `Trace ${traceId} — ${rows.length} event${rows.length === 1 ? '' : 's'}`));
  console.log('');
  for (const line of renderTreeAscii(rows)) {
    console.log(line);
  }
}
