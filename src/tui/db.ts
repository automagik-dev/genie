/** PG data layer + tmux tree loader — framework-agnostic, no UI imports */

import { execSync } from 'node:child_process';
import type { ExecutorState, TransportType } from '../lib/executor-types.js';
import type { ProviderName } from '../lib/provider-adapters.js';
import type {
  AgentProject,
  Board,
  BoardColumn,
  Org,
  Project,
  Task,
  TuiAssignment,
  TuiData,
  TuiExecutor,
} from './types.js';

/** Load all TUI data in parallel from PG */
export async function loadAll(): Promise<TuiData> {
  const { getConnection } = await import('../lib/db.js');
  const sql = await getConnection();

  const [orgRows, projRows, boardRows, taskRows, apRows] = await Promise.all([
    sql`SELECT id, name, slug, description, leader_agent FROM organizations ORDER BY name`,
    sql`SELECT id, name, description, org_id, leader_agent, tmux_session, repo_path FROM projects ORDER BY name`,
    sql`SELECT id, name, project_id, description, columns FROM boards ORDER BY name`,
    sql`SELECT id, seq, title, status, stage, priority, project_id, board_id, column_id, description
        FROM tasks WHERE status NOT IN ('cancelled')
        ORDER BY priority DESC, seq ASC`,
    sql`SELECT agent_name, project_id, role FROM agent_projects`,
  ]);

  return {
    orgs: orgRows.map(mapOrg),
    projects: projRows.map(mapProject),
    boards: boardRows.map(mapBoard),
    tasks: taskRows.map(mapTask),
    agentProjects: apRows.map(mapAgentProject),
  };
}

/** Subscribe to runtime events via LISTEN/NOTIFY */
export async function subscribe(
  onEvent: (kind: string, data: Record<string, unknown>) => void,
): Promise<{ stop: () => Promise<void> }> {
  const { followRuntimeEvents } = await import('../lib/runtime-events.js');

  const handle = await followRuntimeEvents({}, (event) => {
    onEvent(event.kind, {
      id: event.id,
      agent: event.agent,
      team: event.team,
      text: event.text,
      subject: event.subject,
      data: event.data,
    });
  });

  return { stop: () => handle.stop() };
}

/** Load active executors joined with agent identity. */
export async function loadExecutors(): Promise<TuiExecutor[]> {
  const { getConnection } = await import('../lib/db.js');
  const sql = await getConnection();

  const rows = await sql`
    SELECT e.id, e.agent_id, e.provider, e.transport, e.pid, e.tmux_session,
           e.tmux_pane_id, e.state, e.metadata, e.started_at,
           a.custom_name AS agent_name, a.role, a.team
    FROM executors e
    LEFT JOIN agents a ON e.agent_id = a.id
    WHERE e.state NOT IN ('terminated', 'done')
    ORDER BY e.started_at DESC
  `;

  return rows.map(mapExecutor);
}

/** Load active assignments for given executor IDs, joined with task titles. */
export async function loadAssignments(executorIds: string[]): Promise<TuiAssignment[]> {
  if (executorIds.length === 0) return [];

  const { getConnection } = await import('../lib/db.js');
  const sql = await getConnection();

  const rows = await sql`
    SELECT a.id, a.executor_id, a.task_id, a.wish_slug, a.group_number, a.started_at,
           t.title AS task_title
    FROM assignments a
    LEFT JOIN tasks t ON a.task_id = t.id
    WHERE a.executor_id = ANY(${executorIds})
      AND a.ended_at IS NULL
    ORDER BY a.started_at DESC
  `;

  return rows.map(mapAssignment);
}

// ── Mappers ──

function mapOrg(row: Record<string, unknown>): Org {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    description: row.description ? String(row.description) : null,
    leaderAgent: row.leader_agent ? String(row.leader_agent) : null,
  };
}

function mapProject(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    orgId: row.org_id ? String(row.org_id) : null,
    leaderAgent: row.leader_agent ? String(row.leader_agent) : null,
    tmuxSession: row.tmux_session ? String(row.tmux_session) : null,
    repoPath: row.repo_path ? String(row.repo_path) : null,
  };
}

