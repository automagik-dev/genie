/**
 * Mailbox — Durable message store with unread/read semantics.
 *
 * Messages persist to `.genie/mailbox/<worker-id>.json` before
 * any push delivery attempt. This ensures durability (DEC-7).
 *
 * Delivery is state-aware: messages are queued and pushed to tmux
 * panes only when the worker is idle (not mid-turn).
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

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

export interface WorkerMailbox {
  workerId: string;
  messages: MailboxMessage[];
  lastUpdated: string;
}

// ============================================================================
// Paths
// ============================================================================

function mailboxDir(repoPath: string): string {
  return join(repoPath, '.genie', 'mailbox');
}

function mailboxFilePath(repoPath: string, workerId: string): string {
  return join(mailboxDir(repoPath), `${workerId}.json`);
}

// ============================================================================
// Internal
// ============================================================================

async function loadMailbox(repoPath: string, workerId: string): Promise<WorkerMailbox> {
  try {
    const content = await readFile(mailboxFilePath(repoPath, workerId), 'utf-8');
    return JSON.parse(content);
  } catch {
    return { workerId, messages: [], lastUpdated: new Date().toISOString() };
  }
}

async function saveMailbox(repoPath: string, mailbox: WorkerMailbox): Promise<void> {
  const dir = mailboxDir(repoPath);
  await mkdir(dir, { recursive: true });
  mailbox.lastUpdated = new Date().toISOString();
  await writeFile(
    mailboxFilePath(repoPath, mailbox.workerId),
    JSON.stringify(mailbox, null, 2),
  );
}

// ============================================================================
// Public API
// ============================================================================

let _messageCounter = 0;

function generateMessageId(): string {
  _messageCounter += 1;
  return `msg-${Date.now()}-${_messageCounter}`;
}

/**
 * Write a message to a worker's mailbox.
 * This persists BEFORE any delivery attempt (DEC-7).
 */
export async function send(
  repoPath: string,
  from: string,
  to: string,
  body: string,
): Promise<MailboxMessage> {
  const mailbox = await loadMailbox(repoPath, to);

  const message: MailboxMessage = {
    id: generateMessageId(),
    from,
    to,
    body,
    createdAt: new Date().toISOString(),
    read: false,
    deliveredAt: null,
  };

  mailbox.messages.push(message);
  await saveMailbox(repoPath, mailbox);

  return message;
}

/**
 * Get all messages for a worker (inbox view).
 */
export async function inbox(
  repoPath: string,
  workerId: string,
): Promise<MailboxMessage[]> {
  const mailbox = await loadMailbox(repoPath, workerId);
  return mailbox.messages;
}

/**
 * Get unread messages for a worker.
 */
export async function unread(
  repoPath: string,
  workerId: string,
): Promise<MailboxMessage[]> {
  const mailbox = await loadMailbox(repoPath, workerId);
  return mailbox.messages.filter(m => !m.read);
}

/**
 * Mark a message as read.
 */
export async function markRead(
  repoPath: string,
  workerId: string,
  messageId: string,
): Promise<boolean> {
  const mailbox = await loadMailbox(repoPath, workerId);
  const msg = mailbox.messages.find(m => m.id === messageId);
  if (!msg) return false;
  msg.read = true;
  await saveMailbox(repoPath, mailbox);
  return true;
}

/**
 * Mark a message as delivered (pane injection succeeded).
 */
export async function markDelivered(
  repoPath: string,
  workerId: string,
  messageId: string,
): Promise<boolean> {
  const mailbox = await loadMailbox(repoPath, workerId);
  const msg = mailbox.messages.find(m => m.id === messageId);
  if (!msg) return false;
  msg.deliveredAt = new Date().toISOString();
  await saveMailbox(repoPath, mailbox);
  return true;
}

/**
 * Get pending (undelivered) messages for a worker.
 * Used by the delivery loop to push queued messages.
 */
export async function pending(
  repoPath: string,
  workerId: string,
): Promise<MailboxMessage[]> {
  const mailbox = await loadMailbox(repoPath, workerId);
  return mailbox.messages.filter(m => m.deliveredAt === null);
}
