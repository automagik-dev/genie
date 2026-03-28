/**
 * TUI data layer — PG queries for boot + LISTEN subscriptions for real-time updates.
 *
 * - loadAll(): parallel PG queries via getConnection() for fast tree hydration
 * - subscribe(): LISTEN on PG channels + followRuntimeEvents() for live updates
 * - parseRuntimeEvent(): categorize events for targeted React state updates
 */

import { getConnection } from '../lib/db.js';
import { type RuntimeEvent, followRuntimeEvents } from '../lib/runtime-events.js';
import type { TuiBoard, TuiColumn, TuiData, TuiOrg, TuiProject, TuiTask, TuiTeam } from './types.js';

/** Derive a URL-safe slug from a name. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** JSONB column shape inside boards.columns. */
interface ColumnJson {
  id: string;
  name: string;
  label?: string;
  position?: number;
}

// ---------------------------------------------------------------------------
// loadAll — boot query
// ---------------------------------------------------------------------------

/**
 * Load all data needed for the TUI tree in parallel.
 * Queries orgs, projects, boards (+columns from JSONB), tasks, and teams.
 * Target: <200ms on a local pgserve instance.
 */
export async function loadAll(): Promise<TuiData> {
  const sql = await getConnection();

  const [orgRows, projectRows, boardRows, taskRows, teamRows] = await Promise.all([
    sql`SELECT id, name, slug FROM organizations ORDER BY name`,
    sql`
      SELECT id, COALESCE(org_id, '') as org_id, name, repo_path, tmux_session
      FROM projects ORDER BY name
    `,
    sql`
      SELECT id, project_id, name, columns
      FROM boards WHERE project_id IS NOT NULL ORDER BY name
    `,
    sql`
      SELECT t.id, t.column_id, t.board_id, t.title, t.status, t.seq,
             (SELECT ta.actor_id FROM task_actors ta WHERE ta.task_id = t.id LIMIT 1) as assignee
      FROM tasks t
      WHERE t.board_id IS NOT NULL
      ORDER BY t.seq
    `,
    sql`
      SELECT name, project_id
      FROM teams WHERE project_id IS NOT NULL ORDER BY name
    `,
  ]);

  // Map organizations
  const orgs: TuiOrg[] = (orgRows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    name: String(r.name),
    slug: String(r.slug),
  }));

  // Map projects (snake_case → camelCase)
  const projects: TuiProject[] = (projectRows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    orgId: String(r.org_id),
    name: String(r.name),
    slug: slugify(String(r.name)),
    repoPath: r.repo_path != null ? String(r.repo_path) : null,
    tmuxSession: r.tmux_session != null ? String(r.tmux_session) : null,
  }));

  // Extract boards + flatten JSONB columns
  const boards: TuiBoard[] = [];
  const columns: TuiColumn[] = [];

  for (const r of boardRows as Record<string, unknown>[]) {
    const boardId = String(r.id);
    boards.push({
      id: boardId,
      projectId: String(r.project_id),
      name: String(r.name),
      slug: slugify(String(r.name)),
    });

    const rawCols: ColumnJson[] =
      typeof r.columns === 'string' ? JSON.parse(r.columns) : ((r.columns as ColumnJson[]) ?? []);
    for (const col of rawCols) {
      columns.push({
        id: col.id,
        boardId,
        name: col.label ?? col.name,
        position: col.position ?? 0,
      });
    }
  }

  // Map tasks
  const tasks: TuiTask[] = (taskRows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    columnId: r.column_id != null ? String(r.column_id) : '',
    boardId: r.board_id != null ? String(r.board_id) : '',
    title: String(r.title),
    slug: slugify(String(r.title)),
    status: String(r.status),
    seq: Number(r.seq),
    assignee: r.assignee != null ? String(r.assignee) : null,
  }));

  // Map teams (PK is `name`, no separate id)
  const teams: TuiTeam[] = (teamRows as Record<string, unknown>[]).map((r) => ({
    id: String(r.name),
    projectId: String(r.project_id),
    name: String(r.name),
  }));

  return { orgs, projects, boards, columns, tasks, teams };
}

// ---------------------------------------------------------------------------
// subscribe — real-time updates
// ---------------------------------------------------------------------------

export type TuiDataChangeKind = 'task' | 'board' | 'project' | 'full';

export interface TuiSubscription {
  stop: () => Promise<void>;
}

export interface TuiEventCallbacks {
  /** Fires when data changed in PG — caller should reload the affected slice. */
  onDataChange: (kind: TuiDataChangeKind, entityId?: string) => void;
  /** Fires on each runtime event (agent activity, tool calls, messages). */
  onRuntimeEvent?: (event: RuntimeEvent) => void;
}

