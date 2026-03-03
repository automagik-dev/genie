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
  teamName?: string,
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
      // Fallback: try writing directly to native team inbox
      // This supports sending to team-lead or other agents not in the worker registry
      const resolvedTeam = teamName ?? await nativeTeams.discoverTeamName();
      if (resolvedTeam) {
        try {
          // Persist to mailbox first (DEC-7) even for native-only delivery
          const message = await mailbox.send(repoPath, from, to, body);
          const nativeMsg: nativeTeams.NativeInboxMessage = {
            from,
            text: body,
            summary: body.length > 50 ? `${body.substring(0, 50)}...` : body,
            timestamp: new Date().toISOString(),
            color: 'blue',
            read: false,
          };
          await nativeTeams.writeNativeInbox(resolvedTeam, to, nativeMsg);
          await mailbox.markDelivered(repoPath, to, message.id);
          return {
            messageId: message.id,
            workerId: to,
            delivered: true,
          };
        } catch {
          // Native inbox write failed — fall through to error
        }
      }

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
    let delivered = false;
    if (match.nativeTeamEnabled && match.team && match.role) {
      delivered = await writeToNativeInbox(match, message);
    } else {
      delivered = await injectToTmuxPane(match, message);
    }

    if (delivered) {
      await mailbox.markDelivered(repoPath, match.id, message.id);
    }

    return {
      messageId: message.id,
      workerId: match.id,
      delivered,
    };
  }

  // 2. Persist to mailbox first (DEC-7)
  const message = await mailbox.send(repoPath, from, to, body);

  // 3. Deliver based on worker type
  let delivered = false;
  if (worker.nativeTeamEnabled && worker.team && worker.role) {
    delivered = await writeToNativeInbox(worker, message);
  } else {
    delivered = await injectToTmuxPane(worker, message);
  }

  if (delivered) {
    await mailbox.markDelivered(repoPath, to, message.id);
  }

  return {
    messageId: message.id,
    workerId: to,
    delivered,
  };
}

/**
 * Write a Genie mailbox message to the Claude Code native inbox.
 * Best-effort — failures here don't block the Genie mailbox write.
 */
async function writeToNativeInbox(
  worker: registry.Worker,
  message: mailbox.MailboxMessage,
): Promise<boolean> {
  try {
    const nativeMsg = mailbox.toNativeInboxMessage(
      message,
      worker.nativeColor ?? 'blue',
    );
    const agentName = worker.role ?? worker.id;
    await nativeTeams.writeNativeInbox(worker.team!, agentName, nativeMsg);
    return true;
  } catch {
    // Best-effort — native inbox write failure is non-fatal
    return false;
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
): Promise<boolean> {
  if (!worker.paneId) return false;

  // Validate paneId to prevent shell injection
  if (!/^%\d+$/.test(worker.paneId)) return false;

  try {
    // Escape single quotes for shell embedding
    const escaped = message.body.replace(/'/g, "'\\''");
    // Send text first, then Enter after a short delay so the pane can process the input
    await executeTmux(`send-keys -t '${worker.paneId}' '${escaped}'`);
    await new Promise(resolve => setTimeout(resolve, 200));
    await executeTmux(`send-keys -t '${worker.paneId}' Enter`);
    return true;
  } catch {
    // Best-effort — pane may be dead or busy
    return false;
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
    let delivered = false;

    if (worker) {
      if (worker.nativeTeamEnabled && worker.team && worker.role) {
        delivered = await writeToNativeInbox(worker, msg);
      } else if (worker.paneId) {
        delivered = await injectToTmuxPane(worker, msg);
      }
    }

    if (delivered) {
      await mailbox.markDelivered(repoPath, workerId, msg.id);
    }

    results.push({
      messageId: msg.id,
      workerId,
      delivered,
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
