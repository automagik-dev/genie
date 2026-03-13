/**
 * Wish State Machine — Deterministic state tracking for wish execution groups.
 *
 * State file: `.genie/state/<slug>.json` in CWD (shared worktree).
 * Only genie commands mutate state. Agents NEVER touch the state file.
 *
 * State transitions:
 *   blocked → ready (when all dependencies complete)
 *   ready → in_progress (via startGroup, checks deps)
 *   in_progress → done (via completeGroup, recalculates dependents)
 */

import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

// ============================================================================
// Schemas
// ============================================================================

export const GroupStatusSchema = z.enum(['blocked', 'ready', 'in_progress', 'done']);
type GroupStatus = z.infer<typeof GroupStatusSchema>;

export const GroupStateSchema = z.object({
  status: GroupStatusSchema,
  assignee: z.string().optional(),
  dependsOn: z.array(z.string()).default([]),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});
export type GroupState = z.infer<typeof GroupStateSchema>;

export const WishStateSchema = z.object({
  wish: z.string(),
  groups: z.record(z.string(), GroupStateSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WishState = z.infer<typeof WishStateSchema>;

// ============================================================================
// Group definition (input to createState)
// ============================================================================

export interface GroupDefinition {
  name: string;
  dependsOn?: string[];
}

// ============================================================================
// File Locking — prevents concurrent state file races
// ============================================================================

const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 10000;

async function tryCleanStaleLock(lockPath: string): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
      try {
        await unlink(lockPath);
      } catch {
        /* race with other cleanup */
      }
      return true;
    }
  } catch {
    return true; // lock gone, retry
  }
  return false;
}

async function tryCreateLock(lockPath: string): Promise<(() => Promise<void>) | null> {
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
    return null;
  }
}

async function acquireLock(statePath: string): Promise<() => Promise<void>> {
  const lockPath = `${statePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    const release = await tryCreateLock(lockPath);
    if (release) return release;

    const cleaned = await tryCleanStaleLock(lockPath);
    if (cleaned) continue;

    if (Date.now() > deadline) {
      try {
        await unlink(lockPath);
      } catch {
        throw new Error(`State lock timeout: could not remove stale lock at ${lockPath}`);
      }
      continue;
    }
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }
}

async function withStateLock<T>(statePath: string, fn: (state: WishState) => T | Promise<T>): Promise<T> {
  const release = await acquireLock(statePath);
  try {
    const state = await loadState(statePath);
    if (!state) throw new Error(`State file not found: ${statePath}`);
    const result = await fn(state);
    await saveState(statePath, state);
    return result;
  } finally {
    await release();
  }
}

// ============================================================================
// File I/O
// ============================================================================

function getStatePath(slug: string, cwd?: string): string {
  return join(cwd ?? process.cwd(), '.genie', 'state', `${slug}.json`);
}

async function loadState(statePath: string): Promise<WishState | null> {
  try {
    const content = await readFile(statePath, 'utf-8');
    return WishStateSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

async function saveState(statePath: string, state: WishState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  state.updatedAt = new Date().toISOString();
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Recalculate statuses of groups that depend on the completed group.
 * A group transitions from `blocked` to `ready` when ALL its dependencies are `done`.
 */
function recalculateDependents(state: WishState): void {
  for (const [, group] of Object.entries(state.groups)) {
    if (group.status !== 'blocked') continue;
    if (group.dependsOn.length === 0) continue;

    const allDepsDone = group.dependsOn.every((dep) => {
      const depGroup = state.groups[dep];
      return depGroup?.status === 'done';
    });

    if (allDepsDone) {
      group.status = 'ready';
    }
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize state file from wish group definitions.
 * Groups with no dependencies start as `ready`. Others start as `blocked`.
 */
export async function createState(slug: string, groups: GroupDefinition[], cwd?: string): Promise<WishState> {
  const statePath = getStatePath(slug, cwd);
  await mkdir(dirname(statePath), { recursive: true });

  const now = new Date().toISOString();
  const groupEntries: Record<string, GroupState> = {};

  for (const group of groups) {
    const deps = group.dependsOn ?? [];
    groupEntries[group.name] = {
      status: deps.length === 0 ? 'ready' : 'blocked',
      dependsOn: deps,
    };
  }

  const state: WishState = {
    wish: slug,
    groups: groupEntries,
    createdAt: now,
    updatedAt: now,
  };

  await saveState(statePath, state);
  return state;
}

/**
 * Transition a group to `in_progress`.
 * Refuses if any dependency is not `done`.
 * Returns the updated group state, or throws on failure.
 */
export async function startGroup(slug: string, groupName: string, assignee: string, cwd?: string): Promise<GroupState> {
  const statePath = getStatePath(slug, cwd);

  return withStateLock(statePath, (state) => {
    const group = state.groups[groupName];
    if (!group) {
      throw new Error(`Group "${groupName}" not found in wish "${slug}"`);
    }

    if (group.status === 'in_progress') {
      throw new Error(`Group "${groupName}" is already in progress (assigned to ${group.assignee ?? 'unknown'})`);
    }

    if (group.status === 'done') {
      throw new Error(`Group "${groupName}" is already done`);
    }

    // Check dependencies
    for (const dep of group.dependsOn) {
      const depGroup = state.groups[dep];
      if (!depGroup) {
        throw new Error(`Dependency "${dep}" not found in wish "${slug}"`);
      }
      if (depGroup.status !== 'done') {
        throw new Error(`Cannot start group "${groupName}": dependency "${dep}" is ${depGroup.status} (must be done)`);
      }
    }

    group.status = 'in_progress';
    group.assignee = assignee;
    group.startedAt = new Date().toISOString();

    return { ...group };
  });
}

/**
 * Transition a group to `done`.
 * Recalculates dependent groups (blocked → ready when all deps done).
 */
export async function completeGroup(slug: string, groupName: string, cwd?: string): Promise<GroupState> {
  const statePath = getStatePath(slug, cwd);

  return withStateLock(statePath, (state) => {
    const group = state.groups[groupName];
    if (!group) {
      throw new Error(`Group "${groupName}" not found in wish "${slug}"`);
    }

    if (group.status === 'done') {
      throw new Error(`Group "${groupName}" is already done`);
    }

    group.status = 'done';
    group.completedAt = new Date().toISOString();

    // Recalculate dependents
    recalculateDependents(state);

    return { ...group };
  });
}

/**
 * Read current state for a wish.
 */
export async function getState(slug: string, cwd?: string): Promise<WishState | null> {
  const statePath = getStatePath(slug, cwd);
  return loadState(statePath);
}

/**
 * Read a single group's state.
 */
export async function getGroupState(slug: string, groupName: string, cwd?: string): Promise<GroupState | null> {
  const state = await getState(slug, cwd);
  if (!state) return null;
  return state.groups[groupName] ?? null;
}
