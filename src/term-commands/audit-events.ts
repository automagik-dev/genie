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
  type ErrorPattern,
  queryAuditEvents,
  queryErrorPatterns,
} from '../lib/audit.js';

// ============================================================================
// Helpers
// ============================================================================

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const now = Date.now();
  const diffMs = now - d.getTime();

  if (diffMs < 60_000) return `${Math.floor(diffMs / 1000)}s ago`;
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

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
}
