/**
 * Sessions CLI — query and replay Claude Code sessions.
 *
 * Commands:
 *   genie sessions list [--active|--orphaned|--agent X]
 *   genie sessions replay <session-id>
 *   genie sessions search <query>
 *   genie sessions ingest [--backfill]
 */

import type { Command } from 'commander';
import { getConnection, isAvailable } from '../lib/db.js';
import { getBackfillStatus } from '../lib/session-backfill.js';
import { formatRelativeTimestamp as formatTimestamp, padRight } from '../lib/term-format.js';

// ============================================================================
// Command Handlers
// ============================================================================

interface SessionRow {
  id: string;
  executor_id: string | null;
  agent_id: string | null;
  team: string | null;
  role: string | null;
  status: string;
  total_turns: number | null;
  started_at: string | null;
  created_at: string;
  agent_name?: string | null;
}

interface ContentRow {
  turn_index: number;
  role: string;
  content: string;
  tool_name: string | null;
  timestamp: string;
}

interface EventRow {
  entity_type: string;
  event_type: string;
  actor: string;
  details: Record<string, unknown>;
  created_at: string;
}

interface ListOptions {
  active?: boolean;
  orphaned?: boolean;
  agent?: string;
  source?: string;
  limit?: string;
  json?: boolean;
}

/** Resolve display name for a session's agent — prefers executor→agent join, falls back to agent_id. */
function resolveAgentLabel(r: SessionRow): string {
  if (r.agent_name) return r.agent_name;
  if (r.executor_id) return r.executor_id.slice(0, 12);
  if (r.agent_id) return r.agent_id;
  return '(orphaned)';
}

async function sessionsListCommand(options: ListOptions): Promise<void> {
  if (!(await isAvailable())) {
    console.error('Database not available.');
    process.exit(1);
  }

  const sql = await getConnection();
  const limit = Number(options.limit) || 50;

  // Build optional source filter fragment
  const sourceFilter = options.source ? sql`AND e.metadata->>'source' = ${options.source}` : sql``;

  let rows: SessionRow[];
  if (options.active) {
    rows = await sql`
      SELECT s.*, a.custom_name as agent_name
      FROM sessions s
      LEFT JOIN executors e ON s.executor_id = e.id
      LEFT JOIN agents a ON e.agent_id = a.id
      WHERE s.status = 'active' ${sourceFilter}
      ORDER BY s.started_at DESC LIMIT ${limit}`;
  } else if (options.orphaned) {
    rows = await sql`
      SELECT s.*, a.custom_name as agent_name
      FROM sessions s
      LEFT JOIN executors e ON s.executor_id = e.id
      LEFT JOIN agents a ON e.agent_id = a.id
      WHERE s.status = 'orphaned' ${sourceFilter}
      ORDER BY s.started_at DESC LIMIT ${limit}`;
  } else if (options.agent) {
    // Search by agent name/id via executor join, fall back to legacy agent_id
    rows = await sql`
      SELECT s.*, a.custom_name as agent_name
      FROM sessions s
      LEFT JOIN executors e ON s.executor_id = e.id
      LEFT JOIN agents a ON e.agent_id = a.id
      WHERE (a.custom_name = ${options.agent}
        OR a.role = ${options.agent}
        OR s.agent_id = ${options.agent}
        OR s.agent_id LIKE ${`%${options.agent}%`}) ${sourceFilter}
      ORDER BY s.started_at DESC LIMIT ${limit}`;
  } else if (options.source) {
    rows = await sql`
      SELECT s.*, a.custom_name as agent_name
      FROM sessions s
      LEFT JOIN executors e ON s.executor_id = e.id
      LEFT JOIN agents a ON e.agent_id = a.id
      WHERE e.metadata->>'source' = ${options.source}
      ORDER BY s.started_at DESC LIMIT ${limit}`;
  } else {
    rows = await sql`
      SELECT s.*, a.custom_name as agent_name
      FROM sessions s
      LEFT JOIN executors e ON s.executor_id = e.id
      LEFT JOIN agents a ON e.agent_id = a.id
      ORDER BY s.started_at DESC LIMIT ${limit}`;
  }

  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log('No sessions found.');
    return;
  }

  const headers = ['ID', 'Agent', 'Team', 'Status', 'Turns', 'Started'];
  const data = rows.map((r: SessionRow) => [
    r.id.slice(0, 12),
    resolveAgentLabel(r),
    r.team ?? '-',
    r.status,
    String(r.total_turns ?? 0),
    formatTimestamp(r.started_at ?? r.created_at),
  ]);

  const widths = headers.map((h, i) => {
    const colVals = data.map((row: string[]) => row[i]);
    return Math.min(30, Math.max(h.length, ...colVals.map((v: string) => v.length)));
  });

  console.log(headers.map((h, i) => padRight(h, widths[i])).join(' | '));
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
  for (const row of data) {
    console.log(row.map((v: string, i: number) => padRight(v.slice(0, widths[i]), widths[i])).join(' | '));
  }
  console.log(`\n(${rows.length} session${rows.length === 1 ? '' : 's'})`);
}

