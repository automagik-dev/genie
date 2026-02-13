/**
 * Local task backend (git-tracked) living in repo/.genie
 *
 * This is meant for the macro repo (blanco) where bd is not required.
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getRepoGenieDir } from './genie-dir.js';

export type LocalTaskStatus = 'ready' | 'in_progress' | 'done' | 'blocked';

export interface PriorityScores {
  blocking: number;            // 0-5: How many other items depend on this
  stability: number;           // 0-5: Foundation/infra impact
  crossImpact: number;         // 0-5: Affects multiple agents/repos
  quickWin: number;            // 0-5: Effort-to-value ratio
  complexityInverse: number;   // 0-5: Simplicity (5=trivial, 0=massive)
}

export function computePriorityScore(scores: PriorityScores): number {
  return (
    scores.blocking * 0.30 +
    scores.stability * 0.25 +
    scores.crossImpact * 0.20 +
    scores.quickWin * 0.15 +
    scores.complexityInverse * 0.10
  );
}

export interface LocalTask {
  id: string;           // wish-<n>
  title: string;
  description?: string;
  status: LocalTaskStatus;
  blockedBy: string[];
  createdAt: string;
  updatedAt: string;
  priorityScores?: PriorityScores;
  issueType?: 'task' | 'epic';
}

interface LocalTasksFile {
  tasks: Record<string, LocalTask>;
  order: string[]; // creation order
  lastUpdated: string;
}

interface LocalStateFile {
  nextWishId: number;
  lastUpdated: string;
}

function tasksPath(repoPath: string): string {
  return join(getRepoGenieDir(repoPath), 'tasks.json');
}

function statePath(repoPath: string): string {
  return join(getRepoGenieDir(repoPath), 'state.json');
}

async function ensureGenieDir(repoPath: string): Promise<void> {
  await mkdir(getRepoGenieDir(repoPath), { recursive: true });
}

async function loadTasks(repoPath: string): Promise<LocalTasksFile> {
  try {
    const content = await readFile(tasksPath(repoPath), 'utf-8');
    return JSON.parse(content);
  } catch {
    return { tasks: {}, order: [], lastUpdated: new Date().toISOString() };
  }
}

async function saveTasks(repoPath: string, data: LocalTasksFile): Promise<void> {
  await ensureGenieDir(repoPath);
  data.lastUpdated = new Date().toISOString();
  await writeFile(tasksPath(repoPath), JSON.stringify(data, null, 2));
}

async function loadState(repoPath: string): Promise<LocalStateFile> {
  try {
    const content = await readFile(statePath(repoPath), 'utf-8');
    const parsed = JSON.parse(content);
    if (typeof parsed.nextWishId !== 'number') throw new Error('bad');
    return parsed;
  } catch {
    return { nextWishId: 1, lastUpdated: new Date().toISOString() };
  }
}

async function saveState(repoPath: string, data: LocalStateFile): Promise<void> {
  await ensureGenieDir(repoPath);
  data.lastUpdated = new Date().toISOString();
  await writeFile(statePath(repoPath), JSON.stringify(data, null, 2));
}

export function isLocalTasksEnabled(repoPath: string): boolean {
  // Explicit override
  if (process.env.TERM_USE_LOCAL_TASKS === 'true') return true;
  if (process.env.TERM_USE_LOCAL_TASKS === 'false') return false;

  // If repo has a .genie directory but bd isn't available, prefer local.
  // For blanco we expect .genie to be tracked.
  return existsSync(getRepoGenieDir(repoPath));
}

export async function createWishTask(
  repoPath: string,
  title: string,
  options: { description?: string; parent?: string } = {}
): Promise<LocalTask> {
  const state = await loadState(repoPath);
  const id = `wish-${state.nextWishId}`;
  state.nextWishId += 1;
  await saveState(repoPath, state);

  const file = await loadTasks(repoPath);
  const now = new Date().toISOString();

  const task: LocalTask = {
    id,
    title,
    description: options.description,
    status: options.parent ? 'blocked' : 'ready',
    blockedBy: options.parent ? [options.parent] : [],
    createdAt: now,
    updatedAt: now,
  };

  file.tasks[id] = task;
  file.order.push(id);
  await saveTasks(repoPath, file);

  return task;
}

export async function getTask(repoPath: string, id: string): Promise<LocalTask | null> {
  const file = await loadTasks(repoPath);
  return file.tasks[id] || null;
}

export async function listTasks(repoPath: string): Promise<LocalTask[]> {
  const file = await loadTasks(repoPath);
  const tasks = file.order.map(id => file.tasks[id]).filter(Boolean);

  // Sort by priority score (descending). Tasks with scores above tasks without.
  tasks.sort((a, b) => {
    const scoreA = a.priorityScores ? computePriorityScore(a.priorityScores) : -1;
    const scoreB = b.priorityScores ? computePriorityScore(b.priorityScores) : -1;
    return scoreB - scoreA;
  });

  return tasks;
}

export async function getQueue(repoPath: string): Promise<{ ready: string[]; blocked: string[] }> {
  const file = await loadTasks(repoPath);

  const isDone = (id: string) => file.tasks[id]?.status === 'done';

  const ready: string[] = [];
  const blocked: string[] = [];

  for (const id of file.order) {
    const t = file.tasks[id];
    if (!t) continue;

    const depsDone = (t.blockedBy || []).every(isDone);

    if (t.status === 'done' || t.status === 'in_progress') continue;

    if ((t.blockedBy?.length || 0) > 0 && !depsDone) {
      blocked.push(`${t.id} (blocked by ${(t.blockedBy || []).join(', ')})`);
      continue;
    }

    // If deps are done, task can be ready
    ready.push(t.id);
  }

  // Sort ready tasks by priority score (descending). Tasks with scores above tasks without.
  ready.sort((a, b) => {
    const taskA = file.tasks[a];
    const taskB = file.tasks[b];
    const scoreA = taskA?.priorityScores ? computePriorityScore(taskA.priorityScores) : -1;
    const scoreB = taskB?.priorityScores ? computePriorityScore(taskB.priorityScores) : -1;
    return scoreB - scoreA;
  });

  return { ready, blocked };
}

/** Guard against prototype pollution — reject dangerous property names */
function isSafeKey(key: string): boolean {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

export async function claimTask(repoPath: string, id: string): Promise<boolean> {
  if (!isSafeKey(id)) return false;
  const file = await loadTasks(repoPath);
  if (!Object.prototype.hasOwnProperty.call(file.tasks, id)) return false;
  const t = file.tasks[id];
  if (!t) return false;

  if (t.status === 'in_progress') return false; // already claimed
  if (t.status === 'done') return false; // already done

  t.status = 'in_progress';
  t.updatedAt = new Date().toISOString();
  file.tasks[id] = t;
  await saveTasks(repoPath, file);
  return true;
}

/**
 * Ensure .genie directory and tasks.json exist.
 * Safe to call multiple times — idempotent.
 * Returns true if files were created, false if already existed.
 */
export async function ensureTasksFile(repoPath: string): Promise<boolean> {
  const fp = tasksPath(repoPath);
  try {
    await readFile(fp, 'utf-8');
    return false; // already exists
  } catch {
    try {
      await ensureGenieDir(repoPath);
      await saveTasks(repoPath, { tasks: {}, order: [], lastUpdated: new Date().toISOString() });
      return true;
    } catch (err: any) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EROFS') {
        throw new Error(
          `Cannot create .genie/tasks.json — directory is read-only (${code}).\n` +
          `   Path: ${fp}\n` +
          `   Fix: Check permissions on ${getRepoGenieDir(repoPath)}`
        );
      }
      throw err;
    }
  }
}

