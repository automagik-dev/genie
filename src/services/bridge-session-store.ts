/**
 * Bridge Session Store — PG persistence for omni bridge sessions.
 *
 * Tracks session lifecycle in genie_bridge_sessions table so sessions
 * survive process restarts. Uses the bridge's safePgCall pattern for
 * graceful degradation when PG is unavailable.
 */

import type { Sql } from '../lib/db.js';

// ============================================================================
// Types
// ============================================================================

export interface BridgeSessionRow {
  id: string;
  executor_id: string | null;
  instance_id: string;
  chat_id: string;
  agent_name: string;
  tmux_pane_id: string | null;
  claude_session_id: string | null;
  status: 'active' | 'closed' | 'orphaned';
  started_at: Date;
  last_activity_at: Date;
  closed_at: Date | null;
  metadata: Record<string, unknown>;
}

export interface CreateSessionOpts {
  instanceId: string;
  chatId: string;
  agentName: string;
  executorId?: string;
  tmuxPaneId?: string;
  claudeSessionId?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Store
// ============================================================================

export class BridgeSessionStore {
  constructor(private sql: Sql) {}

  /**
   * Record a new session on spawn.
   */
  async create(opts: CreateSessionOpts): Promise<string> {
    const [row] = await this.sql<{ id: string }[]>`
      INSERT INTO genie_bridge_sessions (
        instance_id, chat_id, agent_name, executor_id,
        tmux_pane_id, claude_session_id, metadata
      ) VALUES (
        ${opts.instanceId}, ${opts.chatId}, ${opts.agentName},
        ${opts.executorId ?? null}, ${opts.tmuxPaneId ?? null},
        ${opts.claudeSessionId ?? null}, ${JSON.stringify(opts.metadata ?? {})}::jsonb
      )
      RETURNING id
    `;
    return row.id;
  }

  /**
   * Update last_activity_at on message delivery.
   */
  async recordActivity(sessionId: string): Promise<void> {
    await this.sql`
      UPDATE genie_bridge_sessions
      SET last_activity_at = now()
      WHERE id = ${sessionId} AND status = 'active'
    `;
  }

  /**
   * Close a session (agent ended or idle timeout).
   */
  async close(sessionId: string): Promise<void> {
    await this.sql`
      UPDATE genie_bridge_sessions
      SET status = 'closed', closed_at = now()
      WHERE id = ${sessionId} AND status = 'active'
    `;
  }

  /**
   * Mark sessions as orphaned (bridge restart detected stale active sessions).
   */
  async markOrphaned(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    await this.sql`
      UPDATE genie_bridge_sessions
      SET status = 'orphaned'
      WHERE id = ANY(${sessionIds}) AND status = 'active'
    `;
  }

  /**
   * Mark all active sessions as orphaned (bridge startup cleanup).
   */
  async markAllOrphaned(): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE genie_bridge_sessions
      SET status = 'orphaned'
      WHERE status = 'active'
      RETURNING id
    `;
    return rows.length;
  }

  /**
   * List sessions by status for the status command.
   */
  async list(status?: 'active' | 'closed' | 'orphaned'): Promise<BridgeSessionRow[]> {
    if (status) {
      return this.sql<BridgeSessionRow[]>`
        SELECT * FROM genie_bridge_sessions
        WHERE status = ${status}
        ORDER BY started_at DESC
        LIMIT 100
      `;
    }
    return this.sql<BridgeSessionRow[]>`
      SELECT * FROM genie_bridge_sessions
      ORDER BY started_at DESC
      LIMIT 100
    `;
  }

  /**
   * Get active session for a given instance+chat pair.
   */
  async getActive(instanceId: string, chatId: string): Promise<BridgeSessionRow | null> {
    const [row] = await this.sql<BridgeSessionRow[]>`
      SELECT * FROM genie_bridge_sessions
      WHERE instance_id = ${instanceId}
        AND chat_id = ${chatId}
        AND status = 'active'
      LIMIT 1
    `;
    return row ?? null;
  }

  /**
   * Update executor details (e.g., after tmux pane is created).
   */
  async updateExecutorInfo(
    sessionId: string,
    info: { executorId?: string; tmuxPaneId?: string; claudeSessionId?: string },
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (info.executorId !== undefined) {
      sets.push('executor_id');
      values.push(info.executorId);
    }
    if (info.tmuxPaneId !== undefined) {
      sets.push('tmux_pane_id');
      values.push(info.tmuxPaneId);
    }
    if (info.claudeSessionId !== undefined) {
      sets.push('claude_session_id');
      values.push(info.claudeSessionId);
    }
    if (sets.length === 0) return;

    // Use individual SET clauses — postgres.js tagged templates don't support dynamic column lists
    await this.sql`
      UPDATE genie_bridge_sessions SET
        executor_id = COALESCE(${info.executorId ?? null}, executor_id),
        tmux_pane_id = COALESCE(${info.tmuxPaneId ?? null}, tmux_pane_id),
        claude_session_id = COALESCE(${info.claudeSessionId ?? null}, claude_session_id),
        last_activity_at = now()
      WHERE id = ${sessionId}
    `;
  }
}
