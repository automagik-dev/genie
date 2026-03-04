/**
 * Worker Registry — Tracks worker state with provider metadata.
 *
 * Stores provider, transport, session, window, paneId, role, and skill
 * metadata for every spawned worker. Registry is persisted to
 * `.genie/workers.json` (repo-local) or `~/.config/genie/workers.json`.
 */

import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProviderName } from './provider-adapters.js';

// ============================================================================
// Types
// ============================================================================

export type WorkerState =
  | 'spawning' // Worker being created
  | 'working' // Actively producing output
  | 'idle' // At prompt, waiting for input
  | 'permission' // Waiting for permission approval
  | 'question' // Waiting for question answer
  | 'done' // Task completed, ready for close
  | 'error' // Encountered error
  | 'suspended'; // Pane killed, session preserved for resume

export type TransportType = 'tmux' | 'inline';

export interface Worker {
  /** Unique worker ID (usually matches taskId, e.g., "bd-42"). */
  id: string;
  /** tmux pane ID (e.g., "%16"). */
  paneId: string;
  /** tmux session name. */
  session: string;
  /** Path to git worktree, null if using shared repo. */
  worktree: string | null;
  /** Beads or local task ID this worker is bound to. */
  taskId?: string;
  /** Task title from beads. */
  taskTitle?: string;
  /** Associated wish slug (if from decompose). */
  wishSlug?: string;
  /** Execution group number within wish. */
  groupNumber?: number;
  /** ISO timestamp when worker was started. */
  startedAt: string;
  /** Current worker state. */
  state: WorkerState;
  /** Last state change timestamp. */
  lastStateChange: string;
  /** Repository path where worker operates. */
  repoPath: string;
  /** Claude session ID for resume capability. */
  claudeSessionId?: string;
  /** tmux window name (matches taskId) — used for window cleanup. */
  windowName?: string;
  /** tmux window ID (e.g., "@4") — used for session-qualified cleanup. */
  windowId?: string;
  /** Worker role (e.g., "implementor", "tester", "main", "tests", "review"). */
  role?: string;
  /** Custom worker name when multiple workers on same task. */
  customName?: string;
  /** Ordered list of sub-pane IDs from splits. Index 0 in subPanes = bd-42:1, etc. */
  subPanes?: string[];
  /** Provider used to launch this worker. */
  provider?: ProviderName;
  /** Transport type (always "tmux" for now). */
  transport?: TransportType;
  /** Skill loaded at spawn (codex workers). */
  skill?: string;
  /** Team this worker belongs to. */
  team?: string;
  /** tmux window name (alias for windowName, used by teams surface). */
  window?: string;
  /** Claude Code native agent ID (e.g., "role@team"). */
  nativeAgentId?: string;
  /** Claude Code native teammate color. */
  nativeColor?: string;
  /** Whether this worker uses Claude Code native teams. */
  nativeTeamEnabled?: boolean;
  /** Parent session UUID for native team IPC. */
  parentSessionId?: string;
  /** ISO timestamp when worker was suspended (pane killed, session preserved). */
  suspendedAt?: string;
}

/** Saved spawn configuration for auto-respawn on message delivery. */
export interface WorkerTemplate {
  id: string;
  provider: ProviderName;
  team: string;
  role?: string;
  skill?: string;
  cwd: string;
  extraArgs?: string[];
  nativeTeamEnabled?: boolean;
  /** Timestamp of last spawn from this template. */
  lastSpawnedAt: string;
  /** Last known Claude session ID for resume capability. */
  lastSessionId?: string;
}

export interface WorkerRegistry {
  workers: Record<string, Worker>;
  templates: Record<string, WorkerTemplate>;
  lastUpdated: string;
}

// ============================================================================
// Configuration
// ============================================================================

const CONFIG_DIR = join(homedir(), '.config', 'genie');

