/**
 * Metrics CLI — machine state, snapshots history.
 *
 * Commands:
 *   genie metrics now             — current machine state
 *   genie metrics history [--since 1h] — machine_snapshots over time
 *   genie metrics agents          — DEPRECATED stub (corpse counter); see `genie status`.
 *
 * `genie metrics agents` was a per-agent heartbeat summary indexed by
 * `process_id`. It failed Measurer's methodology rule on day one: no
 * defined consumer, no action threshold. Restarts left dead `process_id`
 * rows in the result, so the table grew monotonically and lied harder
 * with every reboot ("65 dead, 0 alive"). It was deleted in the
 * invincible-genie wish (Group 5). The stub remains for one release as
 * a deprecation notice that redirects callers to `genie status`, which
 * is indexed by agent identity (not pid) and aggregates the
 * `shouldResume()` chokepoint instead of stale heartbeats.
 */

import type { Command } from 'commander';
import { getConnection, isAvailable } from '../lib/db.js';
import { queryRuntimeEventThroughput } from '../lib/runtime-events.js';
import { formatRelativeTimestamp as formatTimestamp, padRight } from '../lib/term-format.js';

function parseSince(since: string): string {
  const match = since.match(/^(\d+)([smhd])$/);
  if (!match) return since;
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const ms = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 3_600_000;
  return new Date(Date.now() - amount * ms).toISOString();
}

// ============================================================================
// Row types
// ============================================================================

interface SnapshotRow {
  active_workers: number;
  active_teams: number;
  tmux_sessions: number;
  cpu_percent: number | null;
  memory_mb: number | null;
  created_at: string;
}

// ============================================================================
// Command Handlers
// ============================================================================

async function metricsNowCommand(options: { json?: boolean }): Promise<void> {
  if (!(await isAvailable())) {
    console.error('Database not available.');
    process.exit(1);
  }

  const sql = await getConnection();

  // Latest machine snapshot
  const snapshots = await sql`SELECT * FROM machine_snapshots ORDER BY created_at DESC LIMIT 1`;
  // Active agent count (via executors table — source of truth for runtime state)
  const agentCount =
    await sql`SELECT count(DISTINCT agent_id)::int as cnt FROM executors WHERE state NOT IN ('done', 'error', 'terminated')`;
  // Active team count
  const teamCount = await sql`SELECT count(*)::int as cnt FROM teams WHERE status = 'in_progress'`;

  const snapshot = snapshots[0] ?? {};

  // Event throughput: count runtime events emitted in the last 60s.
  // Must be DB-backed — a CLI process can't observe the emitter's in-process
  // counters, which used to show 0 even when the system was busy.
  const throughput = await queryRuntimeEventThroughput(60);

  const data = {
    active_workers: snapshot.active_workers ?? agentCount[0]?.cnt ?? 0,
    active_teams: snapshot.active_teams ?? teamCount[0]?.cnt ?? 0,
    tmux_sessions: snapshot.tmux_sessions ?? 0,
    cpu_percent: snapshot.cpu_percent ?? null,
    memory_mb: snapshot.memory_mb ?? null,
    snapshot_at: snapshot.created_at ? new Date(snapshot.created_at).toISOString() : null,
    events_emitted_last_60s: throughput.emitted,
  };

  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log('Machine State:');
  console.log(`  Workers:  ${data.active_workers}`);
  console.log(`  Teams:    ${data.active_teams}`);
  console.log(`  Tmux:     ${data.tmux_sessions} sessions`);
  if (data.cpu_percent !== null) console.log(`  CPU:      ${data.cpu_percent}%`);
  if (data.memory_mb !== null) console.log(`  Memory:   ${data.memory_mb} MB`);
  if (data.snapshot_at) console.log(`  As of:    ${formatTimestamp(data.snapshot_at)}`);
  console.log('\nEvent Throughput (last 60s):');
  console.log(`  Emitted:  ${data.events_emitted_last_60s}`);
}

async function metricsHistoryCommand(options: { since?: string; json?: boolean }): Promise<void> {
  if (!(await isAvailable())) {
    console.error('Database not available.');
    process.exit(1);
  }

  const sql = await getConnection();
  const sinceTs = parseSince(options.since ?? '1h');

  const rows = await sql`
    SELECT active_workers, active_teams, tmux_sessions, cpu_percent, memory_mb, created_at
    FROM machine_snapshots
    WHERE created_at >= ${sinceTs}::timestamptz
    ORDER BY created_at ASC
  `;

  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log('No snapshots in the given time range.');
    return;
  }

  const headers = ['Time', 'Workers', 'Teams', 'Tmux', 'CPU%', 'Mem MB'];
  const data = rows.map((r: SnapshotRow) => [
    formatTimestamp(r.created_at),
    String(r.active_workers ?? 0),
    String(r.active_teams ?? 0),
    String(r.tmux_sessions ?? 0),
    r.cpu_percent !== null ? String(r.cpu_percent) : '-',
    r.memory_mb !== null ? String(r.memory_mb) : '-',
  ]);

  const widths = headers.map((h, i) => {
    const colVals = data.map((row: string[]) => row[i]);
    return Math.max(h.length, ...colVals.map((v: string) => v.length));
  });

  console.log(headers.map((h, i) => padRight(h, widths[i])).join(' | '));
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
  for (const row of data) {
    console.log(row.map((v: string, i: number) => padRight(v, widths[i])).join(' | '));
  }
  console.log(`\n(${rows.length} snapshot${rows.length === 1 ? '' : 's'})`);
}

/**
 * Deprecation stub — `genie metrics agents` was deleted in invincible-genie
 * Group 5. Prints a redirect notice and exits 0 so any one-off scripts that
 * still reference it don't break in CI before the user has migrated.
 */
export async function metricsAgentsCommand(options: { json?: boolean }): Promise<void> {
  const message = 'Use `genie status` for live agent state.';
  if (options.json) {
    console.log(
      JSON.stringify({
        deprecated: true,
        replacement: 'genie status',
        message,
      }),
    );
    return;
  }
  console.error('⚠️  `genie metrics agents` is deprecated and will be removed in a future release.');
  console.error(`    ${message}`);
}

// ============================================================================
// Registration
// ============================================================================

export function registerMetricsCommands(program: Command): void {
  const metrics = program.command('metrics').description('Machine metrics — snapshots, heartbeats, agents');

  metrics
    .command('now', { isDefault: true })
    .description('Current machine state')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      await metricsNowCommand(options);
    });

  metrics
    .command('history')
    .description('Machine snapshot history')
    .option('--since <duration>', 'Time window (e.g., 1h, 6h, 1d)', '1h')
    .option('--json', 'Output as JSON')
    .action(async (options: { since?: string; json?: boolean }) => {
      await metricsHistoryCommand(options);
    });

  metrics
    .command('agents')
    .description('[DEPRECATED] Use `genie status` for live agent state')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      await metricsAgentsCommand(options);
    });
}
