/**
 * Audit Events CLI — query audit_events from PG.
 *
 * Commands:
 *   genie events list [--type X] [--entity X] [--since 1h] [--errors-only] [--limit N] [--json]
 *   genie events errors [--since 1h] [--json]
 */

import type { Command } from 'commander';
import {
  type AuditEventRow,
  type AuditQueryOptions,
  type CostBreakdownRow,
  type ErrorPattern,
  type EventSummary,
  type ToolUsageRow,
  queryAuditEvents,
  queryCostBreakdown,
  queryErrorPatterns,
  querySummary,
  queryTimeline,
  queryToolUsage,
} from '../lib/audit.js';
import { type V2EventRow, queryV2Batch } from '../lib/events/v2-query.js';
import { getOtelPort } from '../lib/otel-receiver.js';
import { formatRelativeTimestamp as formatTimestamp, padRight } from '../lib/term-format.js';
import {
  type ExportAuditOptions,
  type ListRevocationsOptions,
  type RevokeOptions,
  type RotateOptions,
  type UnHashOptions,
  type VerifyChainOptions,
  exportAuditCommand,
  listRevocationsCommand,
  revokeSubscriberCommand,
  rotateRedactionKeysCommand,
  unHashCommand,
  verifyChainCommand,
} from './events-admin.js';
import { migrateCommand } from './events-migrate.js';
import { type StreamFollowOptions, streamCommand } from './events-stream.js';
import { type SubscribeOptions, subscribeCommand } from './events-subscribe.js';
import { type TimelineOptions as V2TimelineOptions, timelineCommand as v2TimelineCommand } from './events-timeline.js';

function printEventsTable(rows: AuditEventRow[]): void {
  if (rows.length === 0) {
    console.log('No audit events found.');
    return;
  }

  // Reverse so oldest is first (query returns DESC)
  const sorted = [...rows].reverse();

  const headers = ['Time', 'Type', 'Entity', 'Event', 'Actor', 'Details'];
  const data = sorted.map((r) => [
    formatTimestamp(r.created_at),
    r.entity_type,
    r.entity_id,
    r.event_type,
    r.actor ?? '-',
    summarizeDetails(r.details),
  ]);

  const widths = headers.map((h, i) => {
    const colVals = data.map((row) => row[i]);
    return Math.min(40, Math.max(h.length, ...colVals.map((v) => v.length)));
  });

  const header = headers.map((h, i) => padRight(h, widths[i])).join(' | ');
  console.log(header);
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));

  for (const row of data) {
    const line = row.map((v, i) => padRight(v.slice(0, widths[i]), widths[i])).join(' | ');
    console.log(line);
  }

  console.log(`\n(${rows.length} event${rows.length === 1 ? '' : 's'})`);
}

function summarizeDetails(details: Record<string, unknown> | string): string {
  if (!details) return '';
  // Handle double-encoded JSON strings from legacy records
  if (typeof details === 'string') {
    try {
      return summarizeDetails(JSON.parse(details));
    } catch {
      return details.slice(0, 40);
    }
  }
  if (Object.keys(details).length === 0) return '';
  const keys = Object.keys(details);
  if (keys.length === 1) {
    const val = details[keys[0]];
    if (typeof val === 'string') return val.slice(0, 40);
    return JSON.stringify(val).slice(0, 40);
  }
  // Show error field first if present
  if (details.error) return `error: ${String(details.error).slice(0, 35)}`;
  if (details.duration_ms) return `${details.duration_ms}ms`;
  return JSON.stringify(details).slice(0, 40);
}

/**
 * Print a warning that OTel-derived event subcommands only see sessions that
 * were launched via `genie spawn` / `genie team create`. User-initiated
 * Claude Code sessions (CLI, IDE extension, desktop app, third-party
 * wrappers) never get the OTLP exporter env injected by
 * `src/lib/provider-adapters.ts` and therefore never reach the genie
 * receiver. Without surfacing this, empty or thin results read as
 * "observability is broken" — closes #1263.
 *
 * Skip when rendering JSON so parsers don't break. When `empty=true` add a
 * concrete remediation hint with the live receiver port; otherwise print
 * the scope note alone.
 */
