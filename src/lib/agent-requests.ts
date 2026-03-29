/**
 * Agent Requests — Typed agent→human request/response protocol.
 *
 * Provides structured I/O between agents and humans for:
 *   - env: request an environment variable or secret
 *   - confirm: yes/no confirmation
 *   - choice: pick from a list of options
 *   - approve: approve an action with optional note
 *   - input: free-form text input
 *
 * Backed by PG `agent_requests` table with LISTEN/NOTIFY on `genie_request`.
 */

import { getConnection } from './db.js';

// ============================================================================
// Types
// ============================================================================

export type AgentRequestType = 'env' | 'confirm' | 'choice' | 'approve' | 'input';
export type AgentRequestStatus = 'pending' | 'resolved' | 'rejected' | 'expired';

export interface AgentRequest {
  id: string;
  agentId: string;
  executorId: string | null;
  taskId: string | null;
  team: string | null;
  type: AgentRequestType;
  payload: Record<string, unknown>;
  status: AgentRequestStatus;
  resolvedBy: string | null;
  resolvedValue: unknown | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface AgentRequestInput {
  agentId: string;
  type: AgentRequestType;
  payload: Record<string, unknown>;
  executorId?: string;
  taskId?: string;
  team?: string;
}

export interface AgentRequestFilters {
  team?: string;
  agentId?: string;
  status?: AgentRequestStatus;
  taskId?: string;
  type?: AgentRequestType;
  limit?: number;
}

// ============================================================================
// Internal helpers
// ============================================================================

interface AgentRequestRow {
  id: string;
  agent_id: string;
  executor_id: string | null;
  task_id: string | null;
  team: string | null;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  resolved_by: string | null;
  resolved_value: unknown | null;
  resolved_at: Date | string | null;
  created_at: Date | string;
}

function rowToRequest(row: AgentRequestRow): AgentRequest {
  return {
    id: row.id,
    agentId: row.agent_id,
    executorId: row.executor_id,
    taskId: row.task_id,
    team: row.team,
    type: row.type as AgentRequestType,
    payload: row.payload,
    status: row.status as AgentRequestStatus,
    resolvedBy: row.resolved_by,
    resolvedValue: row.resolved_value,
    resolvedAt: row.resolved_at
      ? row.resolved_at instanceof Date
        ? row.resolved_at.toISOString()
        : String(row.resolved_at)
      : null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

// ============================================================================
// Public API
// ============================================================================

/** Create a new agent request. Returns the persisted row. */
export async function createRequest(input: AgentRequestInput): Promise<AgentRequest> {
  const sql = await getConnection();
  const rows = await sql<AgentRequestRow[]>`
    INSERT INTO agent_requests (agent_id, executor_id, task_id, team, type, payload)
    VALUES (
      ${input.agentId},
      ${input.executorId ?? null},
      ${input.taskId ?? null},
      ${input.team ?? null},
      ${input.type},
      ${sql.json(input.payload)}
    )
    RETURNING *
  `;
  return rowToRequest(rows[0]);
}

/** List requests with optional filters. */
export async function listRequests(filters: AgentRequestFilters = {}): Promise<AgentRequest[]> {
  const sql = await getConnection();
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (filters.team) {
    conditions.push(`team = $${idx++}`);
    values.push(filters.team);
  }
  if (filters.agentId) {
    conditions.push(`agent_id = $${idx++}`);
    values.push(filters.agentId);
  }
  if (filters.status) {
    conditions.push(`status = $${idx++}`);
    values.push(filters.status);
  }
  if (filters.taskId) {
    conditions.push(`task_id = $${idx++}`);
    values.push(filters.taskId);
  }
  if (filters.type) {
    conditions.push(`type = $${idx++}`);
    values.push(filters.type);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ?? 100;

  const rows = (await sql.unsafe(`SELECT * FROM agent_requests ${where} ORDER BY created_at DESC LIMIT $${idx}`, [
    ...values,
    limit,
  ])) as AgentRequestRow[];

  return rows.map(rowToRequest);
}

/** Get all pending requests, optionally scoped to a team. */
export async function getPendingRequests(team?: string): Promise<AgentRequest[]> {
  return listRequests({ status: 'pending', team });
}

/** Resolve a request with a value. */
export async function resolveRequest(id: string, resolvedBy: string, resolvedValue: unknown): Promise<AgentRequest> {
  const sql = await getConnection();
  const rows = await sql<AgentRequestRow[]>`
    UPDATE agent_requests
    SET status = 'resolved',
        resolved_by = ${resolvedBy},
        resolved_value = ${sql.json(resolvedValue)},
        resolved_at = now()
    WHERE id = ${id}
      AND status = 'pending'
    RETURNING *
  `;
  if (rows.length === 0) throw new Error(`Request not found or not pending: ${id}`);
  return rowToRequest(rows[0]);
}

/** Reject a request with an optional reason. */
export async function rejectRequest(id: string, resolvedBy: string, reason?: string): Promise<AgentRequest> {
  const sql = await getConnection();
  const rows = await sql<AgentRequestRow[]>`
    UPDATE agent_requests
    SET status = 'rejected',
        resolved_by = ${resolvedBy},
        resolved_value = ${sql.json(reason ? { reason } : {})},
        resolved_at = now()
    WHERE id = ${id}
      AND status = 'pending'
    RETURNING *
  `;
  if (rows.length === 0) throw new Error(`Request not found or not pending: ${id}`);
  return rowToRequest(rows[0]);
}

/** Expire all pending requests older than the given threshold. */
export async function expireRequests(olderThanMs: number): Promise<number> {
  const sql = await getConnection();
  const result = await sql`
    UPDATE agent_requests
    SET status = 'expired',
        resolved_at = now()
    WHERE status = 'pending'
      AND created_at < now() - ${`${olderThanMs} milliseconds`}::interval
  `;
  return result.count;
}

/** Get a single request by ID. */
export async function getRequest(id: string): Promise<AgentRequest | null> {
  const sql = await getConnection();
  const rows = await sql<AgentRequestRow[]>`
    SELECT * FROM agent_requests WHERE id = ${id}
  `;
  return rows.length > 0 ? rowToRequest(rows[0]) : null;
}

/** Follow agent request events via PG LISTEN/NOTIFY. */
export async function followRequests(
  onEvent: (requestId: string, agentId: string, type: string, status: string) => void,
): Promise<{ stop: () => Promise<void> }> {
  const sql = await getConnection();
  const listener = await sql.listen('genie_request', (payload: string) => {
    // Payload format: id:agent_id:type:status
    const parts = payload.split(':');
    if (parts.length >= 4) {
      onEvent(parts[0], parts[1], parts[2], parts[3]);
    }
  });

  return {
    stop: async () => {
      await listener.unlisten();
    },
  };
}
