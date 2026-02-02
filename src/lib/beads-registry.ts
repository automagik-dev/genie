/**
 * Beads Registry - Worker state management via beads native commands
 *
 * Replaces JSON file-based worker-registry.ts with beads agent/slot system.
 * Provides unified state tracking with Witness support and built-in cardinality.
 *
 * Environment:
 *   TERM_USE_BEADS_REGISTRY=false - Disable beads registry (fallback to JSON)
 */

import { $ } from 'bun';
import type { Worker, WorkerState } from './worker-registry.js';

// ============================================================================
// Configuration
// ============================================================================

const AGENT_LABEL = 'gt:agent';

/**
 * Check if beads registry is enabled (default: true)
 */
export function isBeadsRegistryEnabled(): boolean {
  return process.env.TERM_USE_BEADS_REGISTRY !== 'false';
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Run bd command and parse output
 */
async function runBd(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await $`bd ${args}`.quiet();
    return {
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      exitCode: 0,
    };
  } catch (error: any) {
    return {
      stdout: error.stdout?.toString().trim() || '',
      stderr: error.stderr?.toString().trim() || '',
      exitCode: error.exitCode || 1,
    };
  }
}

/**
 * Parse JSON from bd command, handling potential errors
 */
function parseJson<T>(output: string): T | null {
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

// ============================================================================
// Agent Bead Management
// ============================================================================

interface AgentBead {
  id: string;
  title: string;
  type: string;
  labels: string[];
  state?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Create a new agent bead for a worker
 */
export async function createAgent(
  workerId: string,
  metadata: {
    paneId: string;
    session: string;
    worktree: string | null;
    repoPath: string;
    taskId: string;
    taskTitle?: string;
  }
): Promise<string> {
  // Create agent bead with metadata
  const title = `Worker: ${workerId}`;
  const { stdout, exitCode } = await runBd([
    'create',
    `--title=${title}`,
    '--type=agent',
    `--label=${AGENT_LABEL}`,
    `--label=worker:${workerId}`,
    '--json',
  ]);

  if (exitCode !== 0) {
    throw new Error(`Failed to create agent bead: ${stdout}`);
  }

  const created = parseJson<{ id: string }>(stdout);
  if (!created?.id) {
    throw new Error('Failed to parse created agent bead');
  }

  // Store worker metadata in agent
  const metadataJson = JSON.stringify({
    paneId: metadata.paneId,
    session: metadata.session,
    worktree: metadata.worktree,
    repoPath: metadata.repoPath,
    taskId: metadata.taskId,
    taskTitle: metadata.taskTitle,
    startedAt: new Date().toISOString(),
  });

  await runBd(['update', created.id, `--metadata=${metadataJson}`]);

  return created.id;
}

/**
 * Ensure an agent bead exists for a worker, creating if needed
 */
export async function ensureAgent(
  workerId: string,
  metadata: {
    paneId: string;
    session: string;
    worktree: string | null;
    repoPath: string;
    taskId: string;
    taskTitle?: string;
  }
): Promise<string> {
  // Check if agent already exists
  const existing = await findAgentByWorkerId(workerId);
  if (existing) {
    return existing.id;
  }

  return createAgent(workerId, metadata);
}

/**
 * Find agent bead by worker ID
 */
async function findAgentByWorkerId(workerId: string): Promise<AgentBead | null> {
  const { stdout, exitCode } = await runBd([
    'list',
    `--label=${AGENT_LABEL}`,
    `--label=worker:${workerId}`,
    '--json',
  ]);

  if (exitCode !== 0 || !stdout) return null;

  const agents = parseJson<AgentBead[]>(stdout);
  return agents?.[0] || null;
}

/**
 * Delete an agent bead
 */
export async function deleteAgent(agentIdOrWorkerId: string): Promise<boolean> {
  // Try direct ID first
  let { exitCode } = await runBd(['delete', agentIdOrWorkerId]);
  if (exitCode === 0) return true;

  // Try finding by worker ID
  const agent = await findAgentByWorkerId(agentIdOrWorkerId);
  if (agent) {
    ({ exitCode } = await runBd(['delete', agent.id]));
    return exitCode === 0;
  }

  return false;
}

// ============================================================================
// Agent State Management
// ============================================================================

/**
 * Map our WorkerState to beads agent states
 */
function mapToBeadsState(state: WorkerState): string {
  switch (state) {
    case 'spawning':
      return 'spawning';
    case 'working':
      return 'working';
    case 'idle':
      return 'idle';
    case 'permission':
      return 'blocked';
    case 'question':
      return 'blocked';
    case 'done':
      return 'done';
    case 'error':
      return 'error';
    default:
      return 'unknown';
  }
}

/**
 * Map beads agent state to WorkerState
 */
function mapFromBeadsState(beadsState: string): WorkerState {
  switch (beadsState) {
    case 'spawning':
      return 'spawning';
    case 'working':
      return 'working';
    case 'idle':
      return 'idle';
    case 'blocked':
      return 'permission'; // Could be permission or question
    case 'done':
      return 'done';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

/**
 * Set agent state
 */
export async function setAgentState(workerId: string, state: WorkerState): Promise<void> {
  const agent = await findAgentByWorkerId(workerId);
  if (!agent) {
    throw new Error(`Agent not found for worker ${workerId}`);
  }

  const beadsState = mapToBeadsState(state);
  const { exitCode, stderr } = await runBd(['agent', 'state', agent.id, beadsState]);

  if (exitCode !== 0) {
    throw new Error(`Failed to set agent state: ${stderr}`);
  }
}

/**
 * Send heartbeat for agent
 */
export async function heartbeat(workerId: string): Promise<void> {
  const agent = await findAgentByWorkerId(workerId);
  if (!agent) return; // Silently ignore if agent doesn't exist

  await runBd(['agent', 'heartbeat', agent.id]);
}

// ============================================================================
// Work Binding (Slots)
// ============================================================================

/**
 * Bind work (task) to an agent
 */
export async function bindWork(workerId: string, taskId: string): Promise<void> {
  const agent = await findAgentByWorkerId(workerId);
  if (!agent) {
    throw new Error(`Agent not found for worker ${workerId}`);
  }

  const { exitCode, stderr } = await runBd(['slot', 'set', agent.id, 'hook', taskId]);

  if (exitCode !== 0) {
    throw new Error(`Failed to bind work: ${stderr}`);
  }
}

/**
 * Unbind work from an agent
 */
export async function unbindWork(workerId: string): Promise<void> {
  const agent = await findAgentByWorkerId(workerId);
  if (!agent) return; // Silently ignore if agent doesn't exist

  await runBd(['slot', 'clear', agent.id, 'hook']);
}

// ============================================================================
// Worker Query Functions
// ============================================================================

interface AgentMetadata {
  paneId: string;
  session: string;
  worktree: string | null;
  repoPath: string;
  taskId: string;
  taskTitle?: string;
  startedAt: string;
  wishSlug?: string;
  groupNumber?: number;
}

/**
 * Convert agent bead to Worker interface
 */
function agentToWorker(agent: AgentBead, metadata: AgentMetadata): Worker {
  return {
    id: metadata.taskId, // Worker ID matches task ID
    paneId: metadata.paneId,
    session: metadata.session,
    worktree: metadata.worktree,
    taskId: metadata.taskId,
    taskTitle: metadata.taskTitle,
    wishSlug: metadata.wishSlug,
    groupNumber: metadata.groupNumber,
    startedAt: metadata.startedAt,
    state: mapFromBeadsState(agent.state || 'idle'),
    lastStateChange: new Date().toISOString(), // Would need to track this in beads
    repoPath: metadata.repoPath,
  };
}

/**
 * Get a worker by ID
 */
export async function getWorker(workerId: string): Promise<Worker | null> {
  const agent = await findAgentByWorkerId(workerId);
  if (!agent) return null;

  // Get full agent details with metadata
  const { stdout, exitCode } = await runBd(['show', agent.id, '--json']);
  if (exitCode !== 0 || !stdout) return null;

  const fullAgent = parseJson<AgentBead & { metadata?: AgentMetadata }>(stdout);
  if (!fullAgent?.metadata) return null;

  return agentToWorker(fullAgent, fullAgent.metadata);
}

/**
 * List all workers
 */
export async function listWorkers(): Promise<Worker[]> {
  const { stdout, exitCode } = await runBd([
    'list',
    `--label=${AGENT_LABEL}`,
    '--json',
  ]);

  if (exitCode !== 0 || !stdout) return [];

  const agents = parseJson<Array<AgentBead & { metadata?: AgentMetadata }>>(stdout);
  if (!agents) return [];

  const workers: Worker[] = [];
  for (const agent of agents) {
    if (agent.metadata) {
      workers.push(agentToWorker(agent, agent.metadata));
    }
  }

  return workers;
}

/**
 * Find worker by pane ID
 */
export async function findByPane(paneId: string): Promise<Worker | null> {
  const workers = await listWorkers();
  const normalizedPaneId = paneId.startsWith('%') ? paneId : `%${paneId}`;
  return workers.find(w => w.paneId === normalizedPaneId) || null;
}

/**
 * Find worker by task ID
 */
export async function findByTask(taskId: string): Promise<Worker | null> {
  // Worker ID typically matches task ID
  return getWorker(taskId);
}

/**
 * Check if a worker exists for a task
 */
export async function hasWorkerForTask(taskId: string): Promise<boolean> {
  const worker = await findByTask(taskId);
  return worker !== null;
}

// ============================================================================
// Daemon Management
// ============================================================================

interface DaemonStatus {
  running: boolean;
  pid?: number;
  lastSync?: string;
  autoCommit?: boolean;
  autoPush?: boolean;
}

/**
 * Check if beads daemon is running
 */
export async function checkDaemonStatus(): Promise<DaemonStatus> {
  const { stdout, exitCode } = await runBd(['daemon', 'status', '--json']);

  if (exitCode !== 0) {
    return { running: false };
  }

  const status = parseJson<DaemonStatus>(stdout);
  return status || { running: false };
}

/**
 * Start beads daemon
 */
export async function startDaemon(options?: { autoCommit?: boolean; autoPush?: boolean }): Promise<boolean> {
  const args = ['daemon', 'start'];
  if (options?.autoCommit) args.push('--auto-commit');
  if (options?.autoPush) args.push('--auto-push');

  const { exitCode } = await runBd(args);
  return exitCode === 0;
}

/**
 * Stop beads daemon
 */
export async function stopDaemon(): Promise<boolean> {
  const { exitCode } = await runBd(['daemon', 'stop']);
  return exitCode === 0;
}

/**
 * Ensure daemon is running, start if not
 */
export async function ensureDaemon(options?: { autoCommit?: boolean }): Promise<boolean> {
  const status = await checkDaemonStatus();
  if (status.running) return true;

  return startDaemon(options);
}

// ============================================================================
// Worktree Management (via bd worktree)
// ============================================================================

export interface BeadsWorktreeInfo {
  path: string;
  branch: string;
  name: string;
}

/**
 * Create worktree via beads
 */
export async function createWorktree(name: string): Promise<BeadsWorktreeInfo | null> {
  const { stdout, exitCode, stderr } = await runBd(['worktree', 'create', name, '--json']);

  if (exitCode !== 0) {
    console.error(`bd worktree create failed: ${stderr}`);
    return null;
  }

  const info = parseJson<BeadsWorktreeInfo>(stdout);
  return info;
}

/**
 * Remove worktree via beads
 */
export async function removeWorktree(name: string): Promise<boolean> {
  const { exitCode } = await runBd(['worktree', 'remove', name]);
  return exitCode === 0;
}

/**
 * List worktrees via beads
 */
export async function listWorktrees(): Promise<BeadsWorktreeInfo[]> {
  const { stdout, exitCode } = await runBd(['worktree', 'list', '--json']);

  if (exitCode !== 0 || !stdout) return [];

  const worktrees = parseJson<BeadsWorktreeInfo[]>(stdout);
  return worktrees || [];
}

/**
 * Check if worktree exists via beads
 */
export async function worktreeExists(name: string): Promise<boolean> {
  const worktrees = await listWorktrees();
  return worktrees.some(wt => wt.name === name || wt.branch === name);
}

/**
 * Get worktree info via beads
 */
export async function getWorktree(name: string): Promise<BeadsWorktreeInfo | null> {
  const worktrees = await listWorktrees();
  return worktrees.find(wt => wt.name === name || wt.branch === name) || null;
}

// ============================================================================
// Migration/Compatibility
// ============================================================================

/**
 * Register a worker (compatibility with worker-registry interface)
 * Writes to both beads and JSON registry during migration
 */
export async function register(worker: Worker): Promise<void> {
  await ensureAgent(worker.id, {
    paneId: worker.paneId,
    session: worker.session,
    worktree: worker.worktree,
    repoPath: worker.repoPath,
    taskId: worker.taskId,
    taskTitle: worker.taskTitle,
  });

  await setAgentState(worker.id, worker.state);
}

/**
 * Unregister a worker (compatibility with worker-registry interface)
 */
export async function unregister(workerId: string): Promise<void> {
  await unbindWork(workerId);
  await deleteAgent(workerId);
}

/**
 * Update worker state (compatibility with worker-registry interface)
 */
export async function updateState(workerId: string, state: WorkerState): Promise<void> {
  await setAgentState(workerId, state);
  await heartbeat(workerId);
}
