/**
 * Mailbox — Durable message store with unread/read semantics.
 *
 * Messages persist to `.genie/mailbox/<worker-id>.json` before
 * any push delivery attempt. This ensures durability (DEC-7).
 *
 * Delivery is state-aware: messages are queued and pushed to tmux
 * panes only when the worker is idle (not mid-turn).
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path, { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { NativeInboxMessage } from './claude-native-teams.js';
import { acquireLock } from './file-lock.js';

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

interface WorkerMailbox {
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
  const safeId = path.basename(workerId);
  return join(mailboxDir(repoPath), `${safeId}.json`);
}

/** Outbox JSONL file for tracking sent messages (append-only). */
export function outboxFilePath(repoPath: string, workerId: string): string {
  const safeId = path.basename(workerId);
  return join(mailboxDir(repoPath), `${safeId}-sent.jsonl`);
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
  await writeFile(mailboxFilePath(repoPath, mailbox.workerId), JSON.stringify(mailbox, null, 2));
}

// ============================================================================
// Public API
// ============================================================================

function generateMessageId(): string {
  return `msg-${uuidv4()}`;
}

/**
 * Write a message to a worker's mailbox.
 * This persists BEFORE any delivery attempt (DEC-7).
 */
export async function send(repoPath: string, from: string, to: string, body: string): Promise<MailboxMessage> {
  // Ensure mailbox directory exists before acquiring lock (lock file needs parent dir)
  await mkdir(mailboxDir(repoPath), { recursive: true });
  const release = await acquireLock(mailboxFilePath(repoPath, to));
  try {
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

    // Append to sender's outbox (append-only JSONL, no lock needed — single writer per send call)
    await appendFile(outboxFilePath(repoPath, from), `${JSON.stringify(message)}\n`);

    return message;
  } finally {
    await release();
  }
}

/**
 * Get all messages for a worker (inbox view).
 */
export async function inbox(repoPath: string, workerId: string): Promise<MailboxMessage[]> {
  const mailbox = await loadMailbox(repoPath, workerId);
  return mailbox.messages;
}

/**
 * Read sent messages from a worker's outbox (JSONL file).
 */
export async function readOutbox(repoPath: string, workerId: string): Promise<MailboxMessage[]> {
  try {
    const content = await readFile(outboxFilePath(repoPath, workerId), 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const messages: MailboxMessage[] = [];
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }
    return messages;
  } catch {
    return [];
  }
}

/**
 * Mark a message as delivered (pane injection succeeded).
 */
export async function markDelivered(repoPath: string, workerId: string, messageId: string): Promise<boolean> {
  await mkdir(mailboxDir(repoPath), { recursive: true });
  const release = await acquireLock(mailboxFilePath(repoPath, workerId));
  try {
    const mailbox = await loadMailbox(repoPath, workerId);
    const msg = mailbox.messages.find((m) => m.id === messageId);
    if (!msg) return false;
    msg.deliveredAt = new Date().toISOString();
    await saveMailbox(repoPath, mailbox);
    return true;
  } finally {
    await release();
  }
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
