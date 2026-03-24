/**
 * Protocol Router — Genie-owned message routing across providers.
 *
 * The protocol router is provider-agnostic (DEC-5). It routes
 * messages between workers regardless of whether they are backed
 * by Claude or Codex. Delivery goes through the mailbox first
 * (DEC-7) and then pushes to the tmux pane when the worker is idle.
 *
 * Resolution order (directory-first):
 *   1. Directory by name → built-in by name
 *   2. Worker registry (ID > role > team:role)
 *   3. Auto-spawn: if agent offline + in directory/registry → spawn → deliver
 *   4. Native inbox fallback
 */

import * as registry from './agent-registry.js';
import * as nativeTeams from './claude-native-teams.js';
import * as mailbox from './mailbox.js';
import { detectState } from './orchestrator/index.js';
import { capturePaneContent, executeTmux, isPaneAlive } from './tmux.js';

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
 * Resolve a recipient to live workers using strict tiered matching.
 * Priority: exact ID > role > team:role.
 * Only returns workers with alive panes (non-suspended).
 */
async function resolveRecipient(recipientId: string): Promise<registry.Agent[]> {
  const allWorkers = await registry.list();

  const byId: registry.Agent[] = [];
  const byRole: registry.Agent[] = [];
  const byTeamRole: registry.Agent[] = [];

  for (const w of allWorkers) {
    if (w.state === 'suspended') continue;
    if (!(await isPaneAlive(w.paneId))) continue;

    if (w.id === recipientId) byId.push(w);
    else if (w.role === recipientId) byRole.push(w);
    else if (`${w.team}:${w.role}` === recipientId) byTeamRole.push(w);
  }

  if (byId.length > 0) return byId;
  if (byRole.length > 0) return byRole;
  return byTeamRole;
}

/**
 * Find exactly one live worker by tiered match.
 * Returns null if zero or multiple matches (ambiguous).
 */
