/**
 * Mailbox — Durable message store with unread/read semantics.
 *
 * Messages persist to PostgreSQL `mailbox` table before any push delivery
 * attempt. This ensures durability (DEC-7).
 *
 * Delivery is state-aware: messages are queued and pushed to tmux
 * panes only when the worker is idle (not mid-turn).
 *
 * PG LISTEN/NOTIFY triggers instant delivery notification on new inserts.
 */

import { v4 as uuidv4 } from 'uuid';
import type { NativeInboxMessage } from './claude-native-teams.js';
import { getConnection } from './db.js';

// ============================================================================
// Types
// ============================================================================

export interface MailboxMessage {
  /** Unique message ID. */
  id: string;
  /** Sender worker ID or "operator" for human-initiated messages. */
  from: string;
  /** Recipient worker ID. */
  to: string;
  /** Message body text. */
  body: string;
  /** ISO timestamp when message was created. */
  createdAt: string;
  /** Whether the recipient has read this message. */
  read: boolean;
  /** ISO timestamp when message was delivered to pane (null if pending). */
  deliveredAt: string | null;
}

// ============================================================================
// Internal helpers
// ============================================================================

function generateMessageId(): string {
  return `msg-${uuidv4()}`;
}

/** Map a PG row to the MailboxMessage interface. */
// biome-ignore lint/suspicious/noExplicitAny: PG row uses dynamic column names
function rowToMessage(row: any): MailboxMessage {
  return {
    id: row.id,
    from: row.from_worker,
    to: row.to_worker,
    body: row.body,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    read: row.read,
    deliveredAt: row.delivered_at
      ? row.delivered_at instanceof Date
        ? row.delivered_at.toISOString()
        : String(row.delivered_at)
      : null,
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Write a message to a worker's mailbox.
 * This persists BEFORE any delivery attempt (DEC-7).
 * PG trigger auto-fires NOTIFY genie_mailbox_delivery.
 */
export async function send(repoPath: string, from: string, to: string, body: string): Promise<MailboxMessage> {
  const sql = await getConnection();
  const id = generateMessageId();
  const now = new Date().toISOString();

  await sql`
    INSERT INTO mailbox (id, from_worker, to_worker, body, repo_path, read, delivered_at, created_at)
    VALUES (${id}, ${from}, ${to}, ${body}, ${repoPath}, false, ${null}, ${now})
  `;

  const message: MailboxMessage = {
    id,
    from,
    to,
    body,
    createdAt: now,
    read: false,
    deliveredAt: null,
  };

  // Publish to NATS for real-time streaming (fire-and-forget, auto-closes)
  try {
    const { publish } = await import('./nats-client.js');
    await publish(`genie.msg.${to}`, {
      timestamp: message.createdAt,
      kind: 'message',
      agent: from,
      direction: 'out',
      peer: to,
      text: body,
      data: { messageId: message.id, from, to },
      source: 'mailbox',
    });
  } catch {
    // NATS unavailable — no-op
  }

  return message;
}

/**
 * Get all messages for a worker (inbox view).
 */
export async function inbox(repoPath: string, workerId: string): Promise<MailboxMessage[]> {
  const sql = await getConnection();
  const rows = await sql`
    SELECT * FROM mailbox
    WHERE to_worker = ${workerId} AND repo_path = ${repoPath}
    ORDER BY created_at ASC
  `;
  return rows.map(rowToMessage);
}

/**
 * Read sent messages from a worker's outbox.
 * Queries the same mailbox table filtered by from_worker.
 */
export async function readOutbox(repoPath: string, workerId: string): Promise<MailboxMessage[]> {
  const sql = await getConnection();
  const rows = await sql`
    SELECT * FROM mailbox
    WHERE from_worker = ${workerId} AND repo_path = ${repoPath}
    ORDER BY created_at ASC
  `;
  return rows.map(rowToMessage);
}

/**
 * Mark a message as delivered (pane injection succeeded).
 */
export async function markDelivered(repoPath: string, workerId: string, messageId: string): Promise<boolean> {
  const sql = await getConnection();
  const result = await sql`
    UPDATE mailbox SET delivered_at = now()
    WHERE id = ${messageId} AND to_worker = ${workerId} AND repo_path = ${repoPath}
    RETURNING id
  `;
  return result.length > 0;
}

/**
 * Get unread messages for a worker.
 */
export async function getUnread(repoPath: string, workerId: string): Promise<MailboxMessage[]> {
  const sql = await getConnection();
  const rows = await sql`
    SELECT * FROM mailbox
    WHERE to_worker = ${workerId} AND repo_path = ${repoPath} AND read = false
    ORDER BY created_at ASC
  `;
  return rows.map(rowToMessage);
}

/**
 * Mark a message as read.
 */
export async function markRead(messageId: string): Promise<boolean> {
  const sql = await getConnection();
  const result = await sql`
    UPDATE mailbox SET read = true WHERE id = ${messageId}
    RETURNING id
  `;
  return result.length > 0;
}

/**
 * Convert a Genie mailbox message to Claude Code's native inbox format.
 */
export function toNativeInboxMessage(msg: MailboxMessage, color = 'blue'): NativeInboxMessage {
  // Truncate body to create a summary (5-10 words)
  const words = msg.body.split(/\s+/);
  const summary = words.slice(0, 8).join(' ') + (words.length > 8 ? '...' : '');

  return {
    from: msg.from,
    text: msg.body,
    summary,
    timestamp: msg.createdAt,
    color,
    read: false,
  };
}

/**
 * Subscribe to mailbox delivery notifications via PG LISTEN/NOTIFY.
 * Calls the callback with (toWorker, messageId) on each new insert.
 * Returns an unsubscribe function.
 *
 * Internal for now — will be exported when inbox-watcher integration lands.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- future inbox-watcher integration
async function _subscribeDelivery(
  callback: (toWorker: string, messageId: string) => void,
): Promise<() => Promise<void>> {
  const sql = await getConnection();
  const listener = await sql.listen('genie_mailbox_delivery', (payload: string) => {
    const [toWorker, messageId] = payload.split(':');
    if (toWorker && messageId) {
      callback(toWorker, messageId);
    }
  });
  return async () => {
    await listener.unlisten();
  };
}
