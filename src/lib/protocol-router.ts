/**
 * Protocol Router — Genie-owned message routing across providers.
 *
 * The protocol router is provider-agnostic (DEC-5). It routes
 * messages between workers regardless of whether they are backed
 * by Claude or Codex. Delivery goes through the mailbox first
 * (DEC-7) and then pushes to the tmux pane when the worker is idle.
 */

import * as nativeTeams from './claude-native-teams.js';
import * as mailbox from './mailbox.js';
import { detectState } from './orchestrator/index.js';
import { capturePaneContent, executeTmux, isPaneAlive } from './tmux.js';
import * as registry from './worker-registry.js';

// ============================================================================
// Types
// ============================================================================

interface DeliveryResult {
  messageId: string;
  workerId: string;
  delivered: boolean;
  reason?: string;
}

// ============================================================================
// Auto-Spawn Helpers
// ============================================================================

/** Max time (ms) to wait for a freshly-spawned worker to reach idle. */
const AUTO_SPAWN_READY_TIMEOUT_MS = 15000;
/** Polling interval (ms) while waiting for worker readiness. */
const AUTO_SPAWN_POLL_INTERVAL_MS = 1000;

async function waitForWorkerReady(paneId: string, timeoutMs = AUTO_SPAWN_READY_TIMEOUT_MS): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const content = await capturePaneContent(paneId, 30);
      const state = detectState(content);
      if (state.type === 'idle') return true;
    } catch {
      /* pane not ready yet */
    }
    await new Promise((r) => setTimeout(r, AUTO_SPAWN_POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Find an existing live (non-suspended, pane alive) worker by fuzzy match.
 * Used when registry.get() misses because the recipient is a role name.
 */
async function findLiveWorkerFuzzy(recipientId: string): Promise<registry.Worker | null> {
  const allWorkers = await registry.list();
  for (const w of allWorkers) {
    if (w.state === 'suspended') continue;
    const matches = w.id === recipientId || w.role === recipientId || `${w.team}:${w.role}` === recipientId;
    if (matches && (await isPaneAlive(w.paneId))) return w;
  }
  return null;
}

/**
 * Ensure a worker is alive, auto-spawning from template if needed.
 * Handles suspended workers by resuming with --resume flag.
 */
async function ensureWorkerAlive(
  worker: registry.Worker | null,
  recipientId: string,
): Promise<{ worker: registry.Worker; respawned: boolean } | null> {
  if (worker && worker.state !== 'suspended' && (await isPaneAlive(worker.paneId))) {
    return { worker, respawned: false };
  }

  // When worker is null (fuzzy recipient like a role name), check if there's
  // already a live worker matching the recipientId before attempting to spawn.
  if (!worker) {
    const live = await findLiveWorkerFuzzy(recipientId);
    if (live) return { worker: live, respawned: false };
  }

  if (!process.env.TMUX) return null;

  const templates = await registry.listTemplates();
  const candidates = [worker?.role, worker?.id, recipientId].filter((v): v is string => Boolean(v));
  const uniqueCandidates = [...new Set(candidates)];
  const template = templates.find((t) =>
    uniqueCandidates.some((q) => t.id === q || t.role === q || `${t.team}:${t.role}` === q),
  );
  if (!template) return null;

  const resumeSessionId =
    template.provider === 'claude' ? (worker?.claudeSessionId ?? template.lastSessionId) : undefined;

  try {
    if (worker) {
      await registry.unregister(worker.id);
    }

    const { spawnWorkerFromTemplate } = await import('./protocol-router-spawn.js');
    const result = await spawnWorkerFromTemplate(template, resumeSessionId);

    await registry.saveTemplate({
      ...template,
      lastSpawnedAt: new Date().toISOString(),
      lastSessionId: result.worker.claudeSessionId,
    });

    await waitForWorkerReady(result.paneId);

    return { worker: result.worker, respawned: true };
  } catch {
    return null;
  }
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
async function deliverToWorker(
  repoPath: string,
  from: string,
  worker: registry.Worker,
  body: string,
): Promise<DeliveryResult> {
  const message = await mailbox.send(repoPath, from, worker.id, body);
  const delivered =
    worker.nativeTeamEnabled && worker.team && worker.role
      ? await writeToNativeInbox(worker, message)
      : await injectToTmuxPane(worker, message);
  if (delivered) await mailbox.markDelivered(repoPath, worker.id, message.id);
  return { messageId: message.id, workerId: worker.id, delivered };
}

async function deliverViaNativeInbox(
  repoPath: string,
  from: string,
  to: string,
  body: string,
  teamName?: string,
): Promise<DeliveryResult | null> {
  const resolvedTeam = teamName ?? (await nativeTeams.discoverTeamName());
  if (!resolvedTeam) return null;

  try {
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
    return { messageId: message.id, workerId: to, delivered: true };
  } catch {
    return null;
  }
}

async function resolveWorkerFuzzy(to: string): Promise<registry.Worker[] | null> {
  const allWorkers = await registry.list();
  return allWorkers.filter((w) => w.id === to || w.role === to || `${w.team}:${w.role}` === to);
}

export async function sendMessage(
  repoPath: string,
  from: string,
  to: string,
  body: string,
  teamName?: string,
): Promise<DeliveryResult> {
  let worker = await registry.get(to);
  const alive = await ensureWorkerAlive(worker, to);
  if (alive?.respawned) worker = alive.worker;

  if (worker) {
    return deliverToWorker(repoPath, from, worker, body);
  }

  const matches = await resolveWorkerFuzzy(to);
  if (matches && matches.length > 1) {
    return {
      messageId: '',
      workerId: to,
      delivered: false,
      reason: `Worker "${to}" is ambiguous. Found ${matches.length} matches: ${matches.map((m) => m.id).join(', ')}. Please use a unique worker ID.`,
    };
  }

  const match = matches?.[0];
  if (match) {
    return deliverToWorker(repoPath, from, match, body);
  }

  // Fallback: try native team inbox for agents not in worker registry
  const nativeResult = await deliverViaNativeInbox(repoPath, from, to, body, teamName);
  if (nativeResult) return nativeResult;

  return { messageId: '', workerId: to, delivered: false, reason: `Worker "${to}" not found in registry` };
}

/**
 * Write a Genie mailbox message to the Claude Code native inbox.
 * Best-effort — failures here don't block the Genie mailbox write.
 */
async function writeToNativeInbox(worker: registry.Worker, message: mailbox.MailboxMessage): Promise<boolean> {
  try {
    const nativeMsg = mailbox.toNativeInboxMessage(message, worker.nativeColor ?? 'blue');
    const agentName = worker.role ?? worker.id;
    await nativeTeams.writeNativeInbox(worker.team ?? '', agentName, nativeMsg);
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
async function injectToTmuxPane(worker: registry.Worker, message: mailbox.MailboxMessage): Promise<boolean> {
  if (!worker.paneId) return false;

  // Validate paneId to prevent shell injection
  if (!/^%\d+$/.test(worker.paneId)) return false;

  try {
    // Escape single quotes for shell embedding
    const escaped = message.body.replace(/'/g, "'\\''");
    // Send text first, then Enter after a short delay so the pane can process the input
    await executeTmux(`send-keys -t '${worker.paneId}' '${escaped}'`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await executeTmux(`send-keys -t '${worker.paneId}' Enter`);
    return true;
  } catch {
    // Best-effort — pane may be dead or busy
    return false;
  }
}

/**
 * Get the inbox for a worker (all messages, with read/unread status).
 */
export async function getInbox(repoPath: string, workerId: string): Promise<mailbox.MailboxMessage[]> {
  return mailbox.inbox(repoPath, workerId);
}