function mapBoard(row: Record<string, unknown>): Board {
  const rawCols = row.columns as BoardColumn[] | null;
  const columns: BoardColumn[] = Array.isArray(rawCols)
    ? rawCols.map((c, i) => ({
        id: String(c.id ?? `col-${i}`),
        name: String(c.name ?? ''),
        label: String(c.label ?? c.name ?? ''),
        color: String(c.color ?? '#94a3b8'),
        position: typeof c.position === 'number' ? c.position : i,
      }))
    : [];

  return {
    id: String(row.id),
    name: String(row.name),
    projectId: row.project_id ? String(row.project_id) : null,
    description: row.description ? String(row.description) : null,
    columns,
  };
}

function mapTask(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    title: String(row.title),
    status: String(row.status),
    stage: String(row.stage),
    priority: String(row.priority),
    projectId: row.project_id ? String(row.project_id) : null,
    boardId: row.board_id ? String(row.board_id) : null,
    columnId: row.column_id ? String(row.column_id) : null,
    description: row.description ? String(row.description) : null,
  };
}

function mapAgentProject(row: Record<string, unknown>): AgentProject {
  return {
    agentName: String(row.agent_name),
    projectId: String(row.project_id),
    role: String(row.role),
  };
}

function mapExecutor(row: Record<string, unknown>): TuiExecutor {
  const meta = row.metadata;
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    agentName: row.agent_name ? String(row.agent_name) : null,
    provider: String(row.provider) as ProviderName,
    transport: String(row.transport) as TransportType,
    pid: row.pid != null ? Number(row.pid) : null,
    tmuxSession: row.tmux_session ? String(row.tmux_session) : null,
    tmuxPaneId: row.tmux_pane_id ? String(row.tmux_pane_id) : null,
    state: String(row.state) as ExecutorState,
    metadata: typeof meta === 'string' ? JSON.parse(meta) : ((meta as Record<string, unknown>) ?? {}),
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
    role: row.role ? String(row.role) : null,
    team: row.team ? String(row.team) : null,
  };
}

function mapAssignment(row: Record<string, unknown>): TuiAssignment {
  return {
    id: String(row.id),
    executorId: String(row.executor_id),
    taskId: row.task_id ? String(row.task_id) : null,
    taskTitle: row.task_title ? String(row.task_title) : null,
    wishSlug: row.wish_slug ? String(row.wish_slug) : null,
    groupNumber: row.group_number != null ? Number(row.group_number) : null,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
  };
}

// ── Tmux Tree ────────────────────────────────────────────────────────────────

interface TmuxTreeWindow {
  sessionName: string;
  index: number;
  name: string;
  active: boolean;
  paneCount: number;
}

/** @public */
export interface TmuxTreeSession {
  name: string;
  attached: boolean;
  windowCount: number;
  windows: TmuxTreeWindow[];
}

/** Load tmux session/window tree from shell (lightweight, no pane-level detail). @public */
export function loadTmuxTree(): TmuxTreeSession[] {
  let output: string;
  try {
    output = execSync(
      "tmux list-windows -a -F '#{session_name}|#{window_index}|#{window_name}|#{window_active}|#{window_panes}|#{session_attached}|#{session_windows}'",
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    return [];
  }

  if (!output) return [];

  const sessionMap = new Map<string, TmuxTreeSession>();

  for (const line of output.split('\n')) {
    if (!line) continue;
    const [sessName, winIdx, winName, winActive, winPanes, sessAttached, sessWindows] = line.split('|');

    if (!sessionMap.has(sessName)) {
      sessionMap.set(sessName, {
        name: sessName,
        attached: sessAttached === '1',
        windowCount: Number.parseInt(sessWindows, 10) || 0,
        windows: [],
      });
    }

    sessionMap.get(sessName)?.windows.push({
      sessionName: sessName,
      index: Number.parseInt(winIdx, 10) || 0,
      name: winName,
      active: winActive === '1',
      paneCount: Number.parseInt(winPanes, 10) || 0,
    });
  }

  return Array.from(sessionMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}
