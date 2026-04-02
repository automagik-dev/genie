/**
 * Team Chat — PG-backed group channel per team.
 *
 * Each team has a chat channel stored in the `team_chat` PG table,
 * scoped by team name and repo_path.
 */

import { v4 as uuidv4 } from 'uuid';
import { getConnection } from './db.js';

// ============================================================================
// Types
// ============================================================================

export interface ChatMessage {
  /** Unique message ID. */
  id: string;
  /** Sender agent name. */
  sender: string;
  /** Message body text. */
  body: string;
  /** ISO timestamp when message was posted. */
  timestamp: string;
}

// ============================================================================
// Internal helpers
// ============================================================================

interface ChatRow {
  id: string;
  sender: string;
  body: string;
  created_at: Date | string;
}

/** Map a PG row to the ChatMessage interface. */
function rowToMessage(row: ChatRow): ChatMessage {
  return {
    id: row.id,
    sender: row.sender,
    body: row.body,
    timestamp: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Post a message to a team's chat channel.
 * Inserts a row into the team_chat PG table.
 */
export async function postMessage(
  repoPath: string,
  teamName: string,
  sender: string,
  body: string,
): Promise<ChatMessage> {
  const sql = await getConnection();
  const id = `chat-${uuidv4()}`;
  const now = new Date().toISOString();

  await sql`
    INSERT INTO team_chat (id, team, repo_path, sender, body, created_at)
    VALUES (${id}, ${teamName}, ${repoPath}, ${sender}, ${body}, ${now})
  `;

  return { id, sender, body, timestamp: now };
}

/**
 * Read messages from a team's chat channel.
 * Optionally filter messages since a given timestamp.
 */
export async function readMessages(repoPath: string, teamName: string, since?: string): Promise<ChatMessage[]> {
  const sql = await getConnection();

  if (since) {
    const rows = await sql`
      SELECT * FROM team_chat
      WHERE team = ${teamName} AND repo_path = ${repoPath} AND created_at >= ${since}
      ORDER BY created_at ASC
    `;
    return rows.map(rowToMessage);
  }

  const rows = await sql`
    SELECT * FROM team_chat
    WHERE team = ${teamName} AND repo_path = ${repoPath}
    ORDER BY created_at ASC
  `;
  return rows.map(rowToMessage);
}
