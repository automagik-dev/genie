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
import * as nativeTeams from './claude-native-teams.js';
import { executeTmux } from './tmux.js';

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
    const matches = allWorkers.filter(w =>
      w.id === to || w.role === to || `${w.team}:${w.role}` === to
    );

    if (matches.length > 1) {
      return {
        messageId: '',
        workerId: to,
        delivered: false,
        reason: `Worker "${to}" is ambiguous. Found ${matches.length} matches: ${matches.map(m => m.id).join(', ')}. Please use a unique worker ID.`,
      };
    }

    const match = matches[0];

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

    // Deliver based on worker type
    if (match.nativeTeamEnabled && match.team && match.role) {
      await writeToNativeInbox(match, message);
    } else {
      await injectToTmuxPane(match, message);
    }

    return {
      messageId: message.id,
      workerId: match.id,
      delivered: true,
    };
  }

  // 2. Persist to mailbox first (DEC-7)
  const message = await mailbox.send(repoPath, from, to, body);

  // 3. Deliver based on worker type
  if (worker.nativeTeamEnabled && worker.team && worker.role) {
    await writeToNativeInbox(worker, message);
  } else {
    await injectToTmuxPane(worker, message);
  }

  return {
    messageId: message.id,
    workerId: to,
    delivered: true,
  };
}

/**
 * Write a Genie mailbox message to the Claude Code native inbox.
 * Best-effort — failures here don't block the Genie mailbox write.
 */
async function writeToNativeInbox(
  worker: registry.Worker,
  message: mailbox.MailboxMessage,
): Promise<void> {
  try {
    const nativeMsg = mailbox.toNativeInboxMessage(
      message,
      worker.nativeColor ?? 'blue',
    );
    const agentName = worker.role ?? worker.id;
    await nativeTeams.writeNativeInbox(worker.team!, agentName, nativeMsg);
  } catch {
    // Best-effort — native inbox write failure is non-fatal
  }
}

/**
 * Inject a message into a worker's tmux pane via send-keys.
 * Used for non-native workers (e.g., Codex) that don't have
 * Claude Code's inbox polling. Best-effort — failures are non-fatal.
 */
async function injectToTmuxPane(
  worker: registry.Worker,
  message: mailbox.MailboxMessage,
): Promise<void> {
  if (!worker.paneId) return;

  try {
    // Escape single quotes for shell embedding
    const escaped = message.body.replace(/'/g, "'\\''");
    // Send text first, then Enter after a short delay so the pane can process the input
    await executeTmux(`send-keys -t '${worker.paneId}' '${escaped}'`);
    await new Promise(resolve => setTimeout(resolve, 200));
    await executeTmux(`send-keys -t '${worker.paneId}' Enter`);
  } catch {
    // Best-effort — pane may be dead or busy
  }
}

/**
 * Attempt to push pending messages to a worker's tmux pane.
 * Called when a worker transitions to idle state.
 * For non-native workers, injects via tmux send-keys.
 */
export async function flushPending(
  repoPath: string,
  workerId: string,
): Promise<DeliveryResult[]> {
  const messages = await mailbox.pending(repoPath, workerId);
  if (messages.length === 0) return [];

  const worker = await registry.get(workerId);
  const results: DeliveryResult[] = [];

  for (const msg of messages) {
    // Inject into tmux pane for non-native workers
    if (worker && !worker.nativeTeamEnabled && worker.paneId) {
      await injectToTmuxPane(worker, msg);
    }

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
