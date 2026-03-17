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

import { resolveSessionName } from '../genie-commands/session.js';
import { filterBySession as registryFilterBySession } from './agent-registry.js';
import * as registry from './agent-registry.js';
import * as nativeTeams from './claude-native-teams.js';
import * as mailbox from './mailbox.js';
import { detectState } from './orchestrator/index.js';
import { capturePaneContent, executeTmux, isPaneAlive } from './tmux.js';

// ============================================================================
// Types
// ============================================================================

type DirectoryResolution = { entry: { name: string } } | null;

interface DeliveryResult {
  messageId: string;
  workerId: string;
  delivered: boolean;
  reason?: string;
}

export interface ProtocolRouterTestDeps {
  registry?: Pick<
    typeof registry,
    'filterBySession' | 'get' | 'list' | 'listTemplates' | 'saveTemplate' | 'unregister'
  >;
  resolveSessionName?: typeof resolveSessionName;
  resolveDirectory?: (recipientId: string) => Promise<DirectoryResolution>;
  spawnWorkerFromTemplate?: (
    template: registry.WorkerTemplate,
    resumeSessionId?: string,
    senderSession?: string,
  ) => Promise<{ worker: registry.Agent; paneId: string; workerId: string }>;
  detectState?: typeof detectState;
  capturePaneContent?: typeof capturePaneContent;
  executeTmux?: typeof executeTmux;
  isPaneAlive?: typeof isPaneAlive;
}

let testDeps: Partial<ProtocolRouterTestDeps> = {};

export function __setProtocolRouterTestDeps(deps: Partial<ProtocolRouterTestDeps>): void {
  testDeps = { ...testDeps, ...deps };
}

export function __resetProtocolRouterTestDeps(): void {
  testDeps = {};
}

function getRegistryApi(): typeof registry {
  return (testDeps.registry as typeof registry | undefined) ?? registry;
}

function getResolveSessionName(): typeof resolveSessionName {
  return testDeps.resolveSessionName ?? resolveSessionName;
}

function getDetectState(): typeof detectState {
  return testDeps.detectState ?? detectState;
}

function getCapturePaneContent(): typeof capturePaneContent {
  return testDeps.capturePaneContent ?? capturePaneContent;
}

function getExecuteTmux(): typeof executeTmux {
  return testDeps.executeTmux ?? executeTmux;
}

function getIsPaneAlive(): typeof isPaneAlive {
  return testDeps.isPaneAlive ?? isPaneAlive;
}

async function resolveDirectory(recipientId: string): Promise<DirectoryResolution> {
  if (testDeps.resolveDirectory) return testDeps.resolveDirectory(recipientId);
  const { resolve } = await import('./agent-directory.js');
  return resolve(recipientId);
}

async function spawnFromTemplate(
  template: registry.WorkerTemplate,
  resumeSessionId?: string,
  senderSession?: string,
): Promise<{ worker: registry.Agent; paneId: string; workerId: string }> {
  if (testDeps.spawnWorkerFromTemplate) {
    return testDeps.spawnWorkerFromTemplate(template, resumeSessionId, senderSession);
  }
  const { spawnWorkerFromTemplate } = await import('./protocol-router-spawn.js');
  return spawnWorkerFromTemplate(template, resumeSessionId, senderSession);
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
      const content = await getCapturePaneContent()(paneId, 30);
      const state = getDetectState()(content);
      if (state.type === 'idle') return true;
    } catch {
      /* pane not ready yet */
    }
    await new Promise((r) => setTimeout(r, AUTO_SPAWN_POLL_INTERVAL_MS));
  }
  return false;
}

/** Fetch workers scoped to a session, or all workers if no session specified. */
async function scopedWorkers(senderSession?: string): Promise<registry.Agent[]> {
  const registryApi = getRegistryApi();
  return senderSession
    ? (testDeps.registry?.filterBySession?.(senderSession) ?? registryFilterBySession(senderSession))
    : registryApi.list();
}

