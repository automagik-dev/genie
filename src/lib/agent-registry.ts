/**
 * Agent Registry — Tracks agent state with provider metadata.
 *
 * Stores provider, transport, session, window, paneId, role, and skill
 * metadata for every spawned agent. Registry is persisted to a single
 * global file at `~/.genie/workers.json`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireLock } from './file-lock.js';
import type { ProviderName } from './provider-adapters.js';

// ============================================================================
// Types
// ============================================================================

export type AgentState =
  | 'spawning' // Agent being created
  | 'working' // Actively producing output
  | 'idle' // At prompt, waiting for input
  | 'permission' // Waiting for permission approval
  | 'question' // Waiting for question answer
  | 'done' // Task completed, ready for close
  | 'error' // Encountered error
  | 'suspended'; // Pane killed, session preserved for resume

export type TransportType = 'tmux' | 'inline';

export interface Agent {
  /** Unique agent ID (usually matches taskId, e.g., "wish-42"). */
  id: string;
  /** tmux pane ID (e.g., "%16"). */
  paneId: string;
  /** tmux session name. */
  session: string;
  /** Path to git worktree, null if using shared repo. */
  worktree: string | null;
  /** Task ID this agent is bound to. */
  taskId?: string;
  /** Task title. */
  taskTitle?: string;
  /** Associated wish slug (if from decompose). */
  wishSlug?: string;
  /** Execution group number within wish. */
  groupNumber?: number;
  /** ISO timestamp when agent was started. */
  startedAt: string;
  /** Current agent state. */
  state: AgentState;
  /** Last state change timestamp. */
  lastStateChange: string;
  /** Repository path where agent operates. */
  repoPath: string;
  /** Claude session ID for resume capability. */
  claudeSessionId?: string;
  /** tmux window name (matches taskId) — used for window cleanup. */
  windowName?: string;
  /** tmux window ID (e.g., "@4") — used for session-qualified cleanup. */
  windowId?: string;
  /** Agent role (e.g., "implementor", "tester", "main", "tests", "review"). */
  role?: string;
  /** Custom agent name when multiple agents on same task. */
  customName?: string;
  /** Ordered list of sub-pane IDs from splits. Index 0 in subPanes = wish-42:1, etc. */
  subPanes?: string[];
  /** Provider used to launch this agent. */
  provider?: ProviderName;
  /** Transport type (always "tmux" for now). */
  transport?: TransportType;
  /** Skill loaded at spawn (codex agents). */
  skill?: string;
  /** Team this agent belongs to. */
  team?: string;
  /** tmux window name (alias for windowName, used by teams surface). */
  window?: string;
  /** Claude Code native agent ID (e.g., "role@team"). */
  nativeAgentId?: string;
  /** Claude Code native teammate color. */
  nativeColor?: string;
  /** Whether this agent uses Claude Code native teams. */
  nativeTeamEnabled?: boolean;
  /** Parent session UUID for native team IPC. */
  parentSessionId?: string;
  /** ISO timestamp when agent was suspended (pane killed, session preserved). */
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

interface AgentRegistry {
  workers: Record<string, Agent>;
  templates: Record<string, WorkerTemplate>;
  lastUpdated: string;
}

// ============================================================================
// Configuration
// ============================================================================

function getGlobalDir(): string {
  return process.env.GENIE_HOME ?? join(homedir(), '.genie');
}

function getRegistryFilePath(): string {
  return join(getGlobalDir(), 'workers.json');
}

// ============================================================================
// Internal
// ============================================================================

