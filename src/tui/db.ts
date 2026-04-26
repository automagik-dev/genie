/** PG executor/assignment queries — framework-agnostic, no UI imports */

import type { ExecutorState, TransportType } from '../lib/executor-types.js';
import type { ProviderName } from '../lib/provider-adapters.js';
import type { TuiAssignment, TuiExecutor, WorkState } from './types.js';

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

/**
 * Load per-agent work-state via `shouldResume()`. Keyed by the canonical
 * display name (`custom_name` ?? `role`) so the workspace-tree builder
 * can look up by node label.
 *
 * Wish: invincible-genie / Group 2 (TUI-2 deliverable). Replaces the
 * Nav.tsx switch on `wsAgentState` with a unified work-state badge.
 */
export async function loadAgentWorkStates(): Promise<Map<string, WorkState>> {
  const { listAgents } = await import('../lib/agent-registry.js');
  const { shouldResume, BOOT_PASS_CONCURRENCY_CAP } = await import('../lib/should-resume.js');

  const agents = await listAgents({ includeArchived: false });
  if (agents.length === 0) return new Map();

  const out = new Map<string, WorkState>();
  let cursor = 0;
  const cap = Math.min(BOOT_PASS_CONCURRENCY_CAP, Math.max(1, agents.length));

  const workers = Array.from({ length: cap }, async () => {
    while (cursor < agents.length) {
      const i = cursor++;
      if (i >= agents.length) return;
      const a = agents[i];
      try {
        const decision = await shouldResume(a.id);
        const work = reasonToWorkState(decision.reason);
        if (!work) continue;
        const name = a.customName ?? a.role ?? a.id;
        out.set(name, work);
      } catch {
        /* one bad row can't wedge the diagnostics refresh */
      }
    }
  });
  await Promise.all(workers);
  return out;
}

function reasonToWorkState(reason: string): WorkState | undefined {
  if (reason === 'ok') return 'in_flight';
  if (reason === 'auto_resume_disabled') return 'paused';
  if (reason === 'assignment_closed') return 'done';
  if (reason === 'no_session_id') return 'stuck';
  return undefined;
}
