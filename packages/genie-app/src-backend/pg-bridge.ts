/**
 * PG Bridge — Query functions + LISTEN/NOTIFY bridged to NATS pub/sub.
 *
 * Reuses getConnection() from the CLI's db module.
 * Bridges all 9 PG NOTIFY channels to corresponding NATS event subjects:
 *
 *   PG Channel                  NATS Subject
 *   ─────────────────────────   ──────────────────────────────────────
 *   genie_agent_state        →  events.agentState
 *   genie_executor_state     →  events.executorState
 *   genie_task_stage         →  events.taskStage
 *   genie_runtime_event      →  events.runtime
 *   genie_audit_event        →  events.audit
 *   genie_message            →  events.message
 *   genie_mailbox_delivery   →  events.mailbox
 *   genie_task_dep           →  events.taskDep
 *   genie_trigger_due        →  events.trigger
 */

import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';
import { getConnection } from '../../../src/lib/db.js';
import { GENIE_SUBJECTS } from '../lib/subjects.js';

// ============================================================================
// Types
// ============================================================================

export type BridgeEventType =
  | 'agent-state-changed'
  | 'executor-state-changed'
  | 'task-stage-changed'
  | 'runtime-event'
  | 'audit-event'
  | 'message'
  | 'mailbox-delivery'
  | 'task-dep-changed'
  | 'trigger-due';

export interface BridgeEvent {
  type: BridgeEventType;
  payload: Record<string, unknown>;
}

export type BridgeEventHandler = (event: BridgeEvent) => void;

export interface AgentRow {
  id: string;
  custom_name: string | null;
  role: string | null;
  team: string | null;
  title: string | null;
  state: string;
  reports_to: string | null;
  current_executor_id: string | null;
  started_at: string;
}