/** Build a timeline by interleaving session content and audit events. */
function buildTimeline(content: ContentRow[], events: EventRow[]): Array<{ ts: string; type: string; text: string }> {
  const timeline: Array<{ ts: string; type: string; text: string }> = [];
  for (const c of content) {
    const prefix = c.role === 'assistant' ? '[assistant]' : c.role === 'tool_input' ? '[tool_in]' : '[tool_out]';
    const toolLabel = c.tool_name ? ` [${c.tool_name}]` : '';
    timeline.push({ ts: c.timestamp, type: `${prefix}${toolLabel}`, text: c.content.slice(0, 200) });
  }
  for (const e of events) {
    timeline.push({ ts: e.created_at, type: `[event] ${e.event_type}`, text: JSON.stringify(e.details).slice(0, 100) });
  }
  timeline.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return timeline;
}

async function sessionsReplayCommand(sessionId: string, options: { json?: boolean }): Promise<void> {
  if (!(await isAvailable())) {
    console.error('Database not available.');
    process.exit(1);
  }

  const sql = await getConnection();

  // Get session metadata with executor/agent join
  const sessions = await sql`
    SELECT s.*, a.custom_name as agent_name, e.provider, e.state as executor_state
    FROM sessions s
    LEFT JOIN executors e ON s.executor_id = e.id
    LEFT JOIN agents a ON e.agent_id = a.id
    WHERE s.id = ${sessionId}`;
  if (sessions.length === 0) {
    console.error(`Session "${sessionId}" not found.`);
    process.exit(1);
  }

  // Get content from session_content
  const content = await sql`
    SELECT turn_index, role, content, tool_name, timestamp
    FROM session_content
    WHERE session_id = ${sessionId}
    ORDER BY turn_index ASC
  `;

  // Get events from audit_events
  const events = await sql`
    SELECT entity_type, event_type, actor, details, created_at
    FROM audit_events
    WHERE entity_id = ${sessionId}
    ORDER BY created_at ASC
  `;

  if (options.json) {
    console.log(JSON.stringify({ session: sessions[0], content, events }, null, 2));
    return;
  }

  const session = sessions[0];
  const agentLabel = session.agent_name ?? session.agent_id ?? '(orphaned)';
  console.log(`Session: ${session.id}`);
  console.log(`Agent: ${agentLabel}`);
  if (session.executor_id)
    console.log(`Executor: ${session.executor_id.slice(0, 12)} (${session.provider ?? 'unknown'})`);
  console.log(`Team: ${session.team ?? '-'} | Role: ${session.role ?? '-'}`);
  console.log(`Status: ${session.status} | Turns: ${session.total_turns ?? 0}`);
  console.log('---');

  // Interleave content and events by timestamp
  const timeline = buildTimeline(content, events);

  for (const entry of timeline) {
    console.log(`[${formatTimestamp(entry.ts)}] ${entry.type}`);
    console.log(`  ${entry.text}`);
  }

  console.log(`\n(${content.length} turns, ${events.length} events)`);
}