async function loadRegistry(registryPath?: string): Promise<AgentRegistry> {
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

async function saveRegistry(registry: AgentRegistry, registryPath?: string): Promise<void> {
  const filePath = registryPath ?? getRegistryFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  registry.lastUpdated = new Date().toISOString();
  await writeFile(filePath, JSON.stringify(registry, null, 2));
}

// ============================================================================
// Locked read-modify-write
// ============================================================================

async function withRegistry<T>(fn: (reg: AgentRegistry) => T | Promise<T>, registryPath?: string): Promise<T> {
  const filePath = registryPath ?? getRegistryFilePath();
  const release = await acquireLock(filePath);
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

/** Register a new agent. */
export async function register(agent: Agent): Promise<void> {
  await withRegistry((reg) => {
    reg.workers[agent.id] = agent;
  });
}

/** Unregister (remove) an agent. */
export async function unregister(id: string): Promise<void> {
  await withRegistry((reg) => {
    delete reg.workers[id];
  });
}

/** Get an agent by ID. */
export async function get(id: string): Promise<Agent | null> {
  const registry = await loadRegistry();
  return registry.workers[id] ?? null;
}

/** List all agents. */
export async function list(): Promise<Agent[]> {
  const registry = await loadRegistry();
  return Object.values(registry.workers);
}

/** Update multiple agent fields. */
export async function update(id: string, updates: Partial<Agent>): Promise<void> {
  await withRegistry((reg) => {
    const agent = reg.workers[id];
    if (agent) {
      Object.assign(agent, updates);
      if (updates.state) {
        agent.lastStateChange = new Date().toISOString();
      }
    }
  });
}

/** Find agent by tmux pane ID. @public - used via dynamic namespace import in msg.ts */
export async function findByPane(paneId: string): Promise<Agent | null> {
  const agents = await list();
  const normalized = paneId.startsWith('%') ? paneId : `%${paneId}`;
  return agents.find((a) => a.paneId === normalized) ?? null;
}

/** Find agent by tmux window ID (e.g., "@4"). */
export async function findByWindow(windowId: string): Promise<Agent | null> {
  const agents = await list();
  const normalizedId = windowId.startsWith('@') ? windowId : `@${windowId}`;
  return agents.find((a) => a.windowId === normalizedId) ?? null;
}

/** Find agent by task ID (returns first match). */
export async function findByTask(taskId: string): Promise<Agent | null> {
  const agents = await list();
  return agents.find((a) => a.taskId === taskId) ?? null;
}

/** Calculate elapsed time for an agent. */
export function getElapsedTime(agent: Agent): { ms: number; formatted: string } {
  const startTime = new Date(agent.startedAt).getTime();
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

// ============================================================================
// Sub-Pane Helpers
// ============================================================================

/**
 * Add a sub-pane to an agent's subPanes array.
 * If the agent doesn't exist, this is a no-op.
 */
export async function addSubPane(workerId: string, paneId: string, registryPath?: string): Promise<void> {
  await withRegistry((reg) => {
    const agent = reg.workers[workerId];
    if (!agent) return;
    if (!agent.subPanes) agent.subPanes = [];
    agent.subPanes.push(paneId);
  }, registryPath);
}

/**
 * Get a pane ID by agent ID and index.
 * Index 0 = primary paneId, 1+ = subPanes[index - 1].
 * Returns null if agent not found or index out of range.
 */
export async function getPane(workerId: string, index: number, registryPath?: string): Promise<string | null> {
  const registry = await loadRegistry(registryPath);
  const agent = registry.workers[workerId];
  if (!agent) return null;

  if (index === 0) {
    return agent.paneId;
  }

  const subIndex = index - 1;
  if (!agent.subPanes || subIndex >= agent.subPanes.length || subIndex < 0) {
    return null;
  }

  return agent.subPanes[subIndex];
}

/**
 * Remove a sub-pane from an agent's subPanes array (for dead pane cleanup).
 * If the agent doesn't exist or has no subPanes, this is a no-op.
 */
export async function removeSubPane(workerId: string, paneId: string, registryPath?: string): Promise<void> {
  await withRegistry((reg) => {
    const agent = reg.workers[workerId];
    if (!agent || !agent.subPanes) return;
    agent.subPanes = agent.subPanes.filter((p) => p !== paneId);
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

/** List all templates. */
export async function listTemplates(): Promise<WorkerTemplate[]> {
  const reg = await loadRegistry();
  return Object.values(reg.templates ?? {});
}