async function findLiveWorkerFuzzy(recipientId: string): Promise<registry.Agent | null> {
  const matches = await resolveRecipient(recipientId);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Ensure a worker is alive, auto-spawning from template if needed.
 * Handles suspended workers by resuming with --resume <session-id>.
 */
async function ensureWorkerAlive(
  worker: registry.Agent | null,
  recipientId: string,
): Promise<{ worker: registry.Agent; respawned: boolean } | null> {
  if (worker && worker.state !== 'suspended' && (await isPaneAlive(worker.paneId))) {
    return { worker, respawned: false };
  }

  // Always check for a live worker before attempting to spawn — prevents
  // duplicate spawns when the registry entry is stale/dead but another
  // instance with the same role is already alive.
  const live = await findLiveWorkerFuzzy(recipientId);
  if (live) return { worker: live, respawned: false };

  if (!process.env.TMUX) return null;

  const templates = await registry.listTemplates();
  const candidates = [worker?.role, worker?.id, recipientId].filter((v): v is string => Boolean(v));
  const uniqueCandidates = [...new Set(candidates)];
  const workerTeam = worker?.team;
  const template = templates.find((t) => {
    // Only match templates from the same team to prevent cross-team contamination
    if (workerTeam && t.team !== workerTeam) return false;
    return uniqueCandidates.some((q) => t.id === q || t.role === q || `${t.team}:${t.role}` === q);
  });
  if (!template) return null;

  // Use stored Claude session ID for --resume (session-id based, not name-based).
  // Falls back to undefined (fresh session) if no prior session ID exists.
  const resumeSessionId =
    template.provider === 'claude' && worker?.claudeSessionId ? worker.claudeSessionId : undefined;

  try {
    // Clean up ghost worker entries (dead panes) for this role before spawning
    await cleanupDeadWorkers(recipientId, workerTeam);

    if (worker) {
      await registry.unregister(worker.id);
    }

    const { spawnWorkerFromTemplate } = await import('./protocol-router-spawn.js');
    const result = await spawnWorkerFromTemplate(template, resumeSessionId);

    await registry.saveTemplate({
      ...template,
      lastSpawnedAt: new Date().toISOString(),
    });

    await waitForWorkerReady(result.paneId);

    // Verify the pane survived startup — if Claude exited (e.g. stale resume
    // or startup error), the pane is dead and delivery would silently fail.
    if (!(await isPaneAlive(result.paneId))) {
      await registry.unregister(result.worker.id);
      return null;
    }

    return { worker: result.worker, respawned: true };
  } catch {
    return null;
  }
}

/**
 * Remove dead worker entries matching a role/ID to prevent ghost accumulation.
 * Only removes workers whose tmux panes are no longer alive.
 */
async function cleanupDeadWorkers(recipientId: string, team?: string): Promise<void> {
  const allWorkers = await registry.list();
  for (const w of allWorkers) {
    if (team && w.team !== team) continue;
    const matches = w.role === recipientId || w.id === recipientId;
    if (!matches) continue;
    if (await isPaneAlive(w.paneId)) continue;
    await registry.unregister(w.id);
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
  worker: registry.Agent,
  body: string,
): Promise<DeliveryResult> {
  const message = await mailbox.send(repoPath, from, worker.id, body);

  let delivered = false;

  // Primary delivery path
  if (worker.nativeTeamEnabled && worker.team && worker.role) {
    delivered = await writeToNativeInbox(worker, message);
  } else {
    delivered = await injectToTmuxPane(worker, message);
  }

  // Fallback: if primary delivery failed but worker has a team, try native inbox
  if (!delivered && worker.team) {
    const agentName = worker.role || worker.id.split('-').slice(-1)[0] || worker.id;
    try {
      const nativeMsg = mailbox.toNativeInboxMessage(message, worker.nativeColor ?? 'blue');
      await nativeTeams.writeNativeInbox(worker.team, agentName, nativeMsg);
      delivered = true;
    } catch {
      // Fallback failed too — non-fatal
    }
  }

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

  // Verify the recipient exists as a registered native team member.
  // Match by: exact name, agentId, or role extracted from team-prefixed worker ID
  // e.g., worker ID "sofia-50ju-engineer" should match member name "engineer"
  const config = await nativeTeams.loadConfig(resolvedTeam).catch(() => null);
  if (!config) return null;
  const sanitizedTo = nativeTeams.sanitizeTeamName(to);
  const matchedMember = config.members?.find(
    (m: { name?: string; agentId?: string }) =>
      m.name === to ||
      m.name === sanitizedTo ||
      m.agentId === `${to}@${resolvedTeam}` ||
      m.agentId === `${sanitizedTo}@${resolvedTeam}`,
  );
  if (!matchedMember) return null;

  // Use the member's registered name for inbox writing (not the raw worker ID),
  // so we write to "engineer.json" instead of "sofia-50ju-engineer.json"
  const inboxName = matchedMember.name ?? to;

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
    await nativeTeams.writeNativeInbox(resolvedTeam, inboxName, nativeMsg);
    await mailbox.markDelivered(repoPath, to, message.id);
    return { messageId: message.id, workerId: to, delivered: true };
  } catch {
    return null;
  }
}

/**
 * Send a message to a recipient using directory-first resolution.
 *
 * Resolution order:
 *   1. Live workers (ID > role > team:role)
 *   2. Agent directory + worker registry → auto-spawn from template
 *   3. Native team inbox fallback
 */
export async function sendMessage(
  repoPath: string,
  from: string,
  to: string,
  body: string,
  teamName?: string,
): Promise<DeliveryResult> {
  // 1. Find live workers using strict tiered matching (ID > role > team:role)
  const liveMatches = await resolveRecipient(to);

  if (liveMatches.length === 1) {
    return deliverToWorker(repoPath, from, liveMatches[0], body);
  }

  if (liveMatches.length > 1) {
    return {
      messageId: '',
      workerId: to,
      delivered: false,
      reason: `Worker "${to}" is ambiguous. Found ${liveMatches.length} live matches: ${liveMatches.map((m) => m.id).join(', ')}. Use exact worker ID.`,
    };
  }

  // 2. No live match — directory-first resolution for auto-spawn
  // Check agent directory to validate recipient exists (enables spawn for
  // agents registered in directory but not yet spawned in this session).
  const { resolve } = await import('./agent-directory.js');
  const dirResolved = await resolve(to);

  // Also check worker registry for session context (provides claudeSessionId for --resume)
  let worker = await registry.get(to);
  if (!worker) {
    const allWorkers = await registry.list();
    // Prefer suspended workers (they have valid sessions to resume)
    worker =
      allWorkers.find((w) => w.role === to && w.state === 'suspended') ?? allWorkers.find((w) => w.role === to) ?? null;
  }

  // Try auto-spawn if agent is known via directory OR registry
  if (dirResolved || worker) {
    const alive = await ensureWorkerAlive(worker, to);
    if (alive) {
      return deliverToWorker(repoPath, from, alive.worker, body);
    }
  }

  // 3. Fallback: try native team inbox for agents not in worker registry
  const nativeResult = await deliverViaNativeInbox(repoPath, from, to, body, teamName);
  if (nativeResult) return nativeResult;

  return { messageId: '', workerId: to, delivered: false, reason: `Worker "${to}" not found or not alive` };
}

/**
 * Write a Genie mailbox message to the Claude Code native inbox.
 * Best-effort — failures here don't block the Genie mailbox write.
 */
async function writeToNativeInbox(worker: registry.Agent, message: mailbox.MailboxMessage): Promise<boolean> {
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
async function injectToTmuxPane(worker: registry.Agent, message: mailbox.MailboxMessage): Promise<boolean> {
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