async function sessionsSearchCommand(query: string, options: { json?: boolean; limit?: string }): Promise<void> {
  if (!(await isAvailable())) {
    console.error('Database not available.');
    process.exit(1);
  }

  const sql = await getConnection();
  const limit = options.limit ? Number.parseInt(options.limit, 10) : 20;

  const rows = await sql`
    SELECT sc.session_id, sc.turn_index, sc.role, sc.tool_name, sc.timestamp,
           ts_headline('english', sc.content, plainto_tsquery('english', ${query}),
             'StartSel=>>>, StopSel=<<<, MaxWords=30, MinWords=10') as headline,
           COALESCE(a.custom_name, s.agent_id) as agent_label, s.team
    FROM session_content sc
    JOIN sessions s ON s.id = sc.session_id
    LEFT JOIN executors e ON s.executor_id = e.id
    LEFT JOIN agents a ON e.agent_id = a.id
    WHERE to_tsvector('english', sc.content) @@ plainto_tsquery('english', ${query})
    ORDER BY sc.timestamp DESC
    LIMIT ${limit}
  `;

  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(`No results for "${query}".`);
    return;
  }

  for (const r of rows) {
    console.log(`[${formatTimestamp(r.timestamp)}] ${r.agent_label ?? 'orphaned'} / ${r.session_id.slice(0, 12)}`);
    console.log(`  ${r.role}${r.tool_name ? ` [${r.tool_name}]` : ''}: ${r.headline}`);
  }
  console.log(`\n(${rows.length} result${rows.length === 1 ? '' : 's'})`);
}

async function sessionsSyncStatusCommand(): Promise<void> {
  if (!(await isAvailable())) {
    console.error('Database not available.');
    process.exit(1);
  }
  const sql = await getConnection();
  const status = await getBackfillStatus(sql);
  if (!status) {
    console.log('No backfill has been started. It runs automatically on first daemon start.');
    return;
  }
  const pct = status.totalFiles > 0 ? ((status.processedFiles / status.totalFiles) * 100).toFixed(1) : '0.0';
  const mbRead = (status.processedBytes / 1024 / 1024).toFixed(1);
  const mbTotal = (status.totalBytes / 1024 / 1024).toFixed(1);
  console.log(`Session backfill: ${status.processedFiles} / ${status.totalFiles} files (${pct}%)`);
  console.log(`Bytes read:   ${mbRead} MB / ${mbTotal} MB`);
  console.log(`Errors: ${status.errors}`);
  console.log(`Status: ${status.status}`);
}

// ============================================================================
// Registration
// ============================================================================

export function registerSessionsCommands(program: Command): void {
  const sessions = program.command('sessions').description('Session history — list, replay, search');

  sessions
    .command('list', { isDefault: true })
    .description('List Claude Code sessions')
    .option('--active', 'Show only active sessions')
    .option('--orphaned', 'Show only orphaned sessions')
    .option('--agent <name>', 'Filter by agent')
    .option('--source <name>', 'Filter by executor metadata source (e.g. omni)')
    .option('--limit <n>', 'Max number of sessions to return (default: 50)')
    .option('--json', 'Output as JSON')
    .action(async (options: ListOptions) => {
      await sessionsListCommand(options);
    });

  sessions
    .command('replay <session-id>')
    .description('Replay a session — interleave content + events')
    .option('--json', 'Output as JSON')
    .action(async (sessionId: string, options: { json?: boolean }) => {
      await sessionsReplayCommand(sessionId, options);
    });

  sessions
    .command('search <query>')
    .description('Full-text search across session content')
    .option('--json', 'Output as JSON')
    .option('--limit <n>', 'Max results', '20')
    .action(async (query: string, options: { json?: boolean; limit?: string }) => {
      await sessionsSearchCommand(query, options);
    });

  sessions
    .command('sync')
    .description('Check session backfill progress')
    .action(async () => {
      await sessionsSyncStatusCommand();
    });
}
