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
import { getConnection } from './db.js';
import { findExecutorByPane, getCurrentExecutor } from './executor-registry.js';
import * as mailbox from './mailbox.js';
import { detectState } from './orchestrator/index.js';
import { shouldResume } from './should-resume.js';
import { waitForExecutorReady } from './spawn-command.js';
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

/**
 * Raised when resume was explicitly requested (a prior Claude worker is on
 * record) but the executor row has no `claudeSessionId`. Historically this
 * was silently substituted for `undefined`, which caused a fresh CC session
 * to spawn and lose the worker's conversation history. Gap C from
 * trace-stale-resume (task #6).
 *
 * Callers that catch this should surface the error to the operator instead
 * of quietly proceeding with a fresh spawn.
 *
 * `reason` names which precondition failed:
 *   - `no_executor`   — agent has no `current_executor_id` (never spawned, or row pruned)
 *   - `null_session`  — executor row exists but `claude_session_id` is null
 *   - `no_session_id` — legacy alias kept for callers that read `agent.claudeSessionId`
 *                       directly before Group 1's single-reader helper lands.
 */
export type MissingResumeSessionReason = 'no_executor' | 'null_session' | 'no_session_id';

export class MissingResumeSessionError extends Error {
  readonly workerId: string;
  readonly entityId: string;
  readonly recipientId?: string;
  readonly reason: MissingResumeSessionReason;

  constructor(workerId: string, recipientId?: string, reason: MissingResumeSessionReason = 'null_session') {
    const suffix = recipientId ? ` (recipient "${recipientId}")` : '';
    super(
      `Cannot resume worker "${workerId}"${suffix}: executor has no claude_session_id recorded (reason: ${reason}). This usually means the worker predates the session-sync hook. Run \`genie reset ${workerId}\` or re-spawn the worker to recover.`,
    );
    this.name = 'MissingResumeSessionError';
    this.workerId = workerId;
    this.entityId = workerId;
    this.recipientId = recipientId;
    this.reason = reason;
  }
}

// ============================================================================
// Dependency injection (testability without mock.module)
// ============================================================================

/** Overridable deps for testing — avoids mock.module which leaks across test files in bun. */
export const _deps = {
  isPaneAlive: isPaneAlive as (paneId: string) => Promise<boolean>,
  waitForWorkerReady: null as null | ((paneId: string, timeoutMs?: number) => Promise<boolean>),
};

// ============================================================================
// Auto-Spawn Helpers
// ============================================================================

/** Max time (ms) to wait for a freshly-spawned worker to reach idle. */
const AUTO_SPAWN_READY_TIMEOUT_MS = 15000;
/** Polling interval (ms) while waiting for worker readiness. */
const AUTO_SPAWN_POLL_INTERVAL_MS = 1000;

