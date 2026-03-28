/** PG data layer — framework-agnostic, no UI imports */

import type { AgentProject, Board, BoardColumn, Org, Project, Task, TuiData } from './types.js';

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
