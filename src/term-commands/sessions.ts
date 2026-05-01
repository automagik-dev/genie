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
import {
  type OrphanSessionSample,
  type SessionLinkDiagnostics,
  diagnoseSessionLinks,
  findAmbiguousExecutorSessions,
  sampleLinkableOrphanSessions,
} from '../lib/session-link-repair.js';
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

// ============================================================================
// repair-links — diagnose and (with --apply) repair linkable orphan sessions.
//
// Reads from src/lib/session-link-repair.ts (pure-read diagnostics) and
// performs the mutation in a single transaction with a re-count gate so a
// concurrent ingestion that changes the candidate count between preview and
// apply forces the operator to re-confirm with --force.
// ============================================================================

interface RepairLinksOptions {
  apply?: boolean;
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
}

interface RepairLinksApplyResult {
  sessionsLinked: number;
  toolEventsBackfilled: number;
  ambiguousCount: number;
  forced: boolean;
  driftDetected: boolean;
}

function printRepairDiagnostics(
  diag: SessionLinkDiagnostics,
  sample: OrphanSessionSample[],
  ambiguous: { claudeSessionId: string; executorIds: string[] }[],
): void {
  console.log('Sessions:');
  console.log(`  total: ${diag.totalSessions}`);
  console.log(
    `  linkable orphans (sessions.id = executors.claude_session_id ∧ executor_id IS NULL): ${diag.linkableOrphanSessions}`,
  );
  console.log(`  status='orphaned': ${diag.statusOrphanedSessions}`);
  console.log(`  NULL executor_id: ${diag.nullExecutorIdSessions}`);
  console.log('Tool events:');
  console.log(`  total: ${diag.totalToolEvents}`);
  console.log(`  missing agent_id (NULL or ''): ${diag.toolEventsMissingAgent}`);
  console.log(`  missing team    (NULL or ''): ${diag.toolEventsMissingTeam}`);
  console.log(`  missing wish_slug (NULL or ''): ${diag.toolEventsMissingWish}`);
  console.log(`  missing task_id (NULL or ''): ${diag.toolEventsMissingTask}`);
  console.log(`  empty-string agent_id: ${diag.toolEventsEmptyStringAgent}`);
  console.log(`  empty-string team:     ${diag.toolEventsEmptyStringTeam}`);
  console.log(`  empty-string wish_slug:${diag.toolEventsEmptyStringWish}`);
  console.log(`  empty-string task_id:  ${diag.toolEventsEmptyStringTask}`);
  console.log(
    `  linkable (session has executor_id, event missing attribution): ${diag.toolEventsLinkableMissingAttribution}`,
  );

  if (sample.length > 0) {
    console.log('\nLinkable orphan sample (up to 10):');
    for (const s of sample) {
      console.log(
        `  ${s.sessionId}  executor=${s.executorId.slice(0, 12)}  agent=${(s.agentId ?? '-').slice(0, 12)}  status=${s.status ?? '-'}`,
      );
    }
  }

  if (ambiguous.length > 0) {
    console.log(
      `\n⚠️ Ambiguous claude_session_id values (${ambiguous.length}) — multiple executors claim the same session id:`,
    );
    for (const a of ambiguous) {
      console.log(`  ${a.claudeSessionId} -> ${a.executorIds.join(', ')}`);
    }
    console.log('  --apply will refuse unless --force is passed.');
  }
}

// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type
async function applyRepairTransaction(sql: any, previewCount: number, force: boolean): Promise<RepairLinksApplyResult> {
  let result: RepairLinksApplyResult = {
    sessionsLinked: 0,
    toolEventsBackfilled: 0,
    ambiguousCount: 0,
    forced: force,
    driftDetected: false,
  };

  // biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type
  await sql.begin(async (tx: any) => {
    // Re-count INSIDE the transaction so a concurrent ingestion changing the
    // candidate set between preview and apply trips the gate. With READ
    // COMMITTED (postgres default) this still leaves a tiny TOCTOU window,
    // but the gate catches the common case ("ingestion ran while operator
    // was reading the dry-run output").
    const [recount] = await tx`
      SELECT count(*)::int AS n
      FROM sessions s
      JOIN executors e ON s.id = e.claude_session_id
      WHERE s.executor_id IS NULL
    `;

    if (recount.n !== previewCount && !force) {
      result.driftDetected = true;
      throw new Error(
        `repair-links: candidate count drifted between preview (${previewCount}) and apply (${recount.n}). Re-run --dry-run or pass --force to override.`,
      );
    }

    const linkResult = await tx`
      UPDATE sessions s SET
        executor_id = e.id,
        agent_id    = COALESCE(s.agent_id,    e.agent_id),
        team        = COALESCE(s.team,        a.team),
        wish_slug   = COALESCE(s.wish_slug,   a.wish_slug),
        task_id     = COALESCE(s.task_id,     a.task_id),
        role        = COALESCE(s.role,        a.role),
        status      = CASE WHEN s.status = 'orphaned' THEN 'active' ELSE s.status END,
        updated_at  = now()
      FROM executors e
      LEFT JOIN agents a ON e.agent_id = a.id
      WHERE s.id = e.claude_session_id
        AND s.executor_id IS NULL
    `;

    // Backfill tool_events from linked sessions. NULLIF(field, '') treats the
    // legacy empty-string writes (wish decision #4) as missing so the linked
    // session value can replace them. We never overwrite a non-empty,
    // non-null value.
    //
    // Idempotency: the WHERE filters to rows where the post-COALESCE result
    // would actually differ from the current value. Without this, a second
    // --apply still "touches" rows where session.X is also NULL, producing
    // a non-zero row count for a no-op update. IS DISTINCT FROM treats
    // NULL = NULL as same, so unchanged rows are skipped.
    const teResult = await tx`
      UPDATE tool_events te SET
        agent_id  = COALESCE(NULLIF(te.agent_id, ''),  s.agent_id),
        team      = COALESCE(NULLIF(te.team, ''),      s.team),
        wish_slug = COALESCE(NULLIF(te.wish_slug, ''), s.wish_slug),
        task_id   = COALESCE(NULLIF(te.task_id, ''),   s.task_id)
      FROM sessions s
      WHERE s.id = te.session_id
        AND s.executor_id IS NOT NULL
        AND (
          te.agent_id  IS DISTINCT FROM COALESCE(NULLIF(te.agent_id, ''),  s.agent_id)  OR
          te.team      IS DISTINCT FROM COALESCE(NULLIF(te.team, ''),      s.team)      OR
          te.wish_slug IS DISTINCT FROM COALESCE(NULLIF(te.wish_slug, ''), s.wish_slug) OR
          te.task_id   IS DISTINCT FROM COALESCE(NULLIF(te.task_id, ''),   s.task_id)
        )
    `;

    // Audit row records totals only — never raw session content. Use
    // tx.json(...) so the JSONB column gets a real object, not a
    // string-of-string (the JSON.stringify trap that postgres.js silently
    // accepts as JSON-typed string).
    await tx`
      INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details)
      VALUES (
        'sessions',
        'repair-links',
        'sessions.repair_links',
        'cli',
        ${tx.json({
          sessions_linked: linkResult.count ?? 0,
          tool_events_backfilled: teResult.count ?? 0,
          preview_count: previewCount,
          recount: recount.n,
          forced: force,
        })}
      )
    `;

    result = {
      sessionsLinked: linkResult.count ?? 0,
      toolEventsBackfilled: teResult.count ?? 0,
      ambiguousCount: 0,
      forced: force,
      driftDetected: false,
    };
  });

  return result;
}

function renderDryRun(
  diag: SessionLinkDiagnostics,
  sample: OrphanSessionSample[],
  ambiguous: { claudeSessionId: string; executorIds: string[] }[],
  json: boolean,
): void {
  if (json) {
    console.log(JSON.stringify({ diagnostics: diag, sample, ambiguous }, null, 2));
    return;
  }
  console.log('repair-links --dry-run (no rows mutated)');
  console.log('-----------------------------------------');
  printRepairDiagnostics(diag, sample, ambiguous);
  if (diag.linkableOrphanSessions === 0 && diag.toolEventsLinkableMissingAttribution === 0) {
    console.log('\nNothing to repair.');
  } else {
    console.log(
      `\nRun with --apply to repair ${diag.linkableOrphanSessions} session(s) and up to ${diag.toolEventsLinkableMissingAttribution} tool_event(s).`,
    );
  }
}

function renderApplyResult(result: RepairLinksApplyResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('repair-links --apply complete');
  console.log(`  sessions linked:        ${result.sessionsLinked}`);
  console.log(`  tool_events backfilled: ${result.toolEventsBackfilled}`);
  if (result.forced) console.log('  --force was used');
}

async function sessionsRepairLinksCommand(options: RepairLinksOptions): Promise<void> {
  if (!(await isAvailable())) {
    console.error('Database not available.');
    process.exit(1);
  }

  const sql = await getConnection();
  const diag = await diagnoseSessionLinks(sql);
  const sample = await sampleLinkableOrphanSessions(sql, 10);
  const ambiguous = await findAmbiguousExecutorSessions(sql);

  // Default = dry-run. --apply explicitly enters mutation mode.
  const apply = options.apply === true;
  if (!apply) {
    renderDryRun(diag, sample, ambiguous, options.json === true);
    return;
  }

  // --apply path
  if (ambiguous.length > 0 && !options.force) {
    console.error(
      `repair-links: ${ambiguous.length} ambiguous claude_session_id value(s) found. Multiple executors claim the same session id — refusing --apply.\nRun with --dry-run to inspect, or pass --force to override.`,
    );
    process.exit(2);
  }

  const noWork = diag.linkableOrphanSessions === 0 && diag.toolEventsLinkableMissingAttribution === 0;
  if (noWork) {
    if (options.json) {
      console.log(JSON.stringify({ sessionsLinked: 0, toolEventsBackfilled: 0, idempotent: true }, null, 2));
    } else {
      console.log('repair-links: nothing to repair (0 candidates).');
    }
    return;
  }

  let result: RepairLinksApplyResult;
  try {
    result = await applyRepairTransaction(sql, diag.linkableOrphanSessions, options.force === true);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }

  renderApplyResult(result, options.json === true);
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

  sessions
    .command('repair-links')
    .description('Diagnose and (with --apply) repair linkable orphan sessions + tool_events attribution')
    .option('--dry-run', 'Preview only — never mutates rows (default)')
    .option('--apply', 'Run the repair transaction')
    .option('--force', 'Override the candidate-count drift gate and ambiguity gate')
    .option('--json', 'Output as JSON')
    .action(async (options: RepairLinksOptions) => {
      await sessionsRepairLinksCommand(options);
    });
}
