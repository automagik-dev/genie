/**
 * Schedule commands — CLI interface for managing scheduled triggers.
 *
 * Commands:
 *   genie schedule create <name>  — create a new schedule with triggers
 *   genie schedule list            — list schedules and next due triggers
 *   genie schedule cancel <name>   — cancel a schedule and skip pending triggers
 *   genie schedule retry <name>    — reset a failed trigger to pending
 *   genie schedule history <name>  — show past executions for a schedule
 */

import type { Command } from 'commander';
import { computeNextCronDue, parseDuration } from '../lib/cron.js';
import { getConnection, shutdown } from '../lib/db.js';
export { computeNextCronDue, parseDuration };

// ============================================================================
// Types
// ============================================================================

interface CreateOptions {
  command: string;
  at?: string;
  every?: string;
  after?: string;
  timezone?: string;
  leaseTimeout?: string;
}

interface ListOptions {
  json?: boolean;
  watch?: boolean;
}

interface CancelOptions {
  filter?: string;
}

interface HistoryOptions {
  limit?: number;
}

interface ScheduleRow {
  id: string;
  name: string;
  cron_expression: string;
  command: string;
  status: string;
  metadata: Record<string, unknown>;
  next_due: string | null;
  trigger_status: string | null;
}

interface HistoryRow {
  trigger_id: string;
  due_at: string;
  trigger_status: string;
  run_id: string | null;
  run_status: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  error: string | null;
}

// ============================================================================
// Time Parsing
// ============================================================================

/**
 * Parse a time specification into an absolute Date.
 * Supports ISO 8601 strings and human-friendly formats.
 */
