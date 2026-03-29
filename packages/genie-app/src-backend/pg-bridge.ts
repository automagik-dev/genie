/**
 * PG Bridge — Query functions + LISTEN/NOTIFY for real-time updates.
 *
 * Reuses getConnection() from the CLI's db module.
 * Emits typed events for executor state, task stage, and runtime events.
 */

import { getConnection } from '../../../src/lib/db.js';

// ============================================================================
// Types
// ============================================================================

export type BridgeEventType = 'executor-state-changed' | 'task-stage-changed' | 'runtime-event';

export interface BridgeEvent {
  type: BridgeEventType;
  payload: Record<string, unknown>;
}

export type BridgeEventHandler = (event: BridgeEvent) => void;

interface AgentRow {
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

interface ExecutorRow {
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

interface TaskRow {
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

interface TeamRow {
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

interface RuntimeEventRow {
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

interface BoardColumnRow {
  id: string;
  name: string;
  label: string;
  color: string;
  position: number;
}

// ============================================================================
// Event Emitter
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
// PG LISTEN/NOTIFY
// ============================================================================

let listenersActive = false;
let stopFns: Array<() => Promise<void>> = [];

export async function startListening(): Promise<void> {
  if (listenersActive) return;
  listenersActive = true;

  const sql = await getConnection();

  const executorListener = await sql.listen('genie_executor_state', (payload: string) => {
    try {
      emit({ type: 'executor-state-changed', payload: JSON.parse(payload) });
    } catch {
      emit({ type: 'executor-state-changed', payload: { raw: payload } });
    }
  });

  const taskListener = await sql.listen('genie_task_stage', (payload: string) => {
    try {
      emit({ type: 'task-stage-changed', payload: JSON.parse(payload) });
    } catch {
      emit({ type: 'task-stage-changed', payload: { raw: payload } });
    }
  });

  const eventListener = await sql.listen('genie_runtime_event', (payload: string) => {
    try {
      emit({ type: 'runtime-event', payload: JSON.parse(payload) });
    } catch {
      emit({ type: 'runtime-event', payload: { raw: payload } });
    }
  });

  stopFns = [() => executorListener.unlisten(), () => taskListener.unlisten(), () => eventListener.unlisten()];
}

export async function stopListening(): Promise<void> {
  listenersActive = false;
  await Promise.allSettled(stopFns.map((fn) => fn()));
  stopFns = [];
}
