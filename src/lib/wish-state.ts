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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { acquireLock } from './file-lock.js';

// ============================================================================
// Schemas
// ============================================================================

export const GroupStatusSchema = z.enum(['blocked', 'ready', 'in_progress', 'done']);

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
// State locking
// ============================================================================

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
// Validation
// ============================================================================

/** Check for self-dependencies and references to non-existent groups. */
function validateGroupRefs(groups: GroupDefinition[]): void {
  const groupNames = new Set(groups.map((g) => g.name));

  for (const group of groups) {
    if (group.dependsOn?.includes(group.name)) {
      throw new Error(`Group "${group.name}" depends on itself`);
    }
    for (const dep of group.dependsOn ?? []) {
      if (!groupNames.has(dep)) {
        throw new Error(`Group "${group.name}" depends on non-existent group "${dep}"`);
      }
    }
  }
}

/** Detect dependency cycles using Kahn's topological sort algorithm. */
function detectCycles(groups: GroupDefinition[]): void {
  const inDegree: Record<string, number> = {};
  const adjacency: Record<string, string[]> = {};

  for (const group of groups) {
    inDegree[group.name] = (group.dependsOn ?? []).length;
    adjacency[group.name] = [];
  }
  for (const group of groups) {
    for (const dep of group.dependsOn ?? []) {
      adjacency[dep].push(group.name);
    }
  }

  const queue: string[] = Object.entries(inDegree)
    .filter(([, deg]) => deg === 0)
    .map(([name]) => name);
  let processed = 0;

  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) break;
    processed++;
    for (const neighbor of adjacency[node]) {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (processed !== groups.length) {
    const remaining = Object.entries(inDegree)
      .filter(([, deg]) => deg > 0)
      .map(([name]) => name);
    throw new Error(`Dependency cycle detected among groups: ${remaining.join(', ')}`);
  }
}

/**
 * Validate group definitions: no self-deps, no dangling deps, no cycles.
 * Throws on the first violation found.
 */
function validateGroups(groups: GroupDefinition[]): void {
  validateGroupRefs(groups);
  detectCycles(groups);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize state file from wish group definitions.
 * Groups with no dependencies start as `ready`. Others start as `blocked`.
 */
export async function createState(slug: string, groups: GroupDefinition[], cwd?: string): Promise<WishState> {
  validateGroups(groups);

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

    if (group.status !== 'in_progress') {
      throw new Error(`Cannot complete group "${groupName}": must be in_progress (currently ${group.status})`);
    }

    group.status = 'done';
    group.completedAt = new Date().toISOString();

    // Recalculate dependents
    recalculateDependents(state);

    return { ...group };
  });
}

/**
 * Reset an in-progress group back to ready.
 * Clears assignee and startedAt. Only valid from in_progress status.
 */
export async function resetGroup(slug: string, groupName: string, cwd?: string): Promise<GroupState> {
  const statePath = getStatePath(slug, cwd);
  return withStateLock(statePath, (state) => {
    const group = state.groups[groupName];
    if (!group) throw new Error(`Group "${groupName}" not found`);
    if (group.status !== 'in_progress')
      throw new Error(`Cannot reset: must be in_progress (currently ${group.status})`);
    group.status = 'ready';
    group.assignee = undefined;
    group.startedAt = undefined;
    return { ...group };
  });
}

/**
 * Find a group assigned to a specific worker that is currently in_progress.
 * Searches all groups in the wish state for an assignee match.
 *
 * Matching strategy: checks if the group's assignee matches workerId exactly,
 * or if workerId ends with the assignee (to handle team-prefixed worker IDs
 * like "fire-and-forget-engineer" matching assignee "engineer").
 *
 * @public - consumed by OTel relay liveness check (Group 4 deliverable)
 */
export async function findGroupByAssignee(
  slug: string,
  workerId: string,
  cwd?: string,
): Promise<{ groupName: string; group: GroupState } | null> {
  const state = await getState(slug, cwd);
  if (!state) return null;

  for (const [groupName, group] of Object.entries(state.groups)) {
    if (group.status !== 'in_progress' || !group.assignee) continue;
    if (group.assignee === workerId) return { groupName, group: { ...group } };
    // Handle team-prefixed IDs: "team-engineer" matches assignee "engineer"
    if (workerId.endsWith(`-${group.assignee}`)) return { groupName, group: { ...group } };
  }
  return null;
}

/** Read current state. Lockless by design — reads are eventually consistent. */
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