export async function markDone(repoPath: string, id: string): Promise<boolean> {
  const file = await loadTasks(repoPath);
  const t = file.tasks[id];
  if (!t) return false;

  t.status = 'done';
  t.updatedAt = new Date().toISOString();
  file.tasks[id] = t;
  await saveTasks(repoPath, file);
  return true;
}

export interface UpdateTaskOptions {
  status?: LocalTaskStatus;
  title?: string;
  blockedBy?: string[];  // replaces existing blockedBy
  addBlockedBy?: string[];  // appends to existing blockedBy
  priorityScores?: PriorityScores;
  issueType?: 'task' | 'epic';
}

export async function updateTask(
  repoPath: string,
  id: string,
  options: UpdateTaskOptions
): Promise<LocalTask | null> {
  const file = await loadTasks(repoPath);
  const t = file.tasks[id];
  if (!t) return null;

  if (options.status !== undefined) {
    t.status = options.status;
  }

  if (options.title !== undefined) {
    t.title = options.title;
  }

  if (options.blockedBy !== undefined) {
    // Replace blockedBy list
    t.blockedBy = options.blockedBy;
    // Auto-set status to blocked if there are dependencies
    if (options.blockedBy.length > 0 && t.status === 'ready') {
      t.status = 'blocked';
    }
  }

  if (options.priorityScores !== undefined) {
    t.priorityScores = options.priorityScores;
  }

  if (options.issueType !== undefined) {
    t.issueType = options.issueType;
  }

  if (options.addBlockedBy !== undefined && options.addBlockedBy.length > 0) {
    // Append to blockedBy list (deduplicate)
    const existing = new Set(t.blockedBy || []);
    for (const dep of options.addBlockedBy) {
      existing.add(dep);
    }
    t.blockedBy = Array.from(existing);
    // Auto-set status to blocked if there are dependencies
    if (t.blockedBy.length > 0 && t.status === 'ready') {
      t.status = 'blocked';
    }
  }

  t.updatedAt = new Date().toISOString();
  file.tasks[id] = t;
  await saveTasks(repoPath, file);
  return t;
}
