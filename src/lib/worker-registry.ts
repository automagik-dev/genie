/**
 * Worker Registry - Manages worker state persistence
 *
 * Tracks Claude workers bound to beads issues, storing state in
 * ~/.config/term/workers.json
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';

// ============================================================================
// Types
// ============================================================================

export type WorkerState =
  | 'spawning'    // Worker being created
  | 'working'     // Actively producing output
  | 'idle'        // At prompt, waiting for input
  | 'permission'  // Waiting for permission approval
  | 'question'    // Waiting for question answer
  | 'done'        // Task completed, ready for close
  | 'error';      // Encountered error

export interface Worker {
  /** Unique worker ID (usually matches taskId, e.g., "bd-42") */
  id: string;
  /** tmux pane ID (e.g., "%16") */
  paneId: string;
  /** tmux session name */
  session: string;
  /** Path to git worktree, null if using shared repo */
  worktree: string | null;
  /** Beads issue ID this worker is bound to */
  taskId: string;
  /** Task title from beads */
  taskTitle?: string;
  /** Associated wish slug (if from decompose) */
  wishSlug?: string;
  /** Execution group number within wish */
  groupNumber?: number;
  /** ISO timestamp when worker was started */
  startedAt: string;
  /** Current worker state */
  state: WorkerState;
  /** Last state change timestamp */
  lastStateChange: string;
  /** Repository path where worker operates */
  repoPath: string;
  /** Claude session ID for resume capability */
  claudeSessionId?: string;
  /** tmux window name (matches taskId) — used for window cleanup */
  windowName?: string;
}

export interface WorkerRegistry {
  workers: Record<string, Worker>;
  lastUpdated: string;
}

// ============================================================================
// Configuration
// ============================================================================

const CONFIG_DIR = join(homedir(), '.config', 'term');

function getRegistryFilePath(): string {
  // Prefer repo-local tracked .genie/ when present (macro repo like blanco)
  const cwd = process.cwd();
  const repoGenie = join(cwd, '.genie');
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { existsSync } = require('fs');
    if (process.env.TERM_WORKER_REGISTRY === 'global') {
      return join(CONFIG_DIR, 'workers.json');
    }
    if (existsSync(repoGenie)) {
      return join(repoGenie, 'workers.json');
    }
  } catch {
    // ignore
  }
  return join(CONFIG_DIR, 'workers.json');
}

// ============================================================================
// Private Functions
// ============================================================================

async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
}

async function loadRegistry(): Promise<WorkerRegistry> {
  try {
    const content = await readFile(getRegistryFilePath(), 'utf-8');
    return JSON.parse(content);
  } catch {
    return { workers: {}, lastUpdated: new Date().toISOString() };
  }
}

async function saveRegistry(registry: WorkerRegistry): Promise<void> {
  const filePath = getRegistryFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  registry.lastUpdated = new Date().toISOString();
  await writeFile(filePath, JSON.stringify(registry, null, 2));
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Register a new worker in the registry
 */
export async function register(worker: Worker): Promise<void> {
  const registry = await loadRegistry();
  registry.workers[worker.id] = worker;
  await saveRegistry(registry);
}

/**
 * Unregister (remove) a worker from the registry
 */
export async function unregister(id: string): Promise<void> {
  const registry = await loadRegistry();
  delete registry.workers[id];
  await saveRegistry(registry);
}

/**
 * Get a worker by ID
 */
export async function get(id: string): Promise<Worker | null> {
  const registry = await loadRegistry();
  return registry.workers[id] || null;
}

/**
 * List all workers
 */
export async function list(): Promise<Worker[]> {
  const registry = await loadRegistry();
  return Object.values(registry.workers);
}

/**
 * Update a worker's state
 */
export async function updateState(id: string, state: WorkerState): Promise<void> {
  const registry = await loadRegistry();
  const worker = registry.workers[id];
  if (worker) {
    worker.state = state;
    worker.lastStateChange = new Date().toISOString();
    await saveRegistry(registry);
  }
}

/**
 * Update multiple worker fields
 */
export async function update(id: string, updates: Partial<Worker>): Promise<void> {
  const registry = await loadRegistry();
  const worker = registry.workers[id];
  if (worker) {
    Object.assign(worker, updates);
    if (updates.state) {
      worker.lastStateChange = new Date().toISOString();
    }
    await saveRegistry(registry);
  }
}

/**
 * Find worker by tmux pane ID
 */
export async function findByPane(paneId: string): Promise<Worker | null> {
  const workers = await list();
  // Normalize pane ID (with or without % prefix)
  const normalizedPaneId = paneId.startsWith('%') ? paneId : `%${paneId}`;
  return workers.find(w => w.paneId === normalizedPaneId) || null;
}

/**
 * Find worker by beads task ID
 */
export async function findByTask(taskId: string): Promise<Worker | null> {
  const workers = await list();
  return workers.find(w => w.taskId === taskId) || null;
}

/**
 * Find workers by wish slug
 */
export async function findByWish(wishSlug: string): Promise<Worker[]> {
  const workers = await list();
  return workers.filter(w => w.wishSlug === wishSlug);
}

/**
 * Find worker by Claude session ID
 */
export async function findBySessionId(sessionId: string): Promise<Worker | null> {
  const workers = await list();
  return workers.find(w => w.claudeSessionId === sessionId) || null;
}

/**
 * Check if a worker exists for a given task
 */
export async function hasWorkerForTask(taskId: string): Promise<boolean> {
  const worker = await findByTask(taskId);
  return worker !== null;
}

/**
 * Get workers in a specific state
 */
export async function getByState(state: WorkerState): Promise<Worker[]> {
  const workers = await list();
  return workers.filter(w => w.state === state);
}

/**
 * Calculate elapsed time for a worker
 */
export function getElapsedTime(worker: Worker): { ms: number; formatted: string } {
  const startTime = new Date(worker.startedAt).getTime();
  const ms = Date.now() - startTime;

  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);

  let formatted: string;
  if (hours > 0) {
    formatted = `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    formatted = `${minutes}m`;
  } else {
    formatted = '<1m';
  }

  return { ms, formatted };
}

/**
 * Get the config directory path
 */
export function getConfigDir(): string {
  return CONFIG_DIR;
}

/**
 * Get the registry file path
 */
export function getRegistryPath(): string {
  return getRegistryFilePath();
}
