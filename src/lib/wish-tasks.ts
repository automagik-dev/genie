/**
 * Wish-Task Linking
 *
 * Manages the relationship between wishes and tasks.
 * Stores links in .genie/wishes/<slug>/tasks.json
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// ============================================================================
// Types
// ============================================================================

interface LinkedTask {
  /** Task ID (e.g., "wish-42") */
  id: string;
  /** Task title */
  title: string;
  /** Task status */
  status: 'open' | 'in_progress' | 'done' | 'blocked';
  /** When the link was created */
  linkedAt: string;
}

interface WishTasksFile {
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
function getWishTasksPath(repoPath: string, wishSlug: string): string {
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
  status: LinkedTask['status'] = 'open',
): Promise<void> {
  const data = await loadWishTasks(repoPath, wishSlug);

  // Check if already linked
  const existing = data.tasks.find((t) => t.id === taskId);
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

  const index = data.tasks.findIndex((t) => t.id === taskId);
  if (index === -1) {
    return false;
  }

  data.tasks.splice(index, 1);
  await saveWishTasks(repoPath, wishSlug, data);
  return true;
}