async function scopedTemplates(senderSession?: string): Promise<registry.WorkerTemplate[]> {
  const templates = await getRegistryApi().listTemplates();
  if (!senderSession) return templates;

  const scoped: registry.WorkerTemplate[] = [];
  for (const template of templates) {
    if ((await getResolveSessionName()(template.cwd)) === senderSession) {
      scoped.push(template);
    }
  }
  return scoped;
}

function matchesRecipient(agent: Pick<registry.Agent, 'id' | 'role' | 'team'>, recipientId: string): boolean {
  return agent.id === recipientId || agent.role === recipientId || `${agent.team}:${agent.role}` === recipientId;
}

function matchesTemplate(template: registry.WorkerTemplate, recipientId: string): boolean {
  return (
    template.id === recipientId || template.role === recipientId || `${template.team}:${template.role}` === recipientId
  );
}

/**
 * Resolve a recipient to live workers using strict tiered matching.
 * Priority: exact ID > role > team:role.
 * Only returns workers with alive panes (non-suspended).
 * When senderSession is provided, only matches workers in the same session (project isolation).
 */
async function resolveRecipient(recipientId: string, senderSession?: string): Promise<registry.Agent[]> {
  const allWorkers = await scopedWorkers(senderSession);

  const byId: registry.Agent[] = [];
  const byRole: registry.Agent[] = [];
  const byTeamRole: registry.Agent[] = [];

  for (const w of allWorkers) {
    if (w.state === 'suspended') continue;
    if (!(await getIsPaneAlive()(w.paneId))) continue;

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
async function findLiveWorkerFuzzy(recipientId: string, senderSession?: string): Promise<registry.Agent | null> {
  const matches = await resolveRecipient(recipientId, senderSession);
  return matches.length === 1 ? matches[0] : null;
}

async function findWorkerCandidate(recipientId: string, senderSession?: string): Promise<registry.Agent | null> {
  const workers = await scopedWorkers(senderSession);
  const exact = workers.find((worker) => worker.id === recipientId);
  if (exact) return exact;

  const byRole = workers.find((worker) => worker.role === recipientId);
  if (byRole) return byRole;

  return workers.find((worker) => `${worker.team}:${worker.role}` === recipientId) ?? null;
}

async function findTemplateCandidate(
  recipientId: string,
  worker: registry.Agent | null,
  senderSession?: string,
): Promise<registry.WorkerTemplate | null> {
  const templates = await scopedTemplates(senderSession);
  const workerTeam = worker?.team;

  const exact = templates.find(
    (template) => (!workerTeam || template.team === workerTeam) && template.id === recipientId,
  );
  if (exact) return exact;

  const byRole = templates.find(
    (template) => (!workerTeam || template.team === workerTeam) && template.role === recipientId,
  );
  if (byRole) return byRole;

  return (
    templates.find(
      (template) =>
        (!workerTeam || template.team === workerTeam) && `${template.team}:${template.role}` === recipientId,
    ) ?? null
  );
}

/**
 * Ensure a worker is alive, auto-spawning from template if needed.
 * Handles suspended workers by resuming with --resume flag.
 */
async function ensureWorkerAlive(
  worker: registry.Agent | null,
  recipientId: string,
  senderSession?: string,
): Promise<{ worker: registry.Agent; respawned: boolean } | null> {
  if (worker && worker.state !== 'suspended' && (await getIsPaneAlive()(worker.paneId))) {
    return { worker, respawned: false };
  }

  // Always check for a live worker before attempting to spawn — prevents
  // duplicate spawns when the registry entry is stale/dead but another
  // instance with the same role is already alive.
  const live = await findLiveWorkerFuzzy(recipientId, senderSession);
  if (live) return { worker: live, respawned: false };

  if (!process.env.TMUX) return null;

  const template = await findTemplateCandidate(recipientId, worker, senderSession);
  if (!template) return null;

  // Only resume explicitly suspended workers (idle-timeout).
  // Always resume if we have a session ID — all non-running workers are
  // effectively suspended (dead state has no practical distinction).
  const resumeSessionId =
    template.provider === 'claude' ? (worker?.claudeSessionId ?? template.lastSessionId) : undefined;

  try {
    // Clean up ghost worker entries (dead panes) for this role before spawning
    const registryApi = getRegistryApi();
    await cleanupDeadWorkers(recipientId, worker?.team, senderSession ?? worker?.session);

    if (worker) {
      await registryApi.unregister(worker.id);
    }

    const result = await spawnFromTemplate(template, resumeSessionId, senderSession);

    await registryApi.saveTemplate({
      ...template,
      lastSpawnedAt: new Date().toISOString(),
      lastSessionId: result.worker.claudeSessionId,
    });

    await waitForWorkerReady(result.paneId);

    // Verify the pane survived startup — if Claude exited (e.g. stale resume
    // or startup error), the pane is dead and delivery would silently fail.
    if (!(await getIsPaneAlive()(result.paneId))) {
      await registryApi.unregister(result.worker.id);
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
async function cleanupDeadWorkers(recipientId: string, team?: string, session?: string): Promise<void> {
  const registryApi = getRegistryApi();
  const allWorkers = session
    ? await (testDeps.registry?.filterBySession?.(session) ?? registryFilterBySession(session))
    : await registryApi.list();
  for (const w of allWorkers) {
    if (team && w.team !== team) continue;
    const matches = w.role === recipientId || w.id === recipientId;
    if (!matches) continue;
    if (await getIsPaneAlive()(w.paneId)) continue;
    await registryApi.unregister(w.id);
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

  // Verify the recipient exists as a registered native team member
  const config = await nativeTeams.loadConfig(resolvedTeam).catch(() => null);
  if (!config) return null;
  const memberExists = config.members?.some(
    (m: { name?: string; agentId?: string }) => m.name === to || m.agentId === `${to}@${resolvedTeam}`,
  );
  if (!memberExists) return null;

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

/**
 * Send a message to a recipient using directory-first resolution.
 *
 * Resolution order:
 *   1. Live workers (ID > role > team:role), scoped to senderSession if provided
 *   2. Agent directory + worker registry → auto-spawn from template
 *   3. Native team inbox fallback
 *
 * @param senderSession — When set, only resolves recipients in the same tmux session (project isolation).
 */
export async function sendMessage(
  repoPath: string,
  from: string,
  to: string,
  body: string,
  teamName?: string,
  senderSession?: string,
): Promise<DeliveryResult> {
  // 1. Find live workers using strict tiered matching (ID > role > team:role)
  const liveMatches = await resolveRecipient(to, senderSession);

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
  const dirResolved = await resolveDirectory(to);

  // Also check worker registry for session context (provides claudeSessionId for resume)
  let worker = await getRegistryApi().get(to);
  if (!worker || (senderSession && worker.session !== senderSession)) {
    worker = await findWorkerCandidate(to, senderSession);
  }

  // Try auto-spawn if agent is known via directory OR registry
  if (dirResolved || worker) {
    const alive = await ensureWorkerAlive(worker, to, senderSession);
    if (alive) {
      return deliverToWorker(repoPath, from, alive.worker, body);
    }
  }

  if (senderSession) {
    const workerMatchesSession = worker ? matchesRecipient(worker, to) && worker.session === senderSession : false;
    const templateMatchesSession =
      (await findTemplateCandidate(to, worker, senderSession)) !== null ||
      (dirResolved !== null &&
        (await scopedTemplates(senderSession)).some(
          (template) => matchesTemplate(template, to) || matchesTemplate(template, dirResolved.entry.name),
        ));

    if (!workerMatchesSession && !templateMatchesSession) {
      return {
        messageId: '',
        workerId: to,
        delivered: false,
        reason: `Worker "${to}" not found in session "${senderSession}"`,
      };
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
    await getExecuteTmux()(`send-keys -t '${worker.paneId}' '${escaped}'`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await getExecuteTmux()(`send-keys -t '${worker.paneId}' Enter`);
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
