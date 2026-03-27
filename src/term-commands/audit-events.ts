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
import { formatRelativeTimestamp as formatTimestamp, padRight } from '../lib/term-format.js';

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
}

async function eventsListCommand(options: ListOptions): Promise<void> {
  try {
    const queryOpts: AuditQueryOptions = {
      type: options.type,
      entity: options.entity,
      since: options.since ?? '1h',
      errorsOnly: options.errorsOnly,
      limit: options.limit ? Number.parseInt(options.limit, 10) : 50,
    };

    const rows = await queryAuditEvents(queryOpts);

    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      printEventsTable(rows);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error querying events: ${msg}`);
    process.exit(1);
  }
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
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error querying summary: ${msg}`);
    process.exit(1);
  }
}

// ============================================================================
// Registration
// ============================================================================

export function registerEventsCommands(program: Command): void {
  const events = program.command('events').description('Audit event log from PG');

  events
    .command('list', { isDefault: true })
    .description('List recent audit events')
    .option('--type <type>', 'Filter by event_type')
    .option('--entity <entity>', 'Filter by entity_type or entity_id')
    .option('--since <duration>', 'Time window (e.g., 1h, 30m, 2d)', '1h')
    .option('--errors-only', 'Show only error events')
    .option('--limit <n>', 'Max rows to return', '50')
    .option('--json', 'Output as JSON')
    .action(async (options: ListOptions) => {
      await eventsListCommand(options);
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
}
