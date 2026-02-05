/**
 * Wish-Task Linking
 *
 * Manages the relationship between wishes and beads tasks.
 * Stores links in .genie/wishes/<slug>/tasks.json
 */

import { join } from 'path';
import { readFile, writeFile, mkdir, access } from 'fs/promises';

// ============================================================================
// Types
// ============================================================================

export interface LinkedTask {
  /** Beads task ID (e.g., "bd-42") */
  id: string;
  /** Task title */
  title: string;
  /** Task status */
  status: 'open' | 'in_progress' | 'done' | 'blocked';
  /** When the link was created */
  linkedAt: string;
}

export interface WishTasksFile {
  /** Wish slug */
  wishId: string;
  /** Linked tasks */
  tasks: LinkedTask[];
  /** Last updated */
  updatedAt: string;
}

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Get the tasks file path for a wish
 */
export function getWishTasksPath(repoPath: string, wishSlug: string): string {
  return join(repoPath, '.genie', 'wishes', wishSlug, 'tasks.json');
}

/**
 * Check if a wish exists
 */
export async function wishExists(repoPath: string, wishSlug: string): Promise<boolean> {
  const wishPath = join(repoPath, '.genie', 'wishes', wishSlug, 'wish.md');
  try {
    await access(wishPath);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * Load wish tasks file
 */
async function loadWishTasks(repoPath: string, wishSlug: string): Promise<WishTasksFile> {
  const filePath = getWishTasksPath(repoPath, wishSlug);

  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {
      wishId: wishSlug,
      tasks: [],
      updatedAt: new Date().toISOString(),
    };
  }
}

/**
 * Save wish tasks file
 */
async function saveWishTasks(repoPath: string, wishSlug: string, data: WishTasksFile): Promise<void> {
  const filePath = getWishTasksPath(repoPath, wishSlug);
  const dir = join(repoPath, '.genie', 'wishes', wishSlug);

  // Ensure directory exists
  await mkdir(dir, { recursive: true });

  data.updatedAt = new Date().toISOString();
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

/**
 * Link a task to a wish
 */
export async function linkTask(
  repoPath: string,
  wishSlug: string,
  taskId: string,
  taskTitle: string,
  status: LinkedTask['status'] = 'open'
): Promise<void> {
  const data = await loadWishTasks(repoPath, wishSlug);

  // Check if already linked
  const existing = data.tasks.find(t => t.id === taskId);
  if (existing) {
    // Update existing
    existing.title = taskTitle;
    existing.status = status;
  } else {
    // Add new
    data.tasks.push({
      id: taskId,
      title: taskTitle,
      status,
      linkedAt: new Date().toISOString(),
    });
  }

  await saveWishTasks(repoPath, wishSlug, data);
}

/**
 * Unlink a task from a wish
 */
export async function unlinkTask(repoPath: string, wishSlug: string, taskId: string): Promise<boolean> {
  const data = await loadWishTasks(repoPath, wishSlug);

  const index = data.tasks.findIndex(t => t.id === taskId);
  if (index === -1) {
    return false;
  }

  data.tasks.splice(index, 1);
  await saveWishTasks(repoPath, wishSlug, data);
  return true;
}

/**
 * Update task status in wish
 */
export async function updateTaskStatus(
  repoPath: string,
  wishSlug: string,
  taskId: string,
  status: LinkedTask['status']
): Promise<boolean> {
  const data = await loadWishTasks(repoPath, wishSlug);

  const task = data.tasks.find(t => t.id === taskId);
  if (!task) {
    return false;
  }

  task.status = status;
  await saveWishTasks(repoPath, wishSlug, data);
  return true;
}

/**
 * Get all tasks for a wish
 */
export async function getWishTasks(repoPath: string, wishSlug: string): Promise<LinkedTask[]> {
  const data = await loadWishTasks(repoPath, wishSlug);
  return data.tasks;
}

/**
 * Get wish status summary
 */
export async function getWishStatus(repoPath: string, wishSlug: string): Promise<{
  total: number;
  done: number;
  inProgress: number;
  blocked: number;
  open: number;
}> {
  const tasks = await getWishTasks(repoPath, wishSlug);

  return {
    total: tasks.length,
    done: tasks.filter(t => t.status === 'done').length,
    inProgress: tasks.filter(t => t.status === 'in_progress').length,
    blocked: tasks.filter(t => t.status === 'blocked').length,
    open: tasks.filter(t => t.status === 'open').length,
  };
}

/**
 * Find which wish a task is linked to
 */
export async function findWishForTask(repoPath: string, taskId: string): Promise<string | null> {
  const wishesDir = join(repoPath, '.genie', 'wishes');

  try {
    const { readdir } = await import('fs/promises');
    const entries = await readdir(wishesDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const tasks = await getWishTasks(repoPath, entry.name);
        if (tasks.some(t => t.id === taskId)) {
          return entry.name;
        }
      }
    }
  } catch {
    // Wishes directory doesn't exist
  }

  return null;
}