export interface ExecutorRow {
  id: string;
  agent_id: string;
  provider: string;
  transport: string;
  state: string;
  pid: number | null;
  worktree: string | null;
  repo_path: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface TaskRow {
  id: string;
  seq: number;
  title: string;
  description: string | null;
  status: string;
  stage: string;
  priority: string;
  project_id: string | null;
  board_id: string | null;
  column_id: string | null;
  group_name: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface TeamRow {
  name: string;
  repo: string;
  base_branch: string;
  worktree_path: string;
  leader: string | null;
  members: string[];
  status: string;
  created_at: string;
  wish_slug: string | null;
}

export interface RuntimeEventRow {
  id: number;
  repo_path: string;
  kind: string;
  source: string;
  agent: string;
  team: string | null;
  direction: string | null;
  peer: string | null;
  text: string;
  data: Record<string, unknown> | null;
  thread_id: string | null;
  created_at: string;
}

export interface BoardColumnRow {
  id: string;
  name: string;
  label: string;
  color: string;
  position: number;
}

// ============================================================================
// Event Emitter (local fallback for non-NATS consumers)
// ============================================================================

const listeners: Set<BridgeEventHandler> = new Set();

export function onBridgeEvent(handler: BridgeEventHandler): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

function emit(event: BridgeEvent): void {
  for (const handler of listeners) {
    handler(event);
  }
}

// ============================================================================
// Query Functions
// ============================================================================

export async function listAgents(): Promise<AgentRow[]> {
  const sql = await getConnection();
  return sql<AgentRow[]>`
    SELECT a.id, a.custom_name, a.role, a.team, a.title, a.state,
           a.reports_to, a.current_executor_id, a.started_at
    FROM agents a
    ORDER BY a.started_at DESC
  `;
}

export async function showAgent(id: string): Promise<{
  agent: AgentRow;
  executor: ExecutorRow | null;
} | null> {
  const sql = await getConnection();
  const agents = await sql<AgentRow[]>`
    SELECT id, custom_name, role, team, title, state,
           reports_to, current_executor_id, started_at
    FROM agents WHERE id = ${id}
  `;
  if (agents.length === 0) return null;

  const agent = agents[0];
  let executor: ExecutorRow | null = null;

  if (agent.current_executor_id) {
    const executors = await sql<ExecutorRow[]>`
      SELECT id, agent_id, provider, transport, state, pid,
             worktree, repo_path, started_at, ended_at
      FROM executors WHERE id = ${agent.current_executor_id}
    `;
    executor = executors[0] ?? null;
  }

  return { agent, executor };
}

export async function listTasks(boardId?: string): Promise<TaskRow[]> {
  const sql = await getConnection();
  if (boardId) {
    return sql<TaskRow[]>`
      SELECT id, seq, title, description, status, stage, priority,
             project_id, board_id, column_id, group_name, metadata,
             created_at, updated_at
      FROM tasks WHERE board_id = ${boardId}
      ORDER BY seq ASC
    `;
  }
  return sql<TaskRow[]>`
    SELECT id, seq, title, description, status, stage, priority,
           project_id, board_id, column_id, group_name, metadata,
           created_at, updated_at
    FROM tasks
    ORDER BY seq ASC
    LIMIT 500
  `;
}

export async function kanbanBoard(boardId: string): Promise<{
  columns: BoardColumnRow[];
  tasks: TaskRow[];
}> {
  const sql = await getConnection();
  const columns = await sql<BoardColumnRow[]>`
    SELECT id, name, label, color, position
    FROM board_columns WHERE board_id = ${boardId}
    ORDER BY position ASC
  `;
  const tasks = await sql<TaskRow[]>`
    SELECT id, seq, title, description, status, stage, priority,
           project_id, board_id, column_id, group_name, metadata,
           created_at, updated_at
    FROM tasks WHERE board_id = ${boardId}
    ORDER BY seq ASC
  `;
  return { columns, tasks };
}

export interface BoardRow {
  id: string;
  name: string;
  project_id: string | null;
  description: string | null;
  columns: BoardColumnRow[];
  created_at: string;
}

export async function listBoards(): Promise<BoardRow[]> {
  const sql = await getConnection();
  return sql<BoardRow[]>`
    SELECT id, name, project_id, description, columns, created_at
    FROM boards
    ORDER BY created_at DESC
  `;
}

export async function moveTask(taskId: string, columnName: string): Promise<boolean> {
  const sql = await getConnection();
  const result = await sql`
    UPDATE tasks
    SET stage = ${columnName},
        column_id = (
          SELECT col->>'id'
          FROM boards b, jsonb_array_elements(b.columns) AS col
          WHERE b.id = tasks.board_id AND col->>'name' = ${columnName}
        ),
        updated_at = now()
    WHERE id = ${taskId}
  `;
  return result.count > 0;
}

export async function listTeams(): Promise<TeamRow[]> {
  const sql = await getConnection();
  return sql<TeamRow[]>`
    SELECT name, repo, base_branch, worktree_path, leader,
           members, status, created_at, wish_slug
    FROM teams
    ORDER BY created_at DESC
  `;
}

export interface EventFilter {
  afterId?: number;
  team?: string;
  kinds?: string[];
  limit?: number;
}

export async function streamEvents(filter: EventFilter = {}): Promise<RuntimeEventRow[]> {
  const sql = await getConnection();
  const limit = filter.limit ?? 100;

  if (filter.afterId != null && filter.team) {
    return sql<RuntimeEventRow[]>`
      SELECT id, repo_path, kind, source, agent, team, direction, peer, text, data, thread_id, created_at
      FROM genie_runtime_events
      WHERE id > ${filter.afterId} AND team = ${filter.team}
      ORDER BY id ASC LIMIT ${limit}
    `;
  }
  if (filter.afterId != null) {
    return sql<RuntimeEventRow[]>`
      SELECT id, repo_path, kind, source, agent, team, direction, peer, text, data, thread_id, created_at
      FROM genie_runtime_events
      WHERE id > ${filter.afterId}
      ORDER BY id ASC LIMIT ${limit}
    `;
  }
  if (filter.team) {
    return sql<RuntimeEventRow[]>`
      SELECT id, repo_path, kind, source, agent, team, direction, peer, text, data, thread_id, created_at
      FROM genie_runtime_events
      WHERE team = ${filter.team}
      ORDER BY id DESC LIMIT ${limit}
    `;
  }
  return sql<RuntimeEventRow[]>`
    SELECT id, repo_path, kind, source, agent, team, direction, peer, text, data, thread_id, created_at
    FROM genie_runtime_events
    ORDER BY id DESC LIMIT ${limit}
  `;
}

// ============================================================================
// Dashboard Stats
// ============================================================================

export interface DashboardStats {
  agents: { online: number; total: number };
  tasks: { active: number; backlog: number; done: number; total: number };
  teams: { active: number; total: number };
}

export async function dashboardStats(): Promise<DashboardStats> {
  const sql = await getConnection();

  const [agentRows, taskRows, teamRows] = await Promise.all([
    sql<{ online: string; total: string }[]>`
      SELECT
        COUNT(*) FILTER (WHERE e.state IN ('running', 'idle', 'working', 'permission', 'question')) AS online,
        COUNT(DISTINCT a.id) AS total
      FROM agents a
      LEFT JOIN executors e ON e.id = a.current_executor_id
    `,
    sql<{ active: string; backlog: string; done: string; total: string }[]>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'in_progress') AS active,
        COUNT(*) FILTER (WHERE status IN ('ready', 'blocked')) AS backlog,
        COUNT(*) FILTER (WHERE status = 'done') AS done,
        COUNT(*) AS total
      FROM tasks
    `,
    sql<{ active: string; total: string }[]>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'in_progress') AS active,
        COUNT(*) AS total
      FROM teams
    `,
  ]);

  return {
    agents: { online: Number(agentRows[0].online), total: Number(agentRows[0].total) },
    tasks: {
      active: Number(taskRows[0].active),
      backlog: Number(taskRows[0].backlog),
      done: Number(taskRows[0].done),
      total: Number(taskRows[0].total),
    },
    teams: { active: Number(teamRows[0].active), total: Number(teamRows[0].total) },
  };
}

// ============================================================================
// PG LISTEN/NOTIFY → NATS Bridge
// ============================================================================

/** NATS connection and orgId stored when startListening is called with NATS params. */
let natsConn: NatsConnection | null = null;
let natsOrgId = 'default';
const sc = StringCodec();

/**
 * Mapping from PG NOTIFY channel to bridge event type and NATS subject builder.
 */
const CHANNEL_MAP: Array<{
  channel: string;
  eventType: BridgeEventType;
  natsSubject: (orgId: string) => string;
}> = [
  { channel: 'genie_agent_state', eventType: 'agent-state-changed', natsSubject: GENIE_SUBJECTS.events.agentState },
  {
    channel: 'genie_executor_state',
    eventType: 'executor-state-changed',
    natsSubject: GENIE_SUBJECTS.events.executorState,
  },
  { channel: 'genie_task_stage', eventType: 'task-stage-changed', natsSubject: GENIE_SUBJECTS.events.taskStage },
  { channel: 'genie_runtime_event', eventType: 'runtime-event', natsSubject: GENIE_SUBJECTS.events.runtime },
  { channel: 'genie_audit_event', eventType: 'audit-event', natsSubject: GENIE_SUBJECTS.events.audit },
  { channel: 'genie_message', eventType: 'message', natsSubject: GENIE_SUBJECTS.events.message },
  { channel: 'genie_mailbox_delivery', eventType: 'mailbox-delivery', natsSubject: GENIE_SUBJECTS.events.mailbox },
  { channel: 'genie_task_dep', eventType: 'task-dep-changed', natsSubject: GENIE_SUBJECTS.events.taskDep },
  { channel: 'genie_trigger_due', eventType: 'trigger-due', natsSubject: GENIE_SUBJECTS.events.trigger },
];

let listenersActive = false;
let stopFns: Array<() => Promise<void>> = [];

/**
 * Start listening on all 9 PG NOTIFY channels.
 * When called with a NatsConnection, bridges events to NATS pub/sub.
 * When called without NATS, emits via the local BridgeEvent emitter.
 */
export async function startListening(nats?: NatsConnection, orgId?: string): Promise<void> {
  if (listenersActive) return;
  listenersActive = true;

  if (nats) {
    natsConn = nats;
    natsOrgId = orgId ?? 'default';
  }

  const sql = await getConnection();

  for (const mapping of CHANNEL_MAP) {
    const listener = await sql.listen(mapping.channel, (payload: string) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = { raw: payload };
      }

      // Emit locally
      emit({ type: mapping.eventType, payload: parsed });

      // Publish to NATS if connected
      if (natsConn) {
        const subject = mapping.natsSubject(natsOrgId);
        natsConn.publish(subject, sc.encode(JSON.stringify(parsed)));
      }
    });

    stopFns.push(() => listener.unlisten());
  }
}

export async function stopListening(): Promise<void> {
  listenersActive = false;
  natsConn = null;
  await Promise.allSettled(stopFns.map((fn) => fn()));
  stopFns = [];
}