export function printOtelScopeWarning(opts: { empty: boolean }): void {
  console.log('\n⚠  OTel-derived events only cover genie-spawned sessions.');
  if (opts.empty) {
    let port: number | null = null;
    try {
      port = getOtelPort();
    } catch {
      port = null;
    }
    const endpoint = port ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:<otel-port>';
    console.log('   If you expected user-session activity, export the OTel vars in your shell rc:');
    console.log(`     export OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`);
    console.log('     export CLAUDE_CODE_ENABLE_TELEMETRY=1');
    console.log('   Then restart your Claude Code session.');
  } else {
    console.log('   User-initiated Claude Code sessions are not captured unless they export OTLP.');
  }
}

/** Returns true when a `--type` filter targets an OTel-sourced event stream. */
export function isOtelTypeFilter(type: string | undefined): boolean {
  return typeof type === 'string' && type.startsWith('otel_');
}

/**
 * Returns true when a v2 `--kind` filter targets kinds that only populate
 * from the OTel exporter (e.g. `tool`, `tool_call`, `tool_result`). Those
 * rows only land in `genie_runtime_events` for genie-spawned sessions.
 */
export function isOtelKindFilter(kind: string | undefined): boolean {
  return typeof kind === 'string' && kind.startsWith('tool');
}

function printErrorsTable(patterns: ErrorPattern[]): void {
  if (patterns.length === 0) {
    console.log('No error patterns found.');
    return;
  }

  const headers = ['Count', 'Event', 'Command', 'Error', 'Last Seen'];
  const data = patterns.map((p) => [
    String(p.count),
    p.event_type,
    p.entity_id,
    p.error_message.slice(0, 50),
    formatTimestamp(p.last_seen),
  ]);

  const widths = headers.map((h, i) => {
    const colVals = data.map((row) => row[i]);
    return Math.min(50, Math.max(h.length, ...colVals.map((v) => v.length)));
  });

  const header = headers.map((h, i) => padRight(h, widths[i])).join(' | ');
  console.log(header);
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));

  for (const row of data) {
    const line = row.map((v, i) => padRight(v.slice(0, widths[i]), widths[i])).join(' | ');
    console.log(line);
  }

  console.log(`\n(${patterns.length} pattern${patterns.length === 1 ? '' : 's'})`);
}

// ============================================================================
// Command Handlers
// ============================================================================

interface ListOptions {
  type?: string;
  entity?: string;
  since?: string;
  errorsOnly?: boolean;
  limit?: string;
  json?: boolean;
  follow?: boolean;
  v2?: boolean;
  kind?: string;
  severity?: string;
}

function printV2EventsTable(rows: V2EventRow[]): void {
  if (rows.length === 0) {
    console.log('No events found.');
    return;
  }

  const headers = ['Time', 'Subject', 'Agent', 'TraceId', 'SpanId', 'Severity', 'Duration'];
  const data = rows.map((r) => [
    formatTimestamp(r.created_at),
    r.subject ?? r.text ?? '-',
    r.agent,
    r.trace_id ? r.trace_id.slice(0, 8) : '-',
    r.span_id ? r.span_id.slice(0, 8) : '-',
    r.severity ?? '-',
    r.duration_ms != null ? `${r.duration_ms}ms` : '-',
  ]);

  const widths = headers.map((h, i) => {
    const colVals = data.map((row) => row[i]);
    return Math.min(40, Math.max(h.length, ...colVals.map((v) => v.length)));
  });

  const header = headers.map((h, i) => padRight(h, widths[i])).join(' | ');
  console.log(header);
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
  for (const row of data) {
    const line = row.map((v, i) => padRight(v.slice(0, widths[i]), widths[i])).join(' | ');
    console.log(line);
  }

  console.log(`\n(${rows.length} event${rows.length === 1 ? '' : 's'})`);
}

