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

export interface LocalTask {
  id: string;           // wish-<n>
  title: string;
  description?: string;
  status: LocalTaskStatus;
  blockedBy: string[];
  createdAt: string;
  updatedAt: string;
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
  return file.order.map(id => file.tasks[id]).filter(Boolean);
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

  return { ready, blocked };
}

export async function claimTask(repoPath: string, id: string): Promise<boolean> {
  const file = await loadTasks(repoPath);
  const t = file.tasks[id];
  if (!t) return false;

  t.status = 'in_progress';
  t.updatedAt = new Date().toISOString();
  file.tasks[id] = t;
  await saveTasks(repoPath, file);
  return true;
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
