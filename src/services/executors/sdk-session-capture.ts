/**
 * SDK Session Capture — inline session + content recording for API-backed executors.
 *
 * Mirrors the rows that session-capture.ts (filewatch) produces for tmux sessions,
 * but writes them directly during the SDK query lifecycle instead of parsing JSONL.
 *
 * All writes go through SafePgCallFn so degraded mode (no PG) silently skips.
 *
 * Table targets:
 *   sessions        — one row per SDK session (Group 5, startSession / endSession)
 *   session_content — one row per turn (recordTurn)
 */

import type { SafePgCallFn } from '../../lib/safe-pg-call.js';

// ============================================================================
// startSession — create a sessions row
// ============================================================================

/**
 * Create a sessions row for an SDK-backed executor session.
 * Returns the session ID on success, null when PG is degraded.
 *
 * The session ID is the executor's `claudeSessionId` when available,
 * otherwise a synthetic `sdk-<executorId>-<ts>` key.
 */
export async function startSession(
  safePgCall: SafePgCallFn,
  executorId: string,
  claudeSessionId: string | undefined,
  agentId: string | null,
  team?: string,
  role?: string,
  wishSlug?: string,
): Promise<string | null> {
  const sessionId = claudeSessionId ?? `sdk-${executorId}-${Date.now()}`;

  // ON CONFLICT DO UPDATE (not DO NOTHING) so the session row gets its
  // executor / agent / attribution filled even when ingestion has already
  // inserted an orphaned placeholder for this id. COALESCE protects every
  // field that already has a non-null value — we only ever fill NULLs,
  // never overwrite better context. Status flips 'orphaned' → 'active'
  // when the SDK call brings real attribution; we never overwrite
  // 'completed' / 'crashed' / 'active'.
  const created = await safePgCall(
    'sdk-session-start',
    (sql) =>
      sql`INSERT INTO sessions (id, agent_id, executor_id, team, role, wish_slug, status, jsonl_path, project_path)
          VALUES (${sessionId}, ${agentId}, ${executorId}, ${team ?? null}, ${role ?? null}, ${wishSlug ?? null}, 'active', '', '')
          ON CONFLICT (id) DO UPDATE SET
            agent_id    = COALESCE(sessions.agent_id,    EXCLUDED.agent_id),
            executor_id = COALESCE(sessions.executor_id, EXCLUDED.executor_id),
            team        = COALESCE(sessions.team,        EXCLUDED.team),
            role        = COALESCE(sessions.role,        EXCLUDED.role),
            wish_slug   = COALESCE(sessions.wish_slug,   EXCLUDED.wish_slug),
            status      = CASE
              WHEN sessions.status = 'orphaned' AND EXCLUDED.agent_id IS NOT NULL
                THEN 'active'
              ELSE sessions.status
            END,
            updated_at  = now()
          RETURNING id`,
    null,
    { executorId, chatId: '' },
  );

  // created is null when safePgCall fell back (degraded), or the array from the INSERT.
  if (!created) return null;
  return sessionId;
}

// ============================================================================
// recordTurn — write a session_content row
// ============================================================================

/**
 * Record a single turn in session_content.
 * Mirrors the shape that session-capture.ts writes for tmux JSONL content:
 *   session_id, turn_index, role, content, tool_name, timestamp
 */
export async function recordTurn(
  safePgCall: SafePgCallFn,
  sessionId: string,
  turnIndex: number,
  role: 'assistant' | 'tool_input' | 'tool_output' | 'user',
  content: string,
  toolName?: string,
  timestamp?: string,
): Promise<void> {
  const ts = timestamp ?? new Date().toISOString();

  await safePgCall(
    'sdk-session-turn',
    (sql) =>
      sql`INSERT INTO session_content (session_id, turn_index, role, content, tool_name, timestamp)
          VALUES (${sessionId}, ${turnIndex}, ${role}, ${content}, ${toolName ?? null}, ${ts})
          ON CONFLICT (session_id, turn_index) DO NOTHING`,
    undefined,
    { executorId: '', chatId: '' },
  );
}

// ============================================================================
// updateTurnCount — bump sessions.total_turns
// ============================================================================

export async function updateTurnCount(safePgCall: SafePgCallFn, sessionId: string, totalTurns: number): Promise<void> {
  await safePgCall(
    'sdk-session-turn-count',
    (sql) => sql`UPDATE sessions SET total_turns = ${totalTurns}, updated_at = now() WHERE id = ${sessionId}`,
    undefined,
    { executorId: '', chatId: '' },
  );
}

// ============================================================================
// endSession — mark session as ended
// ============================================================================

/**
 * Mark a session as ended by setting ended_at and status.
 */
export async function endSession(
  safePgCall: SafePgCallFn,
  sessionId: string,
  status: 'completed' | 'crashed' | 'orphaned' = 'completed',
): Promise<void> {
  await safePgCall(
    'sdk-session-end',
    (sql) => sql`UPDATE sessions SET ended_at = now(), status = ${status}, updated_at = now() WHERE id = ${sessionId}`,
    undefined,
    { executorId: '', chatId: '' },
  );
}
