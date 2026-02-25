/**
 * Protocol Router — Genie-owned message routing across providers.
 *
 * The protocol router is provider-agnostic (DEC-5). It routes
 * messages between workers regardless of whether they are backed
 * by Claude or Codex. Delivery goes through the mailbox first
 * (DEC-7) and then pushes to the tmux pane when the worker is idle.
 */

import * as mailbox from './mailbox.js';
import * as registry from './worker-registry.js';

// ============================================================================
// Types
// ============================================================================

export interface DeliveryResult {
  messageId: string;
  workerId: string;
  delivered: boolean;
  reason?: string;
}

// ============================================================================
// Delivery
// ============================================================================

/**
 * Send a message to a worker. The message is persisted to the
 * mailbox BEFORE any delivery attempt.
 *
 * @param repoPath — Repository root path for mailbox storage.
 * @param from — Sender ID ("operator" for human messages).
 * @param to — Recipient worker ID.
 * @param body — Message body text.
 * @returns Delivery result with message ID.
 */
export async function sendMessage(
  repoPath: string,
  from: string,
  to: string,
  body: string,
): Promise<DeliveryResult> {
  // 1. Verify recipient exists in registry
  const worker = await registry.get(to);
  if (!worker) {
    // Try finding by fuzzy match (team:role pattern)
    const allWorkers = await registry.list();
    const match = allWorkers.find(w =>
      w.id === to || w.role === to || `${w.team}:${w.role}` === to
    );

    if (!match) {
      return {
        messageId: '',
        workerId: to,
        delivered: false,
        reason: `Worker "${to}" not found in registry`,
      };
    }

    // Use the matched worker
    const message = await mailbox.send(repoPath, from, match.id, body);
    return {
      messageId: message.id,
      workerId: match.id,
      delivered: true,
    };
  }

  // 2. Persist to mailbox first (DEC-7)
  const message = await mailbox.send(repoPath, from, to, body);

  return {
    messageId: message.id,
    workerId: to,
    delivered: true,
  };
}

/**
 * Attempt to push pending messages to a worker's tmux pane.
 * Called when a worker transitions to idle state.
 *
 * This is a no-op placeholder — actual tmux injection would require
 * the tmux library. The delivery attempt is recorded in the mailbox.
 */
export async function flushPending(
  repoPath: string,
  workerId: string,
): Promise<DeliveryResult[]> {
  const messages = await mailbox.pending(repoPath, workerId);
  const results: DeliveryResult[] = [];

  for (const msg of messages) {
    // Mark as delivered (actual tmux injection would happen here)
    await mailbox.markDelivered(repoPath, workerId, msg.id);
    results.push({
      messageId: msg.id,
      workerId,
      delivered: true,
    });
  }

  return results;
}

/**
 * Get the inbox for a worker (all messages, with read/unread status).
 */
export async function getInbox(
  repoPath: string,
  workerId: string,
): Promise<mailbox.MailboxMessage[]> {
  return mailbox.inbox(repoPath, workerId);
}

/**
 * Get unread message count for a worker.
 */
export async function unreadCount(
  repoPath: string,
  workerId: string,
): Promise<number> {
  const messages = await mailbox.unread(repoPath, workerId);
  return messages.length;
}
