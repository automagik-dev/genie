/**
 * Omni Sessions — CRUD for persistent session records.
 *
 * Each Omni bridge chat session gets a row in `omni_sessions` so the bridge
 * can recover state after restart and track session activity.
 */

import { getConnection } from '../lib/db.js';

// ============================================================================
// Types
// ============================================================================

export interface OmniSessionRecord {
  id: string;
  agentName: string;
  chatId: string;
  instanceId: string;
  claudeSessionId: string | null;
  createdAt: string;
  lastActivityAt: string;
  metadata: Record<string, unknown>;
}

interface SessionRow {
  id: string;
  agent_name: string;
  chat_id: string;
  instance_id: string;
  claude_session_id: string | null;
  created_at: string;
  last_activity_at: string;
  metadata: Record<string, unknown>;
}

function rowToRecord(row: SessionRow): OmniSessionRecord {
  return {
    id: row.id,
    agentName: row.agent_name,
    chatId: row.chat_id,
    instanceId: row.instance_id,
    claudeSessionId: row.claude_session_id,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    metadata: row.metadata,
  };
}

// ============================================================================
// CRUD
// ============================================================================

export async function upsertSession(
  id: string,
  agentName: string,
  chatId: string,
  instanceId: string,
  claudeSessionId?: string,
): Promise<OmniSessionRecord> {
  const sql = await getConnection();
  const rows = await sql<SessionRow[]>`
    INSERT INTO omni_sessions (id, agent_name, chat_id, instance_id, claude_session_id)
    VALUES (${id}, ${agentName}, ${chatId}, ${instanceId}, ${claudeSessionId ?? null})
    ON CONFLICT (id) DO UPDATE SET
      instance_id = EXCLUDED.instance_id,
      claude_session_id = COALESCE(EXCLUDED.claude_session_id, omni_sessions.claude_session_id),
      last_activity_at = now()
    RETURNING *
  `;
  return rowToRecord(rows[0]);
}

export async function getSession(id: string): Promise<OmniSessionRecord | null> {
  const sql = await getConnection();
  const rows = await sql<SessionRow[]>`
    SELECT * FROM omni_sessions WHERE id = ${id}
  `;
  return rows.length > 0 ? rowToRecord(rows[0]) : null;
}

export async function listSessions(filter?: { agentName?: string; instanceId?: string }): Promise<OmniSessionRecord[]> {
  const sql = await getConnection();
  if (filter?.agentName && filter?.instanceId) {
    const rows = await sql<SessionRow[]>`
      SELECT * FROM omni_sessions
      WHERE agent_name = ${filter.agentName} AND instance_id = ${filter.instanceId}
      ORDER BY last_activity_at DESC
    `;
    return rows.map(rowToRecord);
  }
  if (filter?.agentName) {
    const rows = await sql<SessionRow[]>`
      SELECT * FROM omni_sessions
      WHERE agent_name = ${filter.agentName}
      ORDER BY last_activity_at DESC
    `;
    return rows.map(rowToRecord);
  }
  if (filter?.instanceId) {
    const rows = await sql<SessionRow[]>`
      SELECT * FROM omni_sessions
      WHERE instance_id = ${filter.instanceId}
      ORDER BY last_activity_at DESC
    `;
    return rows.map(rowToRecord);
  }
  const rows = await sql<SessionRow[]>`
    SELECT * FROM omni_sessions ORDER BY last_activity_at DESC
  `;
  return rows.map(rowToRecord);
}

export async function deleteSession(id: string): Promise<void> {
  const sql = await getConnection();
  await sql`DELETE FROM omni_sessions WHERE id = ${id}`;
}

export async function deleteByAgent(agentName: string): Promise<void> {
  const sql = await getConnection();
  await sql`DELETE FROM omni_sessions WHERE agent_name = ${agentName}`;
}

/** Delete by chat_id. Returns number of deleted rows. */
export async function deleteByChatId(chatId: string): Promise<number> {
  const sql = await getConnection();
  const result = await sql`DELETE FROM omni_sessions WHERE chat_id = ${chatId}`;
  return result.count;
}

/** Delete all sessions for an agent. Returns number of deleted rows. */
export async function deleteAllByAgent(agentName: string): Promise<number> {
  const sql = await getConnection();
  const result = await sql`DELETE FROM omni_sessions WHERE agent_name = ${agentName}`;
  return result.count;
}

/** Count total sessions. */
export async function countSessions(): Promise<number> {
  const sql = await getConnection();
  const [row] = await sql`SELECT count(*)::int AS count FROM omni_sessions`;
  return row.count;
}

export async function touchSession(id: string, claudeSessionId?: string): Promise<void> {
  const sql = await getConnection();
  if (claudeSessionId) {
    await sql`
      UPDATE omni_sessions
      SET last_activity_at = now(), claude_session_id = ${claudeSessionId}
      WHERE id = ${id}
    `;
  } else {
    await sql`
      UPDATE omni_sessions SET last_activity_at = now() WHERE id = ${id}
    `;
  }
}
