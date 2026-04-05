/**
 * Genie App Backend — NATS service entry point.
 *
 * Connects to PG and NATS, registers request/reply handlers for all
 * subjects consumed by the 9 frontend screens, bridges PG LISTEN/NOTIFY
 * events to NATS pub/sub, and manages PTY sessions.
 */

process.env.GENIE_APP = '1';

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { type NatsConnection, StringCodec, connect } from 'nats';
import { getConnection } from '../../../src/lib/db.js';
import { GENIE_SUBJECTS } from '../lib/subjects.js';
import * as pgBridge from './pg-bridge.js';
import * as pty from './pty.js';

// ============================================================================
// Configuration
// ============================================================================

const NATS_URL = process.env.GENIE_NATS_URL ?? 'nats://localhost:4222';
const ORG_ID = process.env.GENIE_ORG_ID ?? 'default';
/** PG URL — informational, actual connection via getConnection() from db.ts */
const _PG_URL = process.env.GENIE_PG_URL ?? 'postgresql://localhost:19642/genie';

const sc = StringCodec();

// ============================================================================
// Lifecycle
// ============================================================================

let nc: NatsConnection | null = null;
let shutdownRequested = false;

async function start(): Promise<void> {
  console.log('[genie-app] Starting backend service...');
  console.log(`[genie-app] NATS: ${NATS_URL}`);
  console.log(`[genie-app] Org: ${ORG_ID}`);

  // 1. Connect to PG
  const sql = await getConnection();
  console.log('[genie-app] PG connected');

  // 2. Connect to NATS
  nc = await connect({
    servers: NATS_URL,
    name: 'genie-app-backend',
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
  });
  console.log('[genie-app] NATS connected');

  // 3. Register request/reply handlers
  registerHandlers(sql);

  // 4. Set up PG LISTEN/NOTIFY bridging to NATS
  await pgBridge.startListening(nc, ORG_ID);
  console.log('[genie-app] PG LISTEN/NOTIFY active (9 channels)');

  // 5. Wire PTY events to NATS publish (session-scoped subjects)
  pty.onPtyData((sessionId, data) => {
    if (!nc) return;
    nc.publish(GENIE_SUBJECTS.pty.data(ORG_ID, sessionId), sc.encode(JSON.stringify({ data })));
  });

  pty.onPtyExit((sessionId, code) => {
    if (!nc) return;
    nc.publish(GENIE_SUBJECTS.pty.data(ORG_ID, sessionId), sc.encode(JSON.stringify({ code, type: 'exit' })));
  });

  console.log('[genie-app] Backend ready');
}

// ============================================================================
// Request/Reply Handlers
// ============================================================================

// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type
function registerHandlers(sql: any): void {
  if (!nc) return;
  const sub = GENIE_SUBJECTS;

  // ---- Dashboard ----

  reply(sub.dashboard.stats(ORG_ID), async () => {
    const [agentRows, taskRows, teamRows, costRows, snapshot] = await Promise.all([
      sql`
        SELECT
          COUNT(*) FILTER (WHERE a.state IN ('working', 'idle', 'permission', 'question')) AS online,
          COUNT(*) FILTER (WHERE a.state = 'error') AS errored,
          COUNT(*) AS total
        FROM agents a
      `,
      sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'in_progress') AS active,
          COUNT(*) FILTER (WHERE status IN ('ready', 'blocked')) AS backlog,
          COUNT(*) FILTER (WHERE status = 'done') AS done,
          COUNT(*) AS total
        FROM tasks
      `,
      sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'in_progress') AS active,
          COUNT(*) AS total
        FROM teams
      `,
      sql`
        SELECT COALESCE(SUM((details->>'cost_usd')::numeric), 0) AS total_cost
        FROM audit_events
        WHERE event_type = 'claude_code.cost.usage'
      `,
      sql`SELECT * FROM machine_snapshots ORDER BY created_at DESC LIMIT 1`,
    ]);

    return {
      agents: {
        online: Number(agentRows[0]?.online ?? 0),
        errored: Number(agentRows[0]?.errored ?? 0),
        total: Number(agentRows[0]?.total ?? 0),
      },
      tasks: {
        active: Number(taskRows[0]?.active ?? 0),
        backlog: Number(taskRows[0]?.backlog ?? 0),
        done: Number(taskRows[0]?.done ?? 0),
        total: Number(taskRows[0]?.total ?? 0),
      },
      teams: {
        active: Number(teamRows[0]?.active ?? 0),
        total: Number(teamRows[0]?.total ?? 0),
      },
      cost_usd: Number(costRows[0]?.total_cost ?? 0),
      snapshot: snapshot[0] ?? null,
    };
  });

  // ---- Agents ----

  reply(sub.agents.list(ORG_ID), async () => {
    return sql`
      SELECT a.id, a.custom_name, a.role, a.team, a.title, a.state,
             a.reports_to, a.current_executor_id, a.started_at
      FROM agents a
      ORDER BY a.team, a.custom_name
    `;
  });

  reply(sub.agents.show(ORG_ID), async (params: { agent_id: string }) => {
    const agents = await sql`
      SELECT id, custom_name, role, team, title, state,
             reports_to, current_executor_id, started_at
      FROM agents WHERE id = ${params.agent_id}
    `;
    if (agents.length === 0) return { error: 'not_found' };

    const agent = agents[0];
    const [executor, sessions, events] = await Promise.all([
      agent.current_executor_id
        ? sql`SELECT * FROM executors WHERE id = ${agent.current_executor_id}`
        : Promise.resolve([]),
      sql`
        SELECT s.id, s.status, s.total_turns, s.started_at, s.ended_at
        FROM sessions s
        LEFT JOIN executors e ON s.executor_id = e.id
        WHERE e.agent_id = ${params.agent_id}
        ORDER BY s.started_at DESC LIMIT 20
      `,
      sql`
        SELECT id, kind, source, text, data, created_at
        FROM genie_runtime_events
        WHERE agent = ${agent.custom_name ?? params.agent_id}
        ORDER BY id DESC LIMIT 50
      `,
    ]);

    return {
      agent,
      executor: executor[0] ?? null,
      sessions,
      recent_events: events,
    };
  });

  // ---- Sessions ----

  reply(sub.sessions.list(ORG_ID), async (params: { limit?: number; offset?: number }) => {
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;
    return sql`
      SELECT s.id, s.status, s.total_turns, s.started_at, s.ended_at,
             a.custom_name AS agent_name,
             COALESCE(
               (SELECT SUM((ae.details->>'cost_usd')::numeric)
                FROM audit_events ae
                WHERE ae.entity_id = e.id
                  AND ae.event_type = 'claude_code.cost.usage'), 0
             ) AS cost_usd
      FROM sessions s
      LEFT JOIN executors e ON s.executor_id = e.id
      LEFT JOIN agents a ON e.agent_id = a.id
      ORDER BY s.started_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  });

  reply(sub.sessions.content(ORG_ID), async (params: { session_id: string; limit?: number; offset?: number }) => {
    const limit = params.limit ?? 200;
    const offset = params.offset ?? 0;
    return sql`
      SELECT turn_index, role, content, tool_name, created_at
      FROM session_content
      WHERE session_id = ${params.session_id}
      ORDER BY turn_index
      LIMIT ${limit} OFFSET ${offset}
    `;
  });

  reply(sub.sessions.search(ORG_ID), async (params: { query: string; limit?: number }) => {
    const limit = params.limit ?? 50;
    return sql`
      SELECT sc.session_id, sc.turn_index, sc.role, sc.content, sc.tool_name,
             sc.created_at, s.status AS session_status,
             a.custom_name AS agent_name
      FROM session_content sc
      JOIN sessions s ON sc.session_id = s.id
      LEFT JOIN executors e ON s.executor_id = e.id
      LEFT JOIN agents a ON e.agent_id = a.id
      WHERE sc.content ILIKE ${`%${params.query}%`}
      ORDER BY sc.created_at DESC
      LIMIT ${limit}
    `;
  });

  // ---- Tasks ----

  reply(sub.tasks.list(ORG_ID), async (params: { board_id?: string }) => {
    if (params.board_id) {
      return sql`
        SELECT t.*, bc.name AS column_name
        FROM tasks t
        LEFT JOIN board_columns bc ON t.column_id = bc.id::text
        WHERE t.board_id = ${params.board_id}
        ORDER BY bc.position, t.seq ASC
      `;
    }
    return sql`
      SELECT * FROM tasks ORDER BY seq ASC LIMIT 500
    `;
  });

  reply(sub.tasks.show(ORG_ID), async (params: { task_id: string }) => {
    const tasks = await sql`SELECT * FROM tasks WHERE id = ${params.task_id}`;
    if (tasks.length === 0) return { error: 'not_found' };
    return tasks[0];
  });

  // ---- Boards ----

  reply(sub.boards.list(ORG_ID), async () => {
    return sql`
      SELECT id, name, project_id, description, columns, created_at
      FROM boards
      ORDER BY created_at DESC
    `;
  });

  reply(sub.boards.show(ORG_ID), async (params: { board_id: string }) => {
    const boards = await sql`SELECT * FROM boards WHERE id = ${params.board_id}`;
    if (boards.length === 0) return { error: 'not_found' };
    const columns = await sql`
      SELECT id, name, label, color, position
      FROM board_columns WHERE board_id = ${params.board_id}
      ORDER BY position ASC
    `;
    const tasks = await sql`
      SELECT * FROM tasks WHERE board_id = ${params.board_id} ORDER BY seq ASC
    `;
    return { board: boards[0], columns, tasks };
  });

  // ---- Costs ----

  reply(sub.costs.summary(ORG_ID), async () => {
    return sql`
      SELECT details->>'model' AS model,
             SUM((details->>'cost_usd')::numeric) AS total_cost,
             COUNT(*) AS usage_count
      FROM audit_events
      WHERE event_type = 'claude_code.cost.usage'
      GROUP BY 1
      ORDER BY total_cost DESC
    `;
  });

  reply(sub.costs.sessions(ORG_ID), async (params: { limit?: number }) => {
    const limit = params.limit ?? 50;
    return sql`
      SELECT ae.entity_id AS executor_id,
             a.custom_name AS agent_name,
             SUM((ae.details->>'cost_usd')::numeric) AS cost_usd,
             COUNT(*) AS events
      FROM audit_events ae
      LEFT JOIN executors e ON ae.entity_id = e.id
      LEFT JOIN agents a ON e.agent_id = a.id
      WHERE ae.event_type = 'claude_code.cost.usage'
      GROUP BY ae.entity_id, a.custom_name
      ORDER BY cost_usd DESC
      LIMIT ${limit}
    `;
  });

  reply(sub.costs.tokens(ORG_ID), async () => {
    return sql`
      SELECT details->>'model' AS model,
             SUM((details->>'input_tokens')::bigint) AS input_tokens,
             SUM((details->>'output_tokens')::bigint) AS output_tokens,
             SUM(COALESCE((details->>'cache_read_tokens')::bigint, 0)) AS cache_read_tokens,
             SUM(COALESCE((details->>'cache_write_tokens')::bigint, 0)) AS cache_write_tokens
      FROM audit_events
      WHERE event_type = 'claude_code.cost.usage'
      GROUP BY 1
      ORDER BY input_tokens DESC
    `;
  });

  reply(sub.costs.efficiency(ORG_ID), async () => {
    return sql`
      SELECT details->>'model' AS model,
             SUM(COALESCE((details->>'cache_read_tokens')::bigint, 0)) AS cache_hits,
             SUM(COALESCE((details->>'input_tokens')::bigint, 0)) AS total_input,
             CASE WHEN SUM(COALESCE((details->>'input_tokens')::bigint, 0)) > 0
               THEN ROUND(
                 SUM(COALESCE((details->>'cache_read_tokens')::bigint, 0))::numeric /
                 SUM(COALESCE((details->>'input_tokens')::bigint, 0))::numeric * 100, 2
               )
               ELSE 0
             END AS cache_hit_pct
      FROM audit_events
      WHERE event_type = 'claude_code.cost.usage'
      GROUP BY 1
      ORDER BY cache_hit_pct DESC
    `;
  });

  // ---- Schedules ----

  reply(sub.schedules.list(ORG_ID), async () => {
    try {
      return await sql`
        SELECT id, name, cron_expression, timezone, command, status,
               metadata, created_at, updated_at
        FROM schedules
        ORDER BY created_at DESC
      `;
    } catch {
      // Table may not exist in this deployment — return empty list gracefully
      return [];
    }
  });

  reply(sub.schedules.history(ORG_ID), async (params: { limit?: number; schedule_id?: string }) => {
    const limit = params.limit ?? 100;
    try {
      if (params.schedule_id) {
        return await sql`
          SELECT sr.id, sr.schedule_id,
                 s.name AS schedule_name,
                 sr.trigger, sr.worker, sr.status,
                 sr.exit_code, sr.duration_ms,
                 sr.output, sr.error, sr.trace_id,
                 sr.started_at, sr.ended_at
          FROM schedule_runs sr
          LEFT JOIN schedules s ON sr.schedule_id = s.id
          WHERE sr.schedule_id = ${params.schedule_id}
          ORDER BY sr.started_at DESC
          LIMIT ${limit}
        `;
      }
      return await sql`
        SELECT sr.id, sr.schedule_id,
               s.name AS schedule_name,
               sr.trigger, sr.worker, sr.status,
               sr.exit_code, sr.duration_ms,
               sr.output, sr.error, sr.trace_id,
               sr.started_at, sr.ended_at
        FROM schedule_runs sr
        LEFT JOIN schedules s ON sr.schedule_id = s.id
        ORDER BY sr.started_at DESC
        LIMIT ${limit}
      `;
    } catch {
      // Tables may not exist — return empty list gracefully
      return [];
    }
  });

  // ---- System ----

  reply(sub.system.health(ORG_ID), async () => {
    const [tableSizes, agentCount, _pgUp] = await Promise.all([
      sql`
        SELECT relname AS table_name,
               pg_total_relation_size(c.oid) AS total_bytes,
               pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY pg_total_relation_size(c.oid) DESC
        LIMIT 20
      `,
      sql`SELECT COUNT(*)::int AS cnt FROM agents`,
      sql`SELECT 1 AS ok`,
    ]);

    return {
      pg: { status: 'ok', agent_count: agentCount[0]?.cnt ?? 0 },
      tables: tableSizes,
      nats: { status: nc ? 'connected' : 'disconnected' },
    };
  });

  reply(sub.system.snapshots(ORG_ID), async (params: { limit?: number }) => {
    const limit = params.limit ?? 60;
    return sql`
      SELECT * FROM machine_snapshots
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  });

  reply(sub.system.tables(ORG_ID), async () => {
    return sql`
      SELECT c.relname AS table_name,
             c.reltuples::bigint AS row_count,
             pg_relation_size(c.oid) AS data_bytes,
             pg_indexes_size(c.oid) AS index_bytes,
             pg_total_relation_size(c.oid) AS total_bytes,
             pg_size_pretty(pg_relation_size(c.oid)) AS data_size,
             pg_size_pretty(pg_indexes_size(c.oid)) AS index_size,
             pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY pg_total_relation_size(c.oid) DESC
      LIMIT 50
    `;
  });

  reply(sub.system.channels(ORG_ID), async () => {
    return sql`
      SELECT DISTINCT
        pt.tgargs::text AS channel,
        c.relname AS source_table,
        pt.tgname AS trigger_name
      FROM pg_trigger pt
      JOIN pg_class c ON pt.tgrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = 'public'
        AND pt.tgisinternal = false
        AND pt.tgfoid IN (
          SELECT p.oid FROM pg_proc p
          WHERE p.proname IN ('notify_trigger', 'pg_notify')
        )
      ORDER BY source_table, trigger_name
    `;
  });

  // ---- Settings ----

  reply(sub.settings.get(ORG_ID), async () => {
    const genieHome = process.env.GENIE_HOME ?? join(homedir(), '.genie');
    const configPath = join(genieHome, 'config.json');
    const wsConfigPath = join(process.cwd(), '.genie', 'workspace.json');

    let config = {};
    let wsConfig = {};
    try {
      if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      /* empty */
    }
    try {
      if (existsSync(wsConfigPath)) wsConfig = JSON.parse(readFileSync(wsConfigPath, 'utf-8'));
    } catch {
      /* empty */
    }

    return { config, workspace: wsConfig };
  });

  reply(sub.settings.set(ORG_ID), async (params: { key: string; value: unknown }) => {
    const genieHome = process.env.GENIE_HOME ?? join(homedir(), '.genie');
    const configPath = join(genieHome, 'config.json');

    let config: Record<string, unknown> = {};
    try {
      if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      /* empty */
    }

    config[params.key] = params.value;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return { ok: true };
  });

  reply(sub.settings.templates(ORG_ID), async () => {
    return sql`SELECT * FROM agent_templates ORDER BY last_spawned_at DESC`;
  });

  reply(sub.settings.skills(ORG_ID), async () => {
    // Scan the bundled skills/ directory for SKILL.md files
    const genieHome = process.env.GENIE_HOME ?? join(homedir(), '.genie');
    // Try repo-relative path first (dev), then genie home
    const candidateDirs = [
      join(process.cwd(), 'skills'),
      join(genieHome, '..', 'skills'), // fallback relative
    ];
    let skillsDir: string | null = null;
    for (const d of candidateDirs) {
      if (existsSync(d)) {
        skillsDir = d;
        break;
      }
    }
    if (!skillsDir) {
      // Fall back to DB-sourced skill names
      const rows = await sql`SELECT DISTINCT skill FROM agents WHERE skill IS NOT NULL ORDER BY skill`;
      return rows.map((r: { skill: string }) => ({ name: r.skill, description: '', path: '' }));
    }
    try {
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      const skills = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMdPath = join(skillsDir, entry.name, 'SKILL.md');
        if (!existsSync(skillMdPath)) continue;
        const content = readFileSync(skillMdPath, 'utf-8');
        // Parse YAML frontmatter description or fall back to first non-empty line
        let description = '';
        const descMatch = content.match(/^description:\s*["']?(.+?)["']?\s*$/m);
        if (descMatch) {
          description = descMatch[1].trim();
        } else {
          const lines = content.split('\n').filter((l) => l.trim() && !l.startsWith('---') && !l.startsWith('#'));
          description = lines[0]?.trim() ?? '';
        }
        let displayName = entry.name;
        const nameMatch = content.match(/^name:\s*(.+?)\s*$/m);
        if (nameMatch) displayName = nameMatch[1].trim();
        skills.push({ name: displayName, slug: entry.name, description, path: skillMdPath });
      }
      return skills.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  });

  reply(sub.settings.rules(ORG_ID), async () => {
    const genieHome = process.env.GENIE_HOME ?? join(homedir(), '.genie');
    // Check both ~/.genie/rules/ and ~/.claude/rules/
    const ruleDirs = [join(genieHome, 'rules'), join(homedir(), '.claude', 'rules')];
    const allRules: { name: string; path: string; content: string; source: string }[] = [];
    for (const rulesDir of ruleDirs) {
      if (!existsSync(rulesDir)) continue;
      try {
        const files = readdirSync(rulesDir).filter((f) => f.endsWith('.md'));
        for (const f of files) {
          const filePath = join(rulesDir, f);
          allRules.push({
            name: f.replace('.md', ''),
            path: filePath,
            content: readFileSync(filePath, 'utf-8'),
            source: rulesDir.includes('.claude') ? 'claude' : 'genie',
          });
        }
      } catch {
        /* skip unreadable dir */
      }
    }
    return allRules;
  });

  reply(
    sub.settings.templateSave(ORG_ID),
    async (params: {
      id?: string;
      provider?: string;
      team?: string;
      role?: string;
      skill?: string;
      cwd?: string;
      extraArgs?: string[];
      nativeTeamEnabled?: boolean;
      autoResume?: boolean;
      maxResumeAttempts?: number;
      paneColor?: string;
    }) => {
      if (!params.id) return { error: 'id is required' };
      await sql`
      INSERT INTO agent_templates (
        id, provider, team, role, skill, cwd,
        extra_args, native_team_enabled, last_spawned_at
      ) VALUES (
        ${params.id},
        ${params.provider ?? 'claude'},
        ${params.team ?? ''},
        ${params.role ?? null},
        ${params.skill ?? null},
        ${params.cwd ?? ''},
        ${JSON.stringify(params.extraArgs ?? [])},
        ${params.nativeTeamEnabled ?? false},
        ${new Date().toISOString()}
      )
      ON CONFLICT (id) DO UPDATE SET
        provider = EXCLUDED.provider,
        team = EXCLUDED.team,
        role = EXCLUDED.role,
        skill = EXCLUDED.skill,
        cwd = EXCLUDED.cwd,
        extra_args = EXCLUDED.extra_args,
        native_team_enabled = EXCLUDED.native_team_enabled
    `;
      return { ok: true };
    },
  );

  reply(sub.settings.testPg(ORG_ID), async () => {
    try {
      await sql`SELECT 1 AS ok`;
      return { ok: true, message: 'Connection successful' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  // ---- PTY ----

  reply(sub.pty.create(ORG_ID), async (params: { agentName?: string; cwd?: string; cols?: number; rows?: number }) => {
    if (params.agentName) {
      const session = await pty.spawnForAgent(params.agentName, {
        cwd: params.cwd,
        cols: params.cols,
        rows: params.rows,
      });
      return { sessionId: session.id, agentId: session.agentId, executorId: session.executorId };
    }
    const session = pty.spawnBash(params.cwd);
    return { sessionId: session.id, agentId: null, executorId: null };
  });

  // PTY input/resize/kill use session-scoped subjects with NATS wildcard subscription.
  // Subject pattern: khal.{orgId}.genie.pty.{sessionId}.{action}
  subscribePtyWildcard(`khal.${ORG_ID}.genie.pty.*.input`, async (sessionId, params: { data: string }) => {
    pty.writeTerminal(sessionId, params.data);
  });

  subscribePtyWildcard(
    `khal.${ORG_ID}.genie.pty.*.resize`,
    async (sessionId, params: { cols: number; rows: number }) => {
      pty.resizeTerminal(sessionId, params.cols, params.rows);
    },
  );

  subscribePtyWildcard(`khal.${ORG_ID}.genie.pty.*.kill`, async (sessionId) => {
    await pty.killTerminal(sessionId);
  });

  // ---- Filesystem ----

  reply(sub.fs.list(ORG_ID), async (params: { path: string }) => {
    const targetPath = resolve(params.path);
    if (!existsSync(targetPath)) return { error: 'not_found' };
    try {
      const entries = readdirSync(targetPath, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        path: join(targetPath, e.name),
      }));
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  reply(sub.fs.read(ORG_ID), async (params: { path: string }) => {
    const targetPath = resolve(params.path);
    if (!existsSync(targetPath)) return { error: 'not_found' };
    try {
      return { content: readFileSync(targetPath, 'utf-8') };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  reply(sub.fs.write(ORG_ID), async (params: { path: string; content: string }) => {
    const targetPath = resolve(params.path);
    try {
      writeFileSync(targetPath, params.content);
      return { ok: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  console.log('[genie-app] All request/reply handlers registered');
}

// ============================================================================
// NATS Reply Helper
// ============================================================================

/** Decode params from a NATS message payload (JSON or empty). */
function decodeParams(data: Uint8Array): Record<string, unknown> {
  if (data.length === 0) return {};
  try {
    return JSON.parse(sc.decode(data));
  } catch {
    return {};
  }
}

/**
 * Subscribe to a NATS wildcard subject for session-scoped PTY operations.
 * Extracts the sessionId from the subject path (token index 4: khal.org.genie.pty.SESSION.action).
 */
function subscribePtyWildcard(
  subject: string,
  // biome-ignore lint/suspicious/noExplicitAny: handler params vary per subject
  handler: (sessionId: string, params: any) => Promise<void>,
): void {
  if (!nc) return;

  const subscription = nc.subscribe(subject);

  void (async () => {
    for await (const msg of subscription) {
      try {
        const params = decodeParams(msg.data);
        // Extract sessionId from subject: khal.<orgId>.genie.pty.<sessionId>.<action>
        const parts = msg.subject.split('.');
        const sessionId = parts[4]; // index 4 is the sessionId token
        if (sessionId) {
          await handler(sessionId, params);
        }
      } catch (err) {
        console.error(
          `[genie-app] PTY wildcard error on ${msg.subject}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  })();
}

/**
 * Subscribe to a NATS subject and handle request/reply.
 * Decodes request params from JSON, calls handler, encodes response as JSON.
 */
// biome-ignore lint/suspicious/noExplicitAny: handler params vary per subject
function reply(subject: string, handler: (params: any) => Promise<unknown>): void {
  if (!nc) return;

  const subscription = nc.subscribe(subject);

  void processSubscription(subscription, subject, handler);
}

/** Process messages from a NATS subscription, dispatching to the handler. */
async function processSubscription(
  subscription: ReturnType<NatsConnection['subscribe']>,
  subject: string,
  // biome-ignore lint/suspicious/noExplicitAny: handler params vary per subject
  handler: (params: any) => Promise<unknown>,
): Promise<void> {
  for await (const msg of subscription) {
    try {
      const params = decodeParams(msg.data);
      const result = await handler(params);
      if (msg.reply) {
        msg.respond(sc.encode(JSON.stringify(result)));
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[genie-app] Handler error on ${subject}:`, errorMsg);
      if (msg.reply) {
        msg.respond(sc.encode(JSON.stringify({ error: errorMsg })));
      }
    }
  }
}

// ============================================================================
// Shutdown
// ============================================================================

async function shutdown(): Promise<void> {
  if (shutdownRequested) return;
  shutdownRequested = true;

  console.log('[genie-app] Shutting down...');

  // Kill all PTY sessions
  await pty.killAll();

  // Stop PG listeners
  await pgBridge.stopListening();

  // Drain and close NATS
  if (nc) {
    try {
      await nc.drain();
    } catch {
      // Connection may already be closed
    }
    nc = null;
  }

  console.log('[genie-app] Shutdown complete');
  process.exit(0);
}

// Signal handlers
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

// ============================================================================
// Boot
// ============================================================================

void start().catch((err) => {
  console.error('[genie-app] Fatal error:', err);
  process.exit(1);
});