async function eventsListV2Command(options: ListOptions): Promise<void> {
  try {
    const limit = options.limit ? Number.parseInt(options.limit, 10) : 50;
    const rows = await queryV2Batch({
      kindPrefix: options.kind,
      severity: options.severity,
      since: options.since ?? '1h',
      limit,
    });

    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      printV2EventsTable(rows);
      // v2 kinds like `tool` / `tool_call` / `tool_result` only populate
      // from the OTLP exporter — mirror the same scope note the roll-ups
      // surface so an empty result isn't read as "observability broke."
      if (isOtelKindFilter(options.kind)) {
        printOtelScopeWarning({ empty: rows.length === 0 });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error querying v2 events: ${msg}`);
    process.exit(1);
  }
}

async function eventsListCommand(options: ListOptions): Promise<void> {
  if (options.v2) {
    return eventsListV2Command(options);
  }
  try {
    const queryOpts: AuditQueryOptions = {
      type: options.type,
      entity: options.entity,
      since: options.since ?? '1h',
      errorsOnly: options.errorsOnly,
      limit: options.limit ? Number.parseInt(options.limit, 10) : 50,
    };

    if (options.follow) {
      const { followAuditEvents } = await import('../lib/audit.js');
      console.log('Following audit events (Ctrl+C to stop)...');
      const handle = await followAuditEvents(queryOpts, (row) => {
        if (options.json) {
          console.log(JSON.stringify(row));
        } else {
          const time = formatTimestamp(row.created_at);
          const entity = `${row.entity_type}:${row.entity_id}`.slice(0, 40);
          const event = row.event_type.padEnd(24);
          const details = summarizeDetails(row.details).slice(0, 60);
          console.log(`${time}  ${event}  ${entity}  ${details}`);
        }
      });
      const shutdown = () => {
        handle.stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      await new Promise(() => {});
      return;
    }

    const rows = await queryAuditEvents(queryOpts);

    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      printEventsTable(rows);
      // When the user explicitly filters by an OTel-sourced event_type,
      // surface the same capture-scope note they'd see from the roll-ups
      // (tools/summary/costs) so an empty result isn't read as a bug.
      if (isOtelTypeFilter(options.type)) {
        printOtelScopeWarning({ empty: rows.length === 0 });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error querying events: ${msg}`);
    process.exit(1);
  }
}

// ============================================================================
// Stream Command — unified audit + runtime event stream (LISTEN/NOTIFY)
// ============================================================================

interface StreamOptions {
  type?: string;
  entity?: string;
  errorsOnly?: boolean;
  kind?: string;
  agent?: string;
  auditOnly?: boolean;
  runtimeOnly?: boolean;
  json?: boolean;
  all?: boolean;
}

// Noisy events hidden by default — show with --all
const DEFAULT_HIDDEN_EVENT_TYPES = new Set(['command_success', 'sdk.hook.started']);