async function waitForWorkerReady(paneId: string, timeoutMs = AUTO_SPAWN_READY_TIMEOUT_MS): Promise<boolean> {
  // Try PG-based readiness detection first (faster, cross-process)
  try {
    const executor = await findExecutorByPane(paneId);
    if (executor && executor.state !== 'terminated' && executor.state !== 'error') {
      const result = await waitForExecutorReady(executor.id, { timeoutMs });
      if (result.ready) return true;
      // PG readiness timed out — fall through to tmux scraping as safety net
    }
  } catch {
    // PG unavailable — fall through to tmux scraping
  }

  // Fallback: original tmux pane scraping
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

/** Check if a worker's last executor completed intentionally (done/terminated). */
async function isExecutorCompleted(worker: registry.Agent | null): Promise<boolean> {
  if (!worker?.currentExecutorId) return false;
  const executor = await getCurrentExecutor(worker.id);
  return executor != null && (executor.state === 'done' || executor.state === 'terminated');
}

/**
 * Check if a worker's last executor is in a state that implies the session is
 * still supposed to be alive (i.e., the pane dying was transient, not
 * logical completion). Used to detect explicit resume intent for Gap C.
 */
async function isExecutorResumable(worker: registry.Agent): Promise<boolean> {
  if (!worker.currentExecutorId) return false;
  const executor = await getCurrentExecutor(worker.id);
  if (!executor) return false;
  // Terminal states (done / error / terminated) mean resume is not expected —
  // fresh spawn is fine. Any other state (spawning, running, idle, working,
  // permission, question) implies the worker was mid-task.
  return !['done', 'error', 'terminated'].includes(executor.state);
}

/** Check if a worker is in a dead state (suspended/terminated/offline). */
async function isWorkerDead(w: registry.Agent): Promise<boolean> {
  if (w.currentExecutorId) {
    const state = await registry.getAgentEffectiveState(w.id);
    return state === 'terminated' || state === 'offline';
  }
  return w.state === 'suspended';
}

/**
 * Resolve a recipient to live workers using strict tiered matching.
 * Priority: exact ID > role > team:role.
 * Only returns workers with alive panes (non-suspended/terminated).
 */
async function resolveRecipient(recipientId: string): Promise<registry.Agent[]> {
  const allWorkers = await registry.list();

  const byId: registry.Agent[] = [];
  const byRole: registry.Agent[] = [];
  const byTeamRole: registry.Agent[] = [];

  for (const w of allWorkers) {
    if (await isWorkerDead(w)) continue;
    if (!(await _deps.isPaneAlive(w.paneId))) continue;

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
/** Find a matching spawn template for the worker/recipient. */
async function findSpawnTemplate(
  worker: registry.Agent | null,
  recipientId: string,
): Promise<registry.WorkerTemplate | null> {
  const templates = await registry.listTemplates();
  const candidates = [worker?.role, worker?.id, recipientId].filter((v): v is string => Boolean(v));
  const uniqueCandidates = [...new Set(candidates)];
  const workerTeam = worker?.team;
  return (
    templates.find((t) => {
      if (workerTeam && t.team !== workerTeam) return false;
      return uniqueCandidates.some((q) => t.id === q || t.role === q || `${t.team}:${t.role}` === q);
    }) ?? null
  );
}

/** Attempt to spawn a worker from template inside an advisory-locked transaction. */
async function lockedSpawnWorker(
  recipientId: string,
  worker: registry.Agent | null,
  template: registry.WorkerTemplate,
  resumeSessionId: string | undefined,
): Promise<{ worker: registry.Agent; respawned: boolean } | null> {
  const sql = await getConnection();
  const workerTeam = worker?.team;

  const lockResult = await sql.begin(async (tx: typeof sql) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${recipientId}))`;

    // Double-check: another process may have spawned while we waited for the lock
    const postLockLive = await findLiveWorkerFuzzy(recipientId);
    if (postLockLive) return { type: 'existing' as const, worker: postLockLive };

    await cleanupDeadWorkers(recipientId, workerTeam);
    if (worker) await registry.unregister(worker.id);

    const { spawnWorkerFromTemplate } = await import('./protocol-router-spawn.js');
    const spawnResult = await spawnWorkerFromTemplate(template, resumeSessionId);
    return { type: 'spawned' as const, ...spawnResult };
  });

  if (lockResult.type === 'existing') return { worker: lockResult.worker, respawned: false };

  await registry.saveTemplate({ ...template, lastSpawnedAt: new Date().toISOString() });

  const readyCheck = _deps.waitForWorkerReady ?? waitForWorkerReady;
  await readyCheck(lockResult.paneId);

  if (!(await _deps.isPaneAlive(lockResult.paneId))) {
    await registry.unregister(lockResult.worker.id);
    return null;
  }

  return { worker: lockResult.worker, respawned: true };
}

/**
 * Decide whether this call is an explicit resume request. Claude workers
 * whose last executor is in a non-terminal state (spawning/running/idle/
 * working/permission/question) are mid-task — we MUST resume them with
 * their session id. Silently spawning fresh would drop the conversation
 * history. Master agents (`kind='permanent'`, `dir:<name>` rows) lose
 * their runtime worker on reboot but retain a recoverable session UUID
 * via the chokepoint; probing `dir:<recipientId>` when no live worker
 * exists keeps team-lead "hires" on the master's persistent session
 * instead of forking a fresh UUID and orphaning conversation history.
 * Ephemeral spawns have no `dir:<name>` row, so the chokepoint returns
 * `unknown_agent` and the caller proceeds with a fresh `--session-id`.
 * Gap C from trace-stale-resume (task #6) + master-aware-spawn Group 1.
 */
export async function resolveResumeSessionId(
  worker: registry.Agent | null,
  template: registry.WorkerTemplate,
  recipientId: string,
): Promise<string | undefined> {
  if (template.provider !== 'claude') return undefined;
  const agentIdToProbe = worker?.id ?? `dir:${recipientId}`;
  const decision = await shouldResume(agentIdToProbe);
  if (worker && (await isExecutorResumable(worker))) {
    if (!decision.sessionId) throw new MissingResumeSessionError(worker.id, recipientId);
  }
  return decision.sessionId;
}

async function handleSpawnError(err: unknown, worker: registry.Agent | null, recipientId: string): Promise<null> {
  if (err instanceof MissingResumeSessionError) throw err;
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[protocol-router] Spawn failed for "${recipientId}": ${msg}`);
  if (worker) {
    await registry.update(worker.id, { state: 'error' }).catch(() => {});
  }
  return null;
}

async function ensureWorkerAlive(
  worker: registry.Agent | null,
  recipientId: string,
): Promise<{ worker: registry.Agent; respawned: boolean } | null> {
  if (worker && worker.state !== 'suspended' && (await _deps.isPaneAlive(worker.paneId))) {
    return { worker, respawned: false };
  }

  const live = await findLiveWorkerFuzzy(recipientId);
  if (live) return { worker: live, respawned: false };

  if (await isExecutorCompleted(worker)) return null;
  if (!process.env.TMUX) return null;

  const template = await findSpawnTemplate(worker, recipientId);
  if (!template) return null;

  const resumeSessionId = await resolveResumeSessionId(worker, template, recipientId);

  try {
    return await lockedSpawnWorker(recipientId, worker, template, resumeSessionId);
  } catch (err) {
    return handleSpawnError(err, worker, recipientId);
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
    if (await _deps.isPaneAlive(w.paneId)) continue;
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

  if (delivered) {
    await mailbox.markDelivered(repoPath, worker.id, message.id);
  } else {
    console.error(
      `[protocol-router] Delivery failed: all paths exhausted (worker=${worker.id}, pane=${worker.paneId}, msg="${body.slice(0, 50)}")`,
    );
  }
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
// Re-verify pane alive right before delivery — catches TOCTOU race where the
// pane dies between resolution (resolveRecipient / ensureWorkerAlive) and the
// actual injection call.
async function deliverAfterPaneRecheck(
  repoPath: string,
  from: string,
  worker: registry.Agent,
  body: string,
  paneDeadReason: string,
): Promise<DeliveryResult> {
  if (!(await _deps.isPaneAlive(worker.paneId))) {
    const message = await mailbox.send(repoPath, from, worker.id, body);
    console.error(
      `[protocol-router] Delivery failed: ${paneDeadReason} (worker=${worker.id}, msg="${body.slice(0, 50)}")`,
    );
    return { messageId: message.id, workerId: worker.id, delivered: false, reason: paneDeadReason };
  }
  return deliverToWorker(repoPath, from, worker, body);
}

async function findKnownWorker(to: string): Promise<registry.Agent | null> {
  const worker = await registry.get(to);
  if (worker) return worker;
  const allWorkers = await registry.list();
  // Prefer suspended workers (they have valid sessions to resume)
  return (
    allWorkers.find((w) => w.role === to && w.state === 'suspended') ?? allWorkers.find((w) => w.role === to) ?? null
  );
}

async function attemptAutoSpawnDelivery(
  repoPath: string,
  from: string,
  to: string,
  body: string,
  worker: registry.Agent | null,
): Promise<DeliveryResult | null> {
  let alive: { worker: registry.Agent; respawned: boolean } | null;
  try {
    alive = await ensureWorkerAlive(worker, to);
  } catch (err) {
    // Resume was explicitly requested but the session id is missing.
    // Surface the error loudly so the operator can recover (genie reset /
    // re-spawn). Gap C from trace-stale-resume (task #6).
    if (err instanceof MissingResumeSessionError) {
      console.error(`[protocol-router] ${err.message}`);
      return { messageId: '', workerId: worker?.id ?? to, delivered: false, reason: err.message };
    }
    throw err;
  }
  if (!alive) return null;
  return deliverAfterPaneRecheck(repoPath, from, alive.worker, body, 'pane dead after spawn');
}

export async function sendMessage(
  repoPath: string,
  from: string,
  to: string,
  body: string,
  teamName?: string,
): Promise<DeliveryResult> {
  // Self-delivery guard: suppress messages where sender === recipient.
  // Without this, the message lands in the sender's own native inbox and
  // Claude Code surfaces it as an incoming teammate message, wasting turns
  // and risking infinite echo loops. (See #818)
  if (from === to) {
    return { messageId: '', workerId: to, delivered: true, reason: 'Self-delivery suppressed' };
  }

  // 1. Find live workers using strict tiered matching (ID > role > team:role)
  const liveMatches = await resolveRecipient(to);
  if (liveMatches.length === 1) {
    return deliverAfterPaneRecheck(repoPath, from, liveMatches[0], body, 'Pane died before delivery');
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
  const { resolve } = await import('./agent-directory.js');
  const dirResolved = await resolve(to);
  const worker = await findKnownWorker(to);

  if (dirResolved || worker) {
    const result = await attemptAutoSpawnDelivery(repoPath, from, to, body, worker);
    if (result) return result;
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

  // Re-verify pane alive immediately before injection — tmux send-keys can
  // succeed on dead panes without error, producing a false delivery success.
  if (!(await _deps.isPaneAlive(worker.paneId))) return false;

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
 * Attempt instant pane delivery for a specific message.
 * Used by the scheduler daemon's PG LISTEN/NOTIFY handler to push
 * messages into tmux panes without waiting for the next poll cycle.
 *
 * Returns true if the message was injected into the pane.
 */
export async function deliverToPane(toWorker: string, messageId: string): Promise<boolean> {
  const worker = await registry.get(toWorker);
  if (!worker || !worker.paneId) {
    await mailbox.markFailed(messageId);
    return false;
  }
  if (!(await _deps.isPaneAlive(worker.paneId))) {
    await mailbox.markFailed(messageId);
    return false;
  }

  const message = await mailbox.getById(messageId);
  if (!message || message.deliveredAt) return false;

  const injected = await injectToTmuxPane(worker, message);
  if (injected && worker.repoPath) {
    await mailbox.markDelivered(worker.repoPath, worker.id, messageId);
  } else {
    await mailbox.markFailed(messageId);
  }
  return injected;
}

/**
 * Get the inbox for a worker (all messages, with read/unread status).
 */
export async function getInbox(repoPath: string, workerId: string): Promise<mailbox.MailboxMessage[]> {
  return mailbox.inbox(repoPath, workerId);
}