export function parseAbsoluteTime(input: string): Date {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid time: "${input}". Expected ISO 8601 format (e.g., 2026-03-21T09:00)`);
  }
  return date;
}

/**
 * Check if a string looks like a cron expression (5 or 6 space-separated fields).
 */
export function isCronExpression(input: string): boolean {
  const parts = input.trim().split(/\s+/);
  return parts.length >= 5 && parts.length <= 6;
}

/**
 * Compute next due_at for a schedule based on its type.
 */
function computeFirstDueAt(options: CreateOptions): { dueAt: Date; cronExpr: string; scheduleType: string } {
  if (options.at) {
    const dueAt = parseAbsoluteTime(options.at);
    if (dueAt.getTime() <= Date.now()) {
      throw new Error(`Schedule time is in the past: ${options.at}`);
    }
    return { dueAt, cronExpr: '@once', scheduleType: 'once' };
  }

  if (options.after) {
    const delayMs = parseDuration(options.after);
    const dueAt = new Date(Date.now() + delayMs);
    return { dueAt, cronExpr: '@once', scheduleType: 'once' };
  }

  if (options.every) {
    if (isCronExpression(options.every)) {
      // Store cron expression directly
      const dueAt = computeNextCronDue(options.every, { timezone: options.timezone });
      return { dueAt, cronExpr: options.every, scheduleType: 'cron' };
    }
    // Parse as interval duration
    const intervalMs = parseDuration(options.every);
    const dueAt = new Date(Date.now() + intervalMs);
    return { dueAt, cronExpr: `@every ${options.every.trim()}`, scheduleType: 'interval' };
  }

  throw new Error('One of --at, --every, or --after is required');
}

// ============================================================================
// Helpers
// ============================================================================

function generateId(): string {
  return crypto.randomUUID();
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

function formatTimestamp(iso: string | null | Date): string {
  if (!iso) return '-';
  const d = iso instanceof Date ? iso : new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatDuration(ms: number | null): string {
  if (ms == null || ms < 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * Print rows as an aligned table.
 */
function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => {
    const colValues = rows.map((r) => (r[i] ?? '').length);
    return Math.max(h.length, ...colValues);
  });

  const headerLine = headers.map((h, i) => padRight(h, widths[i])).join('  ');
  console.log(headerLine);
  console.log(widths.map((w) => '─'.repeat(w)).join('──'));

  for (const row of rows) {
    const line = row.map((val, i) => padRight(val ?? '', widths[i])).join('  ');
    console.log(line);
  }

  console.log(`(${rows.length} row${rows.length === 1 ? '' : 's'})`);
}

// ============================================================================
// Commands
// ============================================================================

/**
 * `genie schedule create <name> --command <cmd> [--at|--every|--after]`
 */
async function scheduleCreateCommand(name: string, options: CreateOptions): Promise<void> {
  if (!options.command) {
    console.error('Error: --command is required');
    process.exit(1);
  }

  if (!options.at && !options.every && !options.after) {
    console.error('Error: one of --at, --every, or --after is required');
    process.exit(1);
  }

  try {
    const { dueAt, cronExpr, scheduleType } = computeFirstDueAt(options);
    const sql = await getConnection();

    // Check for duplicate name
    const existing = await sql`SELECT id FROM schedules WHERE name = ${name} AND status = 'active'`;
    if (existing.length > 0) {
      console.error(`Error: schedule "${name}" already exists. Cancel it first or use a different name.`);
      process.exit(1);
    }

    const scheduleId = generateId();
    const triggerId = generateId();
    const runSpec = options.leaseTimeout ? { lease_timeout_ms: parseDuration(options.leaseTimeout) } : {};
    const metadata = {
      type: scheduleType,
      original_spec: options.at ?? options.every ?? options.after,
      timezone: options.timezone ?? 'UTC',
    };

    // biome-ignore lint/suspicious/noExplicitAny: postgres.js transaction type
    await sql.begin(async (tx: any) => {
      // Insert schedule
      await tx`
        INSERT INTO schedules (id, name, cron_expression, timezone, command, run_spec, metadata, status)
        VALUES (${scheduleId}, ${name}, ${cronExpr}, ${options.timezone ?? 'UTC'}, ${options.command}, ${JSON.stringify(runSpec)}, ${JSON.stringify(metadata)}, 'active')
      `;

      // Insert first trigger
      await tx`
        INSERT INTO triggers (id, schedule_id, due_at, status)
        VALUES (${triggerId}, ${scheduleId}, ${dueAt.toISOString()}, 'pending')
      `;
    });

    console.log(`Created schedule "${name}"`);
    console.log(`  ID:       ${scheduleId}`);
    console.log(`  Command:  ${options.command}`);
    console.log(`  Type:     ${scheduleType}`);
    console.log(`  Next due: ${formatTimestamp(dueAt)}`);

    await shutdown();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

/**
 * `genie schedule list [--json] [--watch]`
 */
async function scheduleListCommand(options: ListOptions): Promise<void> {
  try {
    const sql = await getConnection();

    const renderList = async () => {
      const rows = await sql<ScheduleRow[]>`
        SELECT
          s.id, s.name, s.cron_expression, s.command, s.status, s.metadata,
          t.due_at AS next_due, t.status AS trigger_status
        FROM schedules s
        LEFT JOIN LATERAL (
          SELECT due_at, status
          FROM triggers
          WHERE schedule_id = s.id AND status = 'pending'
          ORDER BY due_at ASC
          LIMIT 1
        ) t ON true
        WHERE s.status != 'deleted'
        ORDER BY s.name
      `;

      if (options.json) {
        const output = rows.map((r: ScheduleRow) => ({
          id: r.id,
          name: r.name,
          cron_expression: r.cron_expression,
          command: r.command,
          status: r.status,
          type: (r.metadata as Record<string, unknown>)?.type ?? 'unknown',
          next_due: r.next_due,
          trigger_status: r.trigger_status,
        }));
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      if (rows.length === 0) {
        console.log(
          'No schedules found. Create one with: genie schedule create <name> --command <cmd> --every <interval>',
        );
        return;
      }

      const tableRows = rows.map((r: ScheduleRow) => {
        const type = String((r.metadata as Record<string, unknown>)?.type ?? 'unknown');
        return [r.name, type, formatTimestamp(r.next_due), r.status, r.command ?? '-'];
      });

      printTable(['NAME', 'TYPE', 'NEXT DUE', 'STATUS', 'COMMAND'], tableRows);
    };

    if (options.watch) {
      // Clear screen and render in a loop
      const render = async () => {
        process.stdout.write('\x1b[2J\x1b[H'); // clear screen, move cursor to top
        console.log('Schedules (refreshing every 2s, Ctrl+C to exit)\n');
        await renderList();
      };

      await render();
      const interval = setInterval(render, 2000);

      // Handle graceful exit
      process.on('SIGINT', async () => {
        clearInterval(interval);
        await shutdown();
        process.exit(0);
      });
      return; // Keep process alive
    }

    await renderList();
    await shutdown();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

/**
 * `genie schedule cancel <name|id>`
 */
async function scheduleCancelCommand(nameOrId: string, _options: CancelOptions): Promise<void> {
  try {
    const sql = await getConnection();

    // Find schedule by name or id
    const schedules = await sql`
      SELECT id, name FROM schedules
      WHERE (name = ${nameOrId} OR id = ${nameOrId}) AND status = 'active'
    `;

    if (schedules.length === 0) {
      console.error(`Error: no active schedule found matching "${nameOrId}"`);
      process.exit(1);
    }

    const schedule = schedules[0];

    // biome-ignore lint/suspicious/noExplicitAny: postgres.js transaction type
    await sql.begin(async (tx: any) => {
      // Pause the schedule
      await tx`UPDATE schedules SET status = 'paused', updated_at = now() WHERE id = ${schedule.id}`;

      // Skip all pending triggers
      const skipped = await tx`
        UPDATE triggers SET status = 'skipped'
        WHERE schedule_id = ${schedule.id} AND status = 'pending'
      `;

      console.log(`Cancelled schedule "${schedule.name}"`);
      console.log(`  Skipped ${skipped.count} pending trigger${Number(skipped.count) === 1 ? '' : 's'}`);
    });

    await shutdown();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

/**
 * `genie schedule retry <name|id>`
 */
async function scheduleRetryCommand(nameOrId: string): Promise<void> {
  try {
    const sql = await getConnection();

    // Find the most recent failed trigger for this schedule
    const results = await sql`
      SELECT t.id AS trigger_id, t.schedule_id, s.name, s.command
      FROM triggers t
      JOIN schedules s ON s.id = t.schedule_id
      WHERE (s.name = ${nameOrId} OR s.id = ${nameOrId} OR t.id = ${nameOrId})
        AND t.status = 'failed'
      ORDER BY t.due_at DESC
      LIMIT 1
    `;

    if (results.length === 0) {
      console.error(`Error: no failed trigger found matching "${nameOrId}"`);
      process.exit(1);
    }

    const { trigger_id, name } = results[0];

    // biome-ignore lint/suspicious/noExplicitAny: postgres.js transaction type
    await sql.begin(async (tx: any) => {
      // Reset trigger to pending with new due_at
      await tx`
        UPDATE triggers
        SET status = 'pending', due_at = now(), started_at = NULL, completed_at = NULL
        WHERE id = ${trigger_id}
      `;

      // Ensure schedule is active
      await tx`
        UPDATE schedules
        SET status = 'active', updated_at = now()
        WHERE id = ${results[0].schedule_id} AND status != 'active'
      `;
    });

    console.log(`Retrying schedule "${name}"`);
    console.log(`  Trigger ${trigger_id} reset to pending`);
    console.log('  New due: now');

    await shutdown();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

/**
 * `genie schedule history <name|id> [--limit N]`
 */
async function scheduleHistoryCommand(nameOrId: string, options: HistoryOptions): Promise<void> {
  try {
    const sql = await getConnection();
    const limit = options.limit ?? 20;

    // Find schedule
    const schedules = await sql`
      SELECT id, name FROM schedules
      WHERE name = ${nameOrId} OR id = ${nameOrId}
      LIMIT 1
    `;

    if (schedules.length === 0) {
      console.error(`Error: no schedule found matching "${nameOrId}"`);
      process.exit(1);
    }

    const schedule = schedules[0];

    const rows = await sql<HistoryRow[]>`
      SELECT
        t.id AS trigger_id,
        t.due_at,
        t.status AS trigger_status,
        r.id AS run_id,
        r.status AS run_status,
        r.started_at,
        r.completed_at,
        CASE
          WHEN r.completed_at IS NOT NULL AND r.started_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (r.completed_at - r.started_at)) * 1000
          ELSE NULL
        END AS duration_ms,
        r.error
      FROM triggers t
      LEFT JOIN runs r ON r.trigger_id = t.id
      WHERE t.schedule_id = ${schedule.id}
      ORDER BY t.due_at DESC
      LIMIT ${limit}
    `;

    if (rows.length === 0) {
      console.log(`No execution history for schedule "${schedule.name}"`);
      await shutdown();
      return;
    }

    console.log(`\nHistory for "${schedule.name}":\n`);

    const tableRows = rows.map((r: HistoryRow) => [
      formatTimestamp(r.due_at),
      r.trigger_status,
      r.run_status ?? '-',
      formatDuration(r.duration_ms),
      r.error ? r.error.slice(0, 60) : '-',
    ]);

    printTable(['DUE AT', 'TRIGGER', 'RUN', 'DURATION', 'ERROR'], tableRows);

    await shutdown();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

// ============================================================================
// Registration
// ============================================================================

export function registerScheduleCommands(program: Command): void {
  const schedule = program.command('schedule').description('Manage scheduled triggers');

  schedule
    .command('create <name>')
    .description('Create a new schedule')
    .requiredOption('--command <cmd>', 'Command to execute (e.g., "genie spawn reviewer")')
    .option('--at <time>', 'One-time schedule at absolute time (ISO 8601)')
    .option('--every <interval>', 'Repeating schedule: duration (10m, 2h, 24h) or cron expression')
    .option('--after <duration>', 'One-time schedule after delay (10m, 2h)')
    .option('--timezone <tz>', 'Timezone for schedule (default: UTC)', 'UTC')
    .option('--lease-timeout <duration>', 'Lease timeout for runs (default: 5m)')
    .action(async (name: string, options: CreateOptions) => {
      await scheduleCreateCommand(name, options);
    });

  schedule
    .command('list')
    .description('List schedules with next due trigger')
    .option('--json', 'Output as JSON')
    .option('--watch', 'Refresh every 2s')
    .action(async (options: ListOptions) => {
      await scheduleListCommand(options);
    });

  schedule
    .command('cancel <name>')
    .description('Cancel a schedule and skip pending triggers')
    .option('--filter <expr>', 'Filter expression (e.g., status=pending)')
    .action(async (name: string, options: CancelOptions) => {
      await scheduleCancelCommand(name, options);
    });

  schedule
    .command('retry <name>')
    .description('Reset a failed trigger to pending')
    .action(async (name: string) => {
      await scheduleRetryCommand(name);
    });

  schedule
    .command('history <name>')
    .description('Show past executions for a schedule')
    .option('--limit <n>', 'Max rows to show (default: 20)', Number.parseInt)
    .action(async (name: string, options: HistoryOptions) => {
      await scheduleHistoryCommand(name, options);
    });
}
