/**
 * Mailbox — Durable message store with unread/read semantics.
 *
 * ## Migration note (commit 44a153a3)
 *
 * Previously messages were written to `.genie/mailbox/<worker>.json` files and
 * delivered by a polling loop that woke up every few seconds to check for new
 * entries. This introduced latency proportional to the poll interval and made
 * cross-process coordination fragile.
 *
 * The current implementation replaced file-based polling with PostgreSQL:
 *  - Messages are persisted to the `mailbox` table (durable, queryable).
 *  - A `AFTER INSERT` trigger fires `pg_notify('genie_mailbox_delivery', …)`
 *    with payload `<to_worker>:<message_id>`.
 *  - `subscribeDelivery()` calls `sql.listen('genie_mailbox_delivery', …)` so
 *    the scheduler daemon receives the notification instantly — no polling.
 *  - A 30-second fallback poll catches any notifications missed during
 *    reconnects or daemon restarts.
 *
 * `.genie/mailbox/` JSON files are no longer written or read; references to
 * that path in older docs are outdated.
 *
 * Messages persist to PostgreSQL `mailbox` table before any push delivery
 * attempt. This ensures durability (DEC-7).
 *
 * Delivery is state-aware: messages are queued and pushed to tmux
 * panes only when the worker is idle (not mid-turn).
 */

import { v4 as uuidv4 } from 'uuid';
import type { NativeInboxMessage } from './claude-native-teams.js';
import { getConnection } from './db.js';
import { endSpan, startSpan } from './emit.js';
import { isWideEmitEnabled } from './observability-flag.js';
import { getAmbient as getTraceContext } from './trace-context.js';

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

interface MailboxRow {
  id: string;
  from_worker: string;
  to_worker: string;
  body: string;
  created_at: Date | string;
  read: boolean;
  delivered_at: Date | string | null;
}

function generateMessageId(): string {
  return `msg-${uuidv4()}`;
}

/** Map a PG row to the MailboxMessage interface. */
function rowToMessage(row: MailboxRow): MailboxMessage {
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

function normalizeWorkerIds(worker: string | string[]): string[] {
  const values = Array.isArray(worker) ? worker : [worker];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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

  const span = isWideEmitEnabled()
    ? startSpan(
        'mailbox.delivery',
        { from, to, channel: 'tmux', message_id: id },
        { source_subsystem: 'mailbox', ctx: getTraceContext() ?? undefined, repo_path: repoPath, agent: from },
      )
    : null;

  let outcome: 'delivered' | 'queued' | 'rejected' = 'queued';
  try {
    await sql`
      INSERT INTO mailbox (id, from_worker, to_worker, body, repo_path, read, delivered_at, created_at)
      VALUES (${id}, ${from}, ${to}, ${body}, ${repoPath}, false, ${null}, ${now})
    `;
    outcome = 'queued';
  } catch (err) {
    outcome = 'rejected';
    if (span) {
      endSpan(
        span,
        { outcome: 'rejected', body_excerpt: body.slice(0, 256) },
        { source_subsystem: 'mailbox', repo_path: repoPath, agent: from },
      );
    }
    throw err;
  }

  const message: MailboxMessage = {
    id,
    from,
    to,
    body,
    createdAt: now,
    read: false,
    deliveredAt: null,
  };

  // Mirror mailbox writes into the PG runtime event log for follow/QA flows.
  try {
    const { publishSubjectEvent } = await import('./runtime-events.js');
    await publishSubjectEvent(repoPath, `genie.msg.${to}`, {
      kind: 'message',
      agent: from,
      direction: 'out',
      peer: to,
      text: body,
      data: { messageId: message.id, from, to },
      source: 'mailbox',
      timestamp: message.createdAt,
    });
  } catch {
    // Event log unavailable — mailbox durability already succeeded
  }

  if (span) {
    endSpan(
      span,
      { outcome, body_excerpt: body.slice(0, 256), message_id: id },
      { source_subsystem: 'mailbox', repo_path: repoPath, agent: from },
    );
  }

  return message;
}

/**
 * Get all messages for a worker (inbox view).
 */
export async function inbox(repoPath: string, workerId: string | string[]): Promise<MailboxMessage[]> {
  const sql = await getConnection();
  const workerIds = normalizeWorkerIds(workerId);
  if (workerIds.length === 0) return [];
  const rows = await sql`
    SELECT * FROM mailbox
    WHERE to_worker = ANY(${workerIds}) AND repo_path = ${repoPath}
    ORDER BY created_at ASC
  `;
  return rows.map(rowToMessage);
}

/**
 * Read sent messages from a worker's outbox.
 * Queries the same mailbox table filtered by from_worker.
 */
export async function readOutbox(repoPath: string, workerId: string | string[]): Promise<MailboxMessage[]> {
  const sql = await getConnection();
  const workerIds = normalizeWorkerIds(workerId);
  if (workerIds.length === 0) return [];
  const rows = await sql`
    SELECT * FROM mailbox
    WHERE from_worker = ANY(${workerIds}) AND repo_path = ${repoPath}
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
export async function getUnread(repoPath: string, workerId: string | string[]): Promise<MailboxMessage[]> {
  const sql = await getConnection();
  const workerIds = normalizeWorkerIds(workerId);
  if (workerIds.length === 0) return [];
  const rows = await sql`
    SELECT * FROM mailbox
    WHERE to_worker = ANY(${workerIds}) AND repo_path = ${repoPath} AND read = false
    ORDER BY created_at ASC
  `;
  return rows.map(rowToMessage);
}

/**
 * Get a single message by ID.
 */
export async function getById(messageId: string): Promise<MailboxMessage | null> {
  const sql = await getConnection();
  const rows = await sql`
    SELECT * FROM mailbox WHERE id = ${messageId} LIMIT 1
  `;
  if (rows.length === 0) return null;
  return rowToMessage(rows[0]);
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
 * Increment delivery attempts and set status to 'failed'.
 * Called when pane injection fails during instant delivery.
 */
export async function markFailed(messageId: string): Promise<boolean> {
  const sql = await getConnection();
  const result = await sql`
    UPDATE mailbox
    SET delivery_status = 'failed',
        delivery_attempts = delivery_attempts + 1
    WHERE id = ${messageId}
    RETURNING id
  `;
  return result.length > 0;
}

/**
 * Get failed messages that haven't exceeded max retry attempts.
 * Used by the scheduler daemon's retry loop.
 */
export async function getRetryable(maxAttempts: number): Promise<MailboxMessage[]> {
  const sql = await getConnection();
  const rows = await sql`
    SELECT * FROM mailbox
    WHERE delivery_status = 'failed'
      AND delivery_attempts < ${maxAttempts}
    ORDER BY created_at ASC
    LIMIT 50
  `;
  return rows.map(rowToMessage);
}

/**
 * Mark a message as escalated (delivery exhausted all retries).
 */
export async function markEscalated(messageId: string): Promise<boolean> {
  const sql = await getConnection();
  const result = await sql`
    UPDATE mailbox
    SET delivery_status = 'escalated'
    WHERE id = ${messageId}
    RETURNING id
  `;
  return result.length > 0;
}

/**
 * Subscribe to mailbox delivery notifications via PG LISTEN/NOTIFY.
 * Calls the callback with (toWorker, messageId) on each new insert.
 * Returns an unsubscribe function.
 *
 * Used by the scheduler daemon for instant message delivery.
 */
export async function subscribeDelivery(
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
