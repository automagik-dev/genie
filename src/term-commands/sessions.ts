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
import { ingestSessions } from '../lib/session-ingester.js';
import { formatRelativeTimestamp as formatTimestamp, padRight } from '../lib/term-format.js';

// ============================================================================
// Command Handlers
// ============================================================================

interface ListOptions {
  active?: boolean;
  orphaned?: boolean;
  agent?: string;
  json?: boolean;
}

async function sessionsListCommand(options: ListOptions): Promise<void> {
  if (!(await isAvailable())) {
    console.error('Database not available.');
    process.exit(1);
  }

  const sql = await getConnection();

  // biome-ignore lint/suspicious/noExplicitAny: PG row is dynamically typed
  let rows: any[];
  if (options.active) {
    rows = await sql`SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at DESC LIMIT 50`;
  } else if (options.orphaned) {
    rows = await sql`SELECT * FROM sessions WHERE status = 'orphaned' ORDER BY started_at DESC LIMIT 50`;
  } else if (options.agent) {
    rows =
      await sql`SELECT * FROM sessions WHERE agent_id = ${options.agent} OR agent_id LIKE ${`%${options.agent}%`} ORDER BY started_at DESC LIMIT 50`;
  } else {
    rows = await sql`SELECT * FROM sessions ORDER BY started_at DESC LIMIT 50`;
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
  // biome-ignore lint/suspicious/noExplicitAny: PG row is dynamically typed
  const data = rows.map((r: any) => [
    (r.id as string).slice(0, 12),
    r.agent_id ?? '(orphaned)',
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
// biome-ignore lint/suspicious/noExplicitAny: PG rows are dynamically typed
function buildTimeline(content: any[], events: any[]): Array<{ ts: string; type: string; text: string }> {
  const timeline: Array<{ ts: string; type: string; text: string }> = [];
  for (const c of content) {
    const prefix = c.role === 'assistant' ? '[assistant]' : c.role === 'tool_input' ? '[tool_in]' : '[tool_out]';
    const toolLabel = c.tool_name ? ` [${c.tool_name}]` : '';
    timeline.push({ ts: c.timestamp, type: `${prefix}${toolLabel}`, text: (c.content as string).slice(0, 200) });
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

  // Get session metadata
  const sessions = await sql`SELECT * FROM sessions WHERE id = ${sessionId}`;
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
  console.log(`Session: ${session.id}`);
  console.log(`Agent: ${session.agent_id ?? '(orphaned)'}`);
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
           s.agent_id, s.team
    FROM session_content sc
    JOIN sessions s ON s.id = sc.session_id
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

  // biome-ignore lint/suspicious/noExplicitAny: PG row is dynamically typed
  for (const r of rows as any[]) {
    console.log(`[${formatTimestamp(r.timestamp)}] ${r.agent_id ?? 'orphaned'} / ${r.session_id.slice(0, 12)}`);
    console.log(`  ${r.role}${r.tool_name ? ` [${r.tool_name}]` : ''}: ${r.headline}`);
  }
  console.log(`\n(${rows.length} result${rows.length === 1 ? '' : 's'})`);
}

async function sessionsIngestCommand(options: { backfill?: boolean }): Promise<void> {
  if (options.backfill) {
    console.log('Backfilling all session JSONL files...');
  } else {
    console.log('Running incremental session ingestion...');
  }

  try {
    const result = await ingestSessions();
    console.log(`Ingested ${result.ingested} content rows, ${result.orphaned} orphaned sessions.`);
  } catch (err) {
    console.error(`Ingestion failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
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
    .command('ingest')
    .description('Manual batch import of JSONL files')
    .option('--backfill', 'Backfill all existing JSONL files')
    .action(async (options: { backfill?: boolean }) => {
      await sessionsIngestCommand(options);
    });
}
