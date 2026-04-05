/**
 * Executor Registry — CRUD for ephemeral executor process records.
 *
 * Executors are the runtime counterpart to agents: one agent can have many
 * executors over its lifetime, but only one is "current" at any time.
 * State lives here; agent identity is in agent-registry.
 */

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from './audit.js';
import { getConnection } from './db.js';
import {
  type Executor,
  type ExecutorRow,
  type ExecutorState,
  type TransportType,
  rowToExecutor,
} from './executor-types.js';
import type { ProviderName } from './provider-adapters.js';

// ============================================================================
// Types
// ============================================================================

export interface CreateExecutorOpts {
  /** Pre-generated executor ID. If omitted, a UUID is generated. */
  id?: string;
  pid?: number | null;
  tmuxSession?: string | null;
  tmuxPaneId?: string | null;
  tmuxWindow?: string | null;
  tmuxWindowId?: string | null;
  claudeSessionId?: string | null;
  state?: ExecutorState;
  metadata?: Record<string, unknown>;
  worktree?: string | null;
  repoPath?: string | null;
  paneColor?: string | null;
}

// ============================================================================
// CRUD
// ============================================================================

/**
 * Create an executor record and return it.
 * Does NOT set agent.current_executor_id — caller should use
 * agent-registry.setCurrentExecutor() after creation.
 */
export async function createExecutor(
  agentId: string,
  provider: ProviderName,
  transport: TransportType,
  opts: CreateExecutorOpts = {},
): Promise<Executor> {
  const sql = await getConnection();
  const id = opts.id ?? randomUUID();
  const now = new Date().toISOString();

  const rows = await sql<ExecutorRow[]>`
    INSERT INTO executors (
      id, agent_id, provider, transport, pid,
      tmux_session, tmux_pane_id, tmux_window, tmux_window_id,
      claude_session_id, state, metadata, worktree, repo_path, pane_color,
      started_at
    ) VALUES (
      ${id}, ${agentId}, ${provider}, ${transport}, ${opts.pid ?? null},
      ${opts.tmuxSession ?? null}, ${opts.tmuxPaneId ?? null},
      ${opts.tmuxWindow ?? null}, ${opts.tmuxWindowId ?? null},
      ${opts.claudeSessionId ?? null}, ${opts.state ?? 'spawning'},
      ${sql.json(opts.metadata ?? {})}, ${opts.worktree ?? null},
      ${opts.repoPath ?? null}, ${opts.paneColor ?? null},
      ${now}
    ) RETURNING *
  `;

  return rowToExecutor(rows[0]);
}

/**
 * Atomically create an executor and set it as the agent's current executor.
 * Both operations happen in a single SQL transaction to prevent orphaned records.
 */
export async function createAndLinkExecutor(
  agentId: string,
  provider: ProviderName,
  transport: TransportType,
  opts: CreateExecutorOpts = {},
): Promise<Executor> {
  const sql = await getConnection();
  const id = opts.id ?? randomUUID();
  const now = new Date().toISOString();

  return sql.begin(async (tx: any) => {
    const rows = await tx<ExecutorRow[]>`
      INSERT INTO executors (
        id, agent_id, provider, transport, pid,
        tmux_session, tmux_pane_id, tmux_window, tmux_window_id,
        claude_session_id, state, metadata, worktree, repo_path, pane_color,
        started_at
      ) VALUES (
        ${id}, ${agentId}, ${provider}, ${transport}, ${opts.pid ?? null},
        ${opts.tmuxSession ?? null}, ${opts.tmuxPaneId ?? null},
        ${opts.tmuxWindow ?? null}, ${opts.tmuxWindowId ?? null},
        ${opts.claudeSessionId ?? null}, ${opts.state ?? 'spawning'},
        ${tx.json(opts.metadata ?? {})}, ${opts.worktree ?? null},
        ${opts.repoPath ?? null}, ${opts.paneColor ?? null},
        ${now}
      ) RETURNING *
    `;

    await tx`UPDATE agents SET current_executor_id = ${id} WHERE id = ${agentId}`;

    return rowToExecutor(rows[0]);
  });
}

/** Get an executor by ID. */
export async function getExecutor(id: string): Promise<Executor | null> {
  const sql = await getConnection();
  const rows = await sql<ExecutorRow[]>`SELECT * FROM executors WHERE id = ${id}`;
  return rows.length > 0 ? rowToExecutor(rows[0]) : null;
}

/** Get the current executor for an agent (via agents.current_executor_id). */
export async function getCurrentExecutor(agentId: string): Promise<Executor | null> {
  const sql = await getConnection();
  const rows = await sql<ExecutorRow[]>`
    SELECT e.* FROM executors e
    JOIN agents a ON a.current_executor_id = e.id
    WHERE a.id = ${agentId}
  `;
  return rows.length > 0 ? rowToExecutor(rows[0]) : null;
}