async function eventsStreamCommand(options: StreamOptions): Promise<void> {
  const { followAuditEvents } = await import('../lib/audit.js');
  const { followRuntimeEvents } = await import('../lib/runtime-events.js');
  const { color } = await import('../lib/term-format.js');
  const { renderAuditEvent, renderRuntimeEvent, formatEventLine } = await import('../lib/event-renderer.js');

  const handles: Array<{ stop: () => Promise<void> | void }> = [];

  const clockTime = (iso: string | Date): string => {
    const d = iso instanceof Date ? iso : new Date(iso);
    return d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  };

  if (!options.json) {
    const sources = options.auditOnly ? 'audit' : options.runtimeOnly ? 'runtime' : 'audit + runtime';
    console.log(color('dim', `Streaming ${sources} events (Ctrl+C to stop)...`));
  }

  if (!options.runtimeOnly) {
    const auditHandle = await followAuditEvents(
      { type: options.type, entity: options.entity, errorsOnly: options.errorsOnly },
      (row) => {
        // Hide noisy events by default (unless --all or filters match)
        if (!options.all && !options.type && DEFAULT_HIDDEN_EVENT_TYPES.has(row.event_type)) {
          return;
        }
        if (options.json) {
          console.log(JSON.stringify({ stream: 'audit', ...row }));
          return;
        }
        console.log(
          formatEventLine(
            clockTime(row.created_at),
            renderAuditEvent({
              entity_type: row.entity_type,
              entity_id: row.entity_id,
              event_type: row.event_type,
              details: row.details,
            }),
          ),
        );
      },
    );
    handles.push(auditHandle);
  }

  if (!options.auditOnly) {
    const validKinds = ['user', 'assistant', 'message', 'state', 'tool_call', 'tool_result', 'system', 'qa'] as const;
    type RuntimeKind = (typeof validKinds)[number];
    const kinds =
      options.kind && (validKinds as readonly string[]).includes(options.kind)
        ? ([options.kind] as RuntimeKind[])
        : undefined;
    const agentIds = options.agent ? [options.agent] : undefined;
    const runtimeHandle = await followRuntimeEvents(
      { kinds, agentIds, scopeMode: 'any' },
      (event) => {
        if (options.json) {
          console.log(JSON.stringify({ stream: 'runtime', ...event }));
          return;
        }
        console.log(
          formatEventLine(
            clockTime(event.timestamp),
            renderRuntimeEvent({
              kind: event.kind,
              agent: event.agent,
              team: event.team,
              text: event.text,
            }),
          ),
        );
      },
      { pollIntervalMs: 2000 },
    );
    handles.push(runtimeHandle);
  }

  const shutdown = async () => {
    for (const h of handles) await h.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
}

interface ErrorsOptions {
  since?: string;
  json?: boolean;
}

async function eventsErrorsCommand(options: ErrorsOptions): Promise<void> {
  try {
    const patterns = await queryErrorPatterns(options.since);

    if (options.json) {
      console.log(JSON.stringify(patterns, null, 2));
    } else {
      printErrorsTable(patterns);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error querying error patterns: ${msg}`);
    process.exit(1);
  }
}

// ============================================================================
// Costs Command
// ============================================================================

interface CostsOptions {
  today?: boolean;
  since?: string;
  byAgent?: boolean;
  byWish?: boolean;
  byModel?: boolean;
  json?: boolean;
}

function resolveCostsGroupBy(options: CostsOptions): 'agent' | 'wish' | 'model' {
  if (options.byWish) return 'wish';
  if (options.byModel) return 'model';
  return 'agent';
}

function printCostsTable(rows: CostBreakdownRow[], groupBy: string): void {
  if (rows.length === 0) {
    console.log('No cost data found.');
    return;
  }

  const headers = [
    groupBy === 'agent' ? 'Agent' : groupBy === 'wish' ? 'Wish' : 'Model',
    'Total Cost',
    'Requests',
    'Avg Cost',
  ];
  const data = rows.map((r) => [
    r.group_key,
    `$${r.total_cost.toFixed(4)}`,
    String(r.request_count),
    `$${r.avg_cost.toFixed(4)}`,
  ]);

  const widths = headers.map((h, i) => {
    const colVals = data.map((row) => row[i]);
    return Math.min(40, Math.max(h.length, ...colVals.map((v) => v.length)));
  });

  console.log(headers.map((h, i) => padRight(h, widths[i])).join(' | '));
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
  for (const row of data) {
    console.log(row.map((v, i) => padRight(v.slice(0, widths[i]), widths[i])).join(' | '));
  }

  const totalCost = rows.reduce((sum, r) => sum + r.total_cost, 0);
  const totalReqs = rows.reduce((sum, r) => sum + r.request_count, 0);
  console.log(`\nTotal: $${totalCost.toFixed(4)} across ${totalReqs} requests`);
}

async function eventsCostsCommand(options: CostsOptions): Promise<void> {
  try {
    const since = options.today ? '24h' : (options.since ?? '24h');
    const groupBy = resolveCostsGroupBy(options);
    const rows = await queryCostBreakdown(since, groupBy);

    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      printCostsTable(rows, groupBy);
      // Warn about tracking gap — OTel only captures genie-spawned sessions.
      printOtelScopeWarning({ empty: rows.length === 0 });
      if (rows.length > 0) {
        console.log('   For full server costs: npx ccusage monthly');
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error querying costs: ${msg}`);
    process.exit(1);
  }
}

// ============================================================================
// Tools Command
// ============================================================================

interface ToolsOptions {
  since?: string;
  byTool?: boolean;
  byAgent?: boolean;
  json?: boolean;
}

function printToolsTable(rows: ToolUsageRow[], groupBy: string): void {
  if (rows.length === 0) {
    console.log('No tool usage data found.');
    return;
  }

  const headers = [groupBy === 'tool' ? 'Tool' : 'Agent', 'Calls', 'Success', 'Errors', 'Avg Duration'];
  const data = rows.map((r) => [
    r.group_key,
    String(r.total_calls),
    String(r.success_count),
    String(r.error_count),
    r.avg_duration_ms != null ? `${r.avg_duration_ms.toFixed(0)}ms` : '-',
  ]);

  const widths = headers.map((h, i) => {
    const colVals = data.map((row) => row[i]);
    return Math.min(40, Math.max(h.length, ...colVals.map((v) => v.length)));
  });

  console.log(headers.map((h, i) => padRight(h, widths[i])).join(' | '));
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
  for (const row of data) {
    console.log(row.map((v, i) => padRight(v.slice(0, widths[i]), widths[i])).join(' | '));
  }

  const totalCalls = rows.reduce((sum, r) => sum + r.total_calls, 0);
  console.log(`\n(${totalCalls} total tool calls)`);
}

async function eventsToolsCommand(options: ToolsOptions): Promise<void> {
  try {
    const since = options.since ?? '24h';
    const groupBy: 'tool' | 'agent' = options.byAgent ? 'agent' : 'tool';
    const rows = await queryToolUsage(since, groupBy);

    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      printToolsTable(rows, groupBy);
      // `otel_tool` rows only flow from genie-spawned sessions — surface the
      // scope so a user running Claude Code outside `genie spawn` doesn't
      // read empty output as "observability is broken."
      printOtelScopeWarning({ empty: rows.length === 0 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error querying tool usage: ${msg}`);
    process.exit(1);
  }
}

// ============================================================================
// Timeline Command
// ============================================================================

interface TimelineOptions {
  json?: boolean;
}

async function eventsTimelineCommand(entityId: string, options: TimelineOptions): Promise<void> {
  try {
    const rows = await queryTimeline(entityId);

    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      printEventsTable(rows);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error querying timeline: ${msg}`);
    process.exit(1);
  }
}

// ============================================================================
// Summary Command
// ============================================================================

interface SummaryOptions {
  today?: boolean;
  since?: string;
  json?: boolean;
}

function printSummary(summary: EventSummary): void {
  console.log('Event Summary');
  console.log('=============');
  console.log(`Total events:    ${summary.total_events}`);
  console.log(`Agents spawned:  ${summary.agents_spawned}`);
  console.log(`Tasks moved:     ${summary.tasks_moved}`);
  console.log(`API requests:    ${summary.api_requests}`);
  console.log(`Tool calls:      ${summary.tool_calls}`);
  console.log(`Total cost:      $${summary.total_cost.toFixed(4)}`);
  console.log(`Errors:          ${summary.error_count}`);
}

async function eventsSummaryCommand(options: SummaryOptions): Promise<void> {
  try {
    const since = options.today ? '24h' : (options.since ?? '24h');
    const summary = await querySummary(since);

    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printSummary(summary);
      // `tool_calls`, `api_requests`, and `total_cost` all come from
      // OTel-sourced rows — clarify the capture boundary so a low number
      // isn't mistaken for low activity.
      const allOtelEmpty = summary.tool_calls === 0 && summary.api_requests === 0 && summary.total_cost === 0;
      printOtelScopeWarning({ empty: allOtelEmpty });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error querying summary: ${msg}`);
    process.exit(1);
  }
}

// ============================================================================
// Scan Command (delegates to ccusage)
// ============================================================================

async function eventsScanCommand(options: { since?: string; json?: boolean; breakdown?: boolean }): Promise<void> {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');

  const args = ['ccusage', 'monthly'];
  if (options.since) args.push('--since', options.since);
  if (options.json) args.push('--json');
  if (options.breakdown) args.push('--breakdown');

  const result = spawnSync('npx', args, {
    stdio: options.json ? 'pipe' : 'inherit',
    timeout: 30_000,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });

  if (result.error) {
    console.error('ccusage not available. Install with: npm install -g ccusage');
    console.error('Or run directly: npx ccusage monthly');
    process.exit(1);
  }

  if (options.json && result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// ============================================================================
// Registration
// ============================================================================

export function registerEventsCommands(program: Command): void {
  const events = program
    .command('events')
    .description(
      'Audit event log from PG. OTel-derived data (tools/summary/costs and otel_* list rows) is scoped to genie-spawned agents — user-initiated Claude Code sessions are not captured unless they export OTLP env vars.',
    );

  events
    .command('list', { isDefault: true })
    .description('List recent audit events (add --v2 for the enriched genie_runtime_events surface)')
    .option('--type <type>', 'Filter by event_type')
    .option('--entity <entity>', 'Filter by entity_type or entity_id')
    .option('--since <duration>', 'Time window (e.g., 1h, 30m, 2d)', '1h')
    .option('--errors-only', 'Show only error events')
    .option('--limit <n>', 'Max rows to return', '50')
    .option('--json', 'Output as JSON')
    .option('-f, --follow', 'Follow mode — real-time streaming (alias: genie events stream)')
    .option('--v2', 'Use enriched genie_runtime_events surface with TraceId/SpanId/Severity/Duration columns')
    .option('--kind <prefix>', 'Filter v2 rows by kind/subject prefix (e.g., mailbox, agent.lifecycle)')
    .option('--severity <level>', 'Filter v2 rows by severity (debug|info|warn|error|fatal)')
    .action(async (options: ListOptions) => {
      await eventsListCommand(options);
    });

  events
    .command('timeline-v2 <trace-id>')
    .description('Render causal tree for a trace_id from genie_runtime_events (v2 enriched surface)')
    .option('--json', 'Output as JSON')
    .action(async (traceId: string, options: V2TimelineOptions) => {
      await v2TimelineCommand(traceId, options);
    });

  events
    .command('stream-follow')
    .description('Follow-stream enriched genie_runtime_events via LISTEN/NOTIFY + id-cursor (v2)')
    .option('--follow', 'Continuously follow the stream', true)
    .option('--kind <prefix>', 'Filter by subject/kind prefix (supports `*` globs, e.g. `detector.*`)')
    .option('--severity <level>', 'Filter by severity (debug|info|warn|error|fatal)')
    .option('--since <duration>', 'Seed window (e.g., 5m, 1h)')
    .option('--consumer-id <id>', 'Persistent consumer id for cursor resume')
    .option('--json', 'Output as NDJSON')
    .action(async (options: StreamFollowOptions & { consumerId?: string }) => {
      await streamCommand({ ...options, follow: true });
    });

  events
    .command('migrate')
    .description('Backfill legacy audit_events rows into genie_runtime_events (one-shot)')
    .option('--audit', 'Migrate audit_events → genie_runtime_events with sentinel source tag')
    .option('--dry-run', 'Report row deltas without writing')
    .option('--since <duration>', 'Only migrate rows created within this window')
    .option('--limit <n>', 'Cap the number of rows migrated per run', (v: string) => Number.parseInt(v, 10))
    .option('--json', 'Output summary as JSON')
    .action(async (options: { audit?: boolean; dryRun?: boolean; since?: string; limit?: number; json?: boolean }) => {
      await migrateCommand(options);
    });

  events
    .command('stream')
    .description('Stream audit + runtime events in real-time (tail -f style)')
    .option('--type <type>', 'Filter by event_type')
    .option('--entity <entity>', 'Filter by entity_type or entity_id')
    .option('--errors-only', 'Show only error events')
    .option('--kind <kind>', 'Filter runtime events by kind (tool_call, message, prompt, etc)')
    .option('--agent <agent>', 'Filter runtime events by agent')
    .option('--audit-only', 'Stream only audit_events (skip runtime)')
    .option('--runtime-only', 'Stream only runtime events (skip audit)')
    .option('--all', 'Show all events including noisy ones (command_success, etc)')
    .option('--json', 'Output as JSON')
    .action(async (options: StreamOptions) => {
      await eventsStreamCommand(options);
    });

  events
    .command('errors')
    .description('Show aggregated error patterns')
    .option('--since <duration>', 'Time window (e.g., 1h, 24h, 7d)')
    .option('--json', 'Output as JSON')
    .action(async (options: ErrorsOptions) => {
      await eventsErrorsCommand(options);
    });

  events
    .command('costs')
    .description('Cost breakdown from OTel API request events')
    .option('--today', 'Show costs from the last 24h')
    .option('--since <duration>', 'Time window (e.g., 1h, 7d)', '24h')
    .option('--by-agent', 'Group by agent')
    .option('--by-wish', 'Group by wish')
    .option('--by-model', 'Group by model')
    .option('--json', 'Output as JSON')
    .action(async (options: CostsOptions) => {
      await eventsCostsCommand(options);
    });

  events
    .command('tools')
    .description('Tool usage analytics from OTel tool events')
    .option('--since <duration>', 'Time window (e.g., 1h, 7d)', '24h')
    .option('--by-tool', 'Group by tool name (default)')
    .option('--by-agent', 'Group by agent')
    .option('--json', 'Output as JSON')
    .action(async (options: ToolsOptions) => {
      await eventsToolsCommand(options);
    });

  events
    .command('timeline <entity-id>')
    .description('Full event timeline for a task, agent, wish, or traceId')
    .option('--json', 'Output as JSON')
    .action(async (entityId: string, options: TimelineOptions) => {
      await eventsTimelineCommand(entityId, options);
    });

  events
    .command('summary')
    .description('High-level stats: agents spawned, tasks moved, costs, errors')
    .option('--today', 'Show summary for the last 24h')
    .option('--since <duration>', 'Time window (e.g., 1h, 7d)', '24h')
    .option('--json', 'Output as JSON')
    .action(async (options: SummaryOptions) => {
      await eventsSummaryCommand(options);
    });

  events
    .command('scan')
    .description('Full server cost scan via ccusage (all CC sessions, not just genie-spawned)')
    .option('--since <date>', 'Start date in YYYYMMDD format')
    .option('--json', 'Output as JSON')
    .option('--breakdown', 'Show per-model breakdown')
    .action(async (options: { since?: string; json?: boolean; breakdown?: boolean }) => {
      await eventsScanCommand(options);
    });

  // ==========================================================================
  // Group 5: subscription tokens + incident-response admin commands
  // ==========================================================================

  events
    .command('subscribe')
    .description('Mint a signed subscription token for genie events stream --follow')
    .requiredOption('--role <role>', 'RBAC role: events:admin|events:operator|events:subscriber|events:audit')
    .option('--types <csv>', 'Comma-separated allowed event types (subset of role defaults)')
    .option('--channels <csv>', 'Comma-separated allowed LISTEN channels (subset of role defaults)')
    .option('--ttl <duration>', 'Token time-to-live (e.g., 30m, 1h, 24h). Defaults to 1h.')
    .option('--tenant <id>', 'Tenant id. Defaults to "default".')
    .option('--subscriber-id <id>', 'Stable id for the subscriber agent')
    .option('--json', 'Output as JSON')
    .action(async (options: SubscribeOptions) => {
      await subscribeCommand(options);
    });

  const admin = events.command('admin').description('Incident-response admin commands (sentinel H6 audited)');

  admin
    .command('revoke-subscriber')
    .description('Add a subscription token to the revocation list')
    .requiredOption('--token-id <id>', 'Token id from `genie events subscribe` output')
    .option('--subscriber-id <id>', 'Subscriber id associated with the token')
    .option('--tenant <id>', 'Tenant id. Defaults to "default".')
    .option('--reason <text>', 'IR justification for revocation')
    .option('--json', 'Output as JSON')
    .action(async (options: RevokeOptions) => {
      await revokeSubscriberCommand(options);
    });

  admin
    .command('rotate-redaction-keys')
    .description('Rotate redaction + audit HMAC keys, preserving prior versions for lookup')
    .option('--tenant <id>', 'Tenant id. Defaults to "default".')
    .option('--new-key <material>', 'Explicit key material (default: 32 bytes hex from /dev/urandom)')
    .option('--target <scope>', 'redaction|audit|both (default: both)')
    .option('--json', 'Output as JSON')
    .action(async (options: RotateOptions) => {
      await rotateRedactionKeysCommand(options);
    });

  admin
    .command('un-hash')
    .description('Admin reverse-lookup for a Tier-A hash (emits audit.un_hash)')
    .requiredOption('--namespace <ns>', 'Hash namespace (e.g., agent, actor, session)')
    .requiredOption('--hashed-value <hash>', 'Tier-A hash tag to reverse')
    .option('--candidates <csv>', 'Comma-separated candidate plaintexts to brute-force')
    .option('--tenant <id>', 'Tenant id. Defaults to "default".')
    .option('--reason <text>', 'IR justification (appears in audit.un_hash)')
    .option('--ticket <ref>', 'Incident ticket reference')
    .option('--json', 'Output as JSON')
    .action(async (options: UnHashOptions) => {
      await unHashCommand(options);
    });

  admin
    .command('export-audit')
    .description('Produce a signed audit-chain bundle (emits audit.export)')
    .option('--signed', 'Require GENIE_AUDIT_EXPORT_SECRET for HMAC signing', true)
    .option('--since <duration>', 'Advisory time window (authoritative cursor is --since-id)')
    .option('--since-id <n>', 'Authoritative id cursor to resume from')
    .option('--limit <n>', 'Max rows to include')
    .option('--tenant <id>', 'Tenant id. Defaults to "default".')
    .option('--output <path>', 'Write bundle to file; omit to print to stdout')
    .option('--reason <text>', 'IR justification (appears in audit.export)')
    .option('--json', 'Output as JSON')
    .action(async (options: ExportAuditOptions) => {
      await exportAuditCommand(options);
    });

  admin
    .command('verify-chain')
    .description('Quick chain-integrity check (no export)')
    .option('--since-id <n>', 'Start id', '0')
    .option('--limit <n>', 'Max rows to verify')
    .option('--json', 'Output as JSON')
    .action(async (options: VerifyChainOptions) => {
      await verifyChainCommand(options);
    });

  admin
    .command('list-revocations')
    .description('List revoked token ids for a tenant')
    .option('--tenant <id>', 'Tenant id. Defaults to "default".')
    .option('--json', 'Output as JSON')
    .action(async (options: ListRevocationsOptions) => {
      await listRevocationsCommand(options);
    });
}