function getRegistryFilePath(): string {
  const cwd = process.cwd();
  const repoGenie = join(cwd, '.genie');
  try {
    const { existsSync } = require('node:fs');
    if (process.env.GENIE_WORKER_REGISTRY === 'global') {
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
// Internal
// ============================================================================

async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
}

async function loadRegistry(registryPath?: string): Promise<WorkerRegistry> {
  try {
    const filePath = registryPath ?? getRegistryFilePath();
    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    if (!data.templates) data.templates = {};
    return data;
  } catch {
    return { workers: {}, templates: {}, lastUpdated: new Date().toISOString() };
  }
}

async function saveRegistry(registry: WorkerRegistry, registryPath?: string): Promise<void> {
  const filePath = registryPath ?? getRegistryFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  registry.lastUpdated = new Date().toISOString();
  await writeFile(filePath, JSON.stringify(registry, null, 2));
}

// ============================================================================
// File Locking — prevents concurrent load/modify/save races
// ============================================================================

const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 10000;

async function acquireLock(registryPath?: string): Promise<() => Promise<void>> {
  const filePath = registryPath ?? getRegistryFilePath();
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        try {
          await unlink(lockPath);
        } catch {
          /* already removed */
        }
      };
    } catch (err) {
      const errCode = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
      if (errCode !== 'EEXIST') throw err;

      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          try {
            await unlink(lockPath);
          } catch {
            /* race with other cleanup */
          }
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() > deadline) {
        try {
          await unlink(lockPath);
        } catch {
          throw new Error(`Registry lock timeout: could not remove stale lock at ${lockPath}`);
        }
        continue;
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

async function withRegistry<T>(fn: (reg: WorkerRegistry) => T | Promise<T>, registryPath?: string): Promise<T> {
  const release = await acquireLock(registryPath);
  try {
    const reg = await loadRegistry(registryPath);
    const result = await fn(reg);
    await saveRegistry(reg, registryPath);
    return result;
  } finally {
    await release();
  }
}

// ============================================================================
// Public API
// ============================================================================

/** Register a new worker. */
export async function register(worker: Worker): Promise<void> {
  await withRegistry((reg) => {
    reg.workers[worker.id] = worker;
  });
}

/** Unregister (remove) a worker. */
export async function unregister(id: string): Promise<void> {
  await withRegistry((reg) => {
    delete reg.workers[id];
  });
}

/** Get a worker by ID. */
export async function get(id: string): Promise<Worker | null> {
  const registry = await loadRegistry();
  return registry.workers[id] ?? null;
}

/** List all workers. */
export async function list(): Promise<Worker[]> {
  const registry = await loadRegistry();
  return Object.values(registry.workers);
}

/** Update a worker's state. */
export async function updateState(id: string, state: WorkerState): Promise<void> {
  await withRegistry((reg) => {
    const worker = reg.workers[id];
    if (worker) {
      worker.state = state;
      worker.lastStateChange = new Date().toISOString();
    }
  });
}

/** Update multiple worker fields. */
export async function update(id: string, updates: Partial<Worker>): Promise<void> {
  await withRegistry((reg) => {
    const worker = reg.workers[id];
    if (worker) {
      Object.assign(worker, updates);
      if (updates.state) {
        worker.lastStateChange = new Date().toISOString();
      }
    }
  });
}

/** Find worker by tmux pane ID. */
export async function findByPane(paneId: string): Promise<Worker | null> {
  const workers = await list();
  const normalized = paneId.startsWith('%') ? paneId : `%${paneId}`;
  return workers.find((w) => w.paneId === normalized) ?? null;
}

/** Find worker by tmux window ID (e.g., "@4"). */
export async function findByWindow(windowId: string): Promise<Worker | null> {
  const workers = await list();
  const normalizedId = windowId.startsWith('@') ? windowId : `@${windowId}`;
  return workers.find((w) => w.windowId === normalizedId) ?? null;
}

/** Find worker by beads task ID (returns first match for backwards compat). */
export async function findByTask(taskId: string): Promise<Worker | null> {
  const workers = await list();
  return workers.find((w) => w.taskId === taskId) ?? null;
}

/** Find ALL workers for a beads task ID (supports N workers per task). */
export async function findAllByTask(taskId: string): Promise<Worker[]> {
  const workers = await list();
  return workers.filter((w) => w.taskId === taskId);
}

/** Count workers for a task. */
export async function countByTask(taskId: string): Promise<number> {
  const workers = await findAllByTask(taskId);
  return workers.length;
}

/**
 * Generate a unique worker ID for a task (handles N workers per task).
 * Returns taskId for first worker, taskId-2 for second, etc.
 */
export async function generateWorkerId(taskId: string, customName?: string): Promise<string> {
  if (customName) {
    return customName;
  }

  const existingCount = await countByTask(taskId);
  if (existingCount === 0) {
    return taskId;
  }

  // Find next available suffix
  const workers = await list();
  let suffix = existingCount + 1;
  while (workers.some((w) => w.id === `${taskId}-${suffix}`)) {
    suffix++;
  }

  return `${taskId}-${suffix}`;
}

/** Find workers by wish slug. */
export async function findByWish(wishSlug: string): Promise<Worker[]> {
  const workers = await list();
  return workers.filter((w) => w.wishSlug === wishSlug);
}

/** Find worker by Claude session ID. */
export async function findBySessionId(sessionId: string): Promise<Worker | null> {
  const workers = await list();
  return workers.find((w) => w.claudeSessionId === sessionId) ?? null;
}

/** Check if a worker exists for a given task. */
export async function hasWorkerForTask(taskId: string): Promise<boolean> {
  const worker = await findByTask(taskId);
  return worker !== null;
}

/** Find workers by team name. */
export async function findByTeam(team: string): Promise<Worker[]> {
  const workers = await list();
  return workers.filter((w) => w.team === team);
}

/** Find workers by provider. */
export async function findByProvider(provider: ProviderName): Promise<Worker[]> {
  const workers = await list();
  return workers.filter((w) => w.provider === provider);
}

/** Get workers in a specific state. */
export async function getByState(state: WorkerState): Promise<Worker[]> {
  const workers = await list();
  return workers.filter((w) => w.state === state);
}

/** Calculate elapsed time for a worker. */
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

/** Get the config directory path. */
export function getConfigDir(): string {
  return CONFIG_DIR;
}

/** Get the registry file path. */
export function getRegistryPath(): string {
  return getRegistryFilePath();
}

// ============================================================================
// Sub-Pane Helpers
// ============================================================================

/**
 * Add a sub-pane to a worker's subPanes array.
 * If the worker doesn't exist, this is a no-op.
 */
export async function addSubPane(workerId: string, paneId: string, registryPath?: string): Promise<void> {
  await withRegistry((reg) => {
    const worker = reg.workers[workerId];
    if (!worker) return;
    if (!worker.subPanes) worker.subPanes = [];
    worker.subPanes.push(paneId);
  }, registryPath);
}

/**
 * Get a pane ID by worker ID and index.
 * Index 0 = primary paneId, 1+ = subPanes[index - 1].
 * Returns null if worker not found or index out of range.
 */
export async function getPane(workerId: string, index: number, registryPath?: string): Promise<string | null> {
  const registry = await loadRegistry(registryPath);
  const worker = registry.workers[workerId];
  if (!worker) return null;

  if (index === 0) {
    return worker.paneId;
  }

  const subIndex = index - 1;
  if (!worker.subPanes || subIndex >= worker.subPanes.length || subIndex < 0) {
    return null;
  }

  return worker.subPanes[subIndex];
}

/**
 * Remove a sub-pane from a worker's subPanes array (for dead pane cleanup).
 * If the worker doesn't exist or has no subPanes, this is a no-op.
 */
export async function removeSubPane(workerId: string, paneId: string, registryPath?: string): Promise<void> {
  await withRegistry((reg) => {
    const worker = reg.workers[workerId];
    if (!worker || !worker.subPanes) return;
    worker.subPanes = worker.subPanes.filter((p) => p !== paneId);
  }, registryPath);
}

// ============================================================================
// Worker Templates (for auto-respawn)
// ============================================================================

/** Save or update a worker template. */
export async function saveTemplate(template: WorkerTemplate): Promise<void> {
  await withRegistry((reg) => {
    reg.templates[template.id] = template;
  });
}

/** Get a template by exact ID. */
export async function getTemplate(id: string): Promise<WorkerTemplate | null> {
  const reg = await loadRegistry();
  return reg.templates?.[id] ?? null;
}

/** Find a template by ID, role, or team:role pattern. */
export async function findTemplate(query: string): Promise<WorkerTemplate | null> {
  const reg = await loadRegistry();
  const templates = Object.values(reg.templates ?? {});
  return (
    templates.find((t) => t.id === query || t.role === query || `${t.team}:${t.role}` === query) ?? null
  );
}

/** Remove a template by ID. */
export async function removeTemplate(id: string): Promise<void> {
  await withRegistry((reg) => {
    delete reg.templates[id];
  });
}

/** List all templates. */
export async function listTemplates(): Promise<WorkerTemplate[]> {
  const reg = await loadRegistry();
  return Object.values(reg.templates ?? {});
}