/** Update executor state with audit trail. */
export async function updateExecutorState(id: string, state: ExecutorState): Promise<void> {
  const sql = await getConnection();
  const updates: Record<string, unknown> = { state };
  if (state === 'terminated' || state === 'done' || state === 'error') {
    updates.ended_at = new Date().toISOString();
  }
  await sql`UPDATE executors SET ${sql(updates)} WHERE id = ${id}`;

  recordAuditEvent('executor', id, 'state_changed', process.env.GENIE_AGENT_NAME ?? 'cli', {
    state,
  }).catch(() => {});
}

/** Terminate an executor: set state='terminated', ended_at=now(). */
export async function terminateExecutor(id: string): Promise<void> {
  const sql = await getConnection();
  const now = new Date().toISOString();
  await sql`
    UPDATE executors
    SET state = 'terminated', ended_at = ${now}
    WHERE id = ${id} AND state NOT IN ('terminated', 'done')
  `;

  recordAuditEvent('executor', id, 'terminated', process.env.GENIE_AGENT_NAME ?? 'cli').catch(() => {});
}

/**
 * Terminate the active executor for an agent and null the FK.
 * Used by the concurrent executor guard before spawning a new one.
 */
export async function terminateActiveExecutor(agentId: string): Promise<void> {
  const sql = await getConnection();

  // Get current executor ID
  const agentRows = await sql`SELECT current_executor_id FROM agents WHERE id = ${agentId}`;
  if (agentRows.length === 0 || !agentRows[0].current_executor_id) return;

  const executorId = agentRows[0].current_executor_id;

  // Terminate the executor
  await terminateExecutor(executorId);

  // Atomic null — only if still pointing to the same executor (prevents race with concurrent spawns)
  await sql`UPDATE agents SET current_executor_id = NULL WHERE id = ${agentId} AND current_executor_id = ${executorId}`;
}

/** List executors, optionally filtered by agent ID and/or metadata source. */
export async function listExecutors(agentId?: string, source?: string): Promise<Executor[]> {
  const sql = await getConnection();
  const rows = await sql<ExecutorRow[]>`
    SELECT * FROM executors
    WHERE true
    ${agentId ? sql`AND agent_id = ${agentId}` : sql``}
    ${source ? sql`AND metadata->>'source' = ${source}` : sql``}
    ORDER BY started_at DESC
  `;
  return rows.map(rowToExecutor);
}

/** Find executor by tmux pane ID. */
export async function findExecutorByPane(paneId: string): Promise<Executor | null> {
  const sql = await getConnection();
  const normalized = paneId.startsWith('%') ? paneId : `%${paneId}`;
  const rows = await sql<ExecutorRow[]>`SELECT * FROM executors WHERE tmux_pane_id = ${normalized}`;
  return rows.length > 0 ? rowToExecutor(rows[0]) : null;
}

/** Find executor by Claude session ID. */
export async function findExecutorBySession(claudeSessionId: string): Promise<Executor | null> {
  const sql = await getConnection();
  const rows = await sql<ExecutorRow[]>`
    SELECT * FROM executors WHERE claude_session_id = ${claudeSessionId} LIMIT 1
  `;
  return rows.length > 0 ? rowToExecutor(rows[0]) : null;
}

/**
 * Find the latest live executor matching omni metadata.
 * Used for lazy resume: on bridge restart, look up an existing executor
 * for this agent + chat combination so we can reuse its Claude session.
 * Uses the `executors_omni_lookup` partial index (migration 026).
 */
export async function findLatestByMetadata(filter: {
  agentId: string;
  source: string;
  chatId: string;
}): Promise<Executor | null> {
  const sql = await getConnection();
  const rows = await sql<ExecutorRow[]>`
    SELECT * FROM executors
    WHERE agent_id = ${filter.agentId}
      AND metadata->>'source' = ${filter.source}
      AND metadata->>'chat_id' = ${filter.chatId}
      AND ended_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1
  `;
  return rows.length > 0 ? rowToExecutor(rows[0]) : null;
}

/** Relink an existing executor to an agent (set current_executor_id FK). */
export async function relinkExecutorToAgent(executorId: string, agentId: string): Promise<void> {
  const sql = await getConnection();
  await sql`UPDATE agents SET current_executor_id = ${executorId} WHERE id = ${agentId}`;
}

/** Update the Claude session ID on an executor row. */
export async function updateClaudeSessionId(executorId: string, sessionId: string): Promise<void> {
  const sql = await getConnection();
  await sql`UPDATE executors SET claude_session_id = ${sessionId} WHERE id = ${executorId}`;
}