/**
 * Subscribe to real-time PG events for the TUI.
 *
 * Combines three event sources:
 * 1. PG LISTEN on genie_task_stage + genie_audit_event for data mutations
 * 2. followRuntimeEvents() for agent activity (LISTEN + 5s poll)
 * 3. Periodic poll fallback (3s) for changes without NOTIFY triggers (e.g., raw status UPDATEs)
 *
 * Returns a handle with stop() for cleanup.
 */
export async function subscribe(callbacks: TuiEventCallbacks): Promise<TuiSubscription> {
  const sql = await getConnection();
  const listeners: Array<{ unlisten: () => Promise<void> }> = [];

  // 1. Task stage changes — instant via NOTIFY
  try {
    listeners.push(
      await sql.listen('genie_task_stage', (payload: string) => {
        const [taskId] = payload.split(':');
        callbacks.onDataChange('task', taskId);
      }),
    );
  } catch {
    // Channel may not exist yet — degrade gracefully
  }

  // 2. Audit events — covers board/project/task lifecycle operations
  try {
    listeners.push(
      await sql.listen('genie_audit_event', (payload: string) => {
        const parts = payload.split(':');
        const entityType = parts[0];
        const entityId = parts[2];
        if (entityType === 'board') callbacks.onDataChange('board', entityId);
        else if (entityType === 'project') callbacks.onDataChange('project', entityId);
        else if (entityType === 'task') callbacks.onDataChange('task', entityId);
        else callbacks.onDataChange('full');
      }),
    );
  } catch {
    // Degrade gracefully
  }

  // 3. Runtime events for agent activity
  let eventHandle: { stop: () => Promise<void> } | null = null;
  if (callbacks.onRuntimeEvent) {
    const cb = callbacks.onRuntimeEvent;
    try {
      eventHandle = await followRuntimeEvents({}, (event) => cb(event), { pollIntervalMs: 5000 });
    } catch {
      // Runtime events unavailable — continue without agent activity
    }
  }

  // 4. Periodic poll fallback — catches changes not covered by LISTEN
  //    (e.g., raw SQL UPDATEs on status column which has no trigger)
  const pollTimer = setInterval(() => {
    callbacks.onDataChange('full');
  }, 3000);

  return {
    stop: async () => {
      clearInterval(pollTimer);
      for (const listener of listeners) {
        try {
          await listener.unlisten();
        } catch {
          // Already cleaned up
        }
      }
      if (eventHandle) {
        try {
          await eventHandle.stop();
        } catch {
          // Already stopped
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// parseRuntimeEvent — categorize events for UI updates
// ---------------------------------------------------------------------------

/** What the TUI should do in response to a runtime event. */
export type TuiEventAction =
  | { type: 'agent_activity'; agent: string; team?: string; kind: RuntimeEvent['kind'] }
  | { type: 'data_change'; changeKind: TuiDataChangeKind }
  | { type: 'ignore' };

/**
 * Parse a RuntimeEvent into a TUI-specific action.
 * Used by the React layer to decide what to re-render.
 *
 * - state events → agent_activity (idle/working/permission indicators)
 * - tool_call events → agent_activity (tool usage indicators)
 * - system events with task/board subjects → data_change (reload slice)
 * - message events → agent_activity (communication indicators)
 */
export function parseRuntimeEvent(event: RuntimeEvent): TuiEventAction {
  switch (event.kind) {
    case 'state':
      return { type: 'agent_activity', agent: event.agent, team: event.team, kind: 'state' };

    case 'tool_call':
    case 'tool_result':
      return { type: 'agent_activity', agent: event.agent, team: event.team, kind: event.kind };

    case 'message':
      return { type: 'agent_activity', agent: event.agent, team: event.team, kind: 'message' };

    case 'system': {
      // System events with task/board subjects indicate data changes
      const subject = event.subject ?? '';
      if (subject.startsWith('genie.task.')) return { type: 'data_change', changeKind: 'task' };
      if (subject.startsWith('genie.board.')) return { type: 'data_change', changeKind: 'board' };
      if (subject.startsWith('genie.project.')) return { type: 'data_change', changeKind: 'project' };
      return { type: 'agent_activity', agent: event.agent, team: event.team, kind: 'system' };
    }

    case 'user':
    case 'assistant':
      return { type: 'agent_activity', agent: event.agent, team: event.team, kind: event.kind };

    case 'qa':
      return { type: 'agent_activity', agent: event.agent, team: event.team, kind: 'qa' };

    default:
      return { type: 'ignore' };
  }
}
