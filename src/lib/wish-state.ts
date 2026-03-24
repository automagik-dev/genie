/**
 * Wish State Machine — PG-backed state tracking for wish execution groups.
 *
 * State is stored in PG `tasks` + `task_dependencies` + `task_actors` tables.
 * Parent task = wish, child tasks = execution groups.
 * PG handles concurrency natively — no file locks needed.
 *
 * State transitions:
 *   blocked → ready (when all dependencies complete)
 *   ready → in_progress (via startGroup, checks deps)
 *   in_progress → done (via completeGroup, recalculates dependents)
 */

import { execSync } from 'node:child_process';
import { dirname } from 'node:path';
import { z } from 'zod';
import { getConnection } from './db.js';

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
// Internal helpers
// ============================================================================

/** Resolve repo root via git, fallback to cwd.
 * Uses git-common-dir to normalize across worktrees — returns the main repo path
 * even when called from a linked worktree.
 */
export function resolveRepoPath(cwd?: string): string {
  if (cwd) return cwd;
  try {
    // git-common-dir returns the shared .git for worktrees, or .git for main repo
    const commonDir = execSync('git rev-parse --path-format=absolute --git-common-dir', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // For main repos: commonDir = /path/to/repo/.git → parent = /path/to/repo
    // For worktrees: commonDir = /path/to/main-repo/.git → same parent
    return dirname(commonDir);
  } catch {
    return process.cwd();
  }
}

/** Construct wish_file path from slug. */
function wishFilePath(slug: string): string {
  return `.genie/wishes/${slug}/WISH.md`;
}

/** Convert PG timestamp to ISO string, or undefined if null. */
function toISO(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type varies
type Sql = any;

/** Find parent task for a wish slug. */
async function findParent(sql: Sql, slug: string, repoPath: string) {
  const wishFile = wishFilePath(slug);
  const rows = await sql`
    SELECT * FROM tasks
    WHERE wish_file = ${wishFile} AND repo_path = ${repoPath} AND parent_id IS NULL
    LIMIT 1
  `;
  return rows.length > 0 ? rows[0] : null;
}

/** Find a child task (group) under a parent. */
async function findGroup(sql: Sql, parentId: string, groupName: string) {
  const rows = await sql`
    SELECT * FROM tasks
    WHERE parent_id = ${parentId} AND group_name = ${groupName}
    LIMIT 1
  `;
  return rows.length > 0 ? rows[0] : null;
}

// ============================================================================
// Validation (pure logic — no I/O)
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
 * Initialize wish state from group definitions.
 * Creates parent task (wish) + child tasks (groups) + dependencies in PG.
 * Groups with no dependencies start as `ready`. Others start as `blocked`.
 */
export async function createState(slug: string, groups: GroupDefinition[], cwd?: string): Promise<WishState> {
  validateGroups(groups);

  const sql = await getConnection();
  const repoPath = resolveRepoPath(cwd);
  const wishFile = wishFilePath(slug);

  // Delete existing state for this slug (matches old file-overwrite behavior)
  const existingParent = await findParent(sql, slug, repoPath);
  if (existingParent) {
    await sql`DELETE FROM tasks WHERE id = ${existingParent.id as string}`;
  }

  // Create parent task (the wish itself)
  const [parent] = await sql`
    INSERT INTO tasks (repo_path, title, wish_file, type_id, stage, status)
    VALUES (${repoPath}, ${slug}, ${wishFile}, 'software', 'draft', 'ready')
    RETURNING *
  `;

  // Create child tasks (one per group)
  const childIds: Record<string, string> = {};
  for (const group of groups) {
    const deps = group.dependsOn ?? [];
    const status = deps.length === 0 ? 'ready' : 'blocked';
    const [child] = await sql`
      INSERT INTO tasks (repo_path, title, parent_id, group_name, type_id, stage, status)
      VALUES (${repoPath}, ${`Group ${group.name}`}, ${parent.id as string}, ${group.name}, 'software', 'draft', ${status})
      RETURNING id
    `;
    childIds[group.name] = child.id as string;
  }

  // Create dependencies between children
  for (const group of groups) {
    for (const dep of group.dependsOn ?? []) {
      await sql`
        INSERT INTO task_dependencies (task_id, depends_on_id, dep_type)
        VALUES (${childIds[group.name]}, ${childIds[dep]}, 'depends_on')
      `;
    }
  }

  // Reconstruct WishState shape
  const now = toISO(parent.created_at) ?? new Date().toISOString();
  const groupEntries: Record<string, GroupState> = {};
  for (const group of groups) {
    const deps = group.dependsOn ?? [];
    groupEntries[group.name] = {
      status: deps.length === 0 ? 'ready' : 'blocked',
      dependsOn: deps,
    };
  }

  return {
    wish: slug,
    groups: groupEntries,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Transition a group to `in_progress`.
 * Refuses if any dependency is not `done`.
 * Returns the updated group state, or throws on failure.
 */
export async function startGroup(slug: string, groupName: string, assignee: string, cwd?: string): Promise<GroupState> {
  const sql = await getConnection();
  const repoPath = resolveRepoPath(cwd);

  const parent = await findParent(sql, slug, repoPath);
  if (!parent) throw new Error(`State not found for wish "${slug}"`);

  const child = await findGroup(sql, parent.id as string, groupName);
  if (!child) throw new Error(`Group "${groupName}" not found in wish "${slug}"`);

  if (child.status === 'in_progress') {
    const actors = await sql`
      SELECT actor_id FROM task_actors WHERE task_id = ${child.id as string} AND role = 'assignee' LIMIT 1
    `;
    const current = actors.length > 0 ? (actors[0].actor_id as string) : 'unknown';
    throw new Error(`Group "${groupName}" is already in progress (assigned to ${current})`);
  }

  if (child.status === 'done') {
    throw new Error(`Group "${groupName}" is already done`);
  }

  // Check dependencies
  const deps = await sql`
    SELECT t.group_name, t.status
    FROM task_dependencies td
    JOIN tasks t ON t.id = td.depends_on_id
    WHERE td.task_id = ${child.id as string}
  `;

  for (const dep of deps) {
    if (dep.status !== 'done') {
      throw new Error(
        `Cannot start group "${groupName}": dependency "${dep.group_name}" is ${dep.status} (must be done)`,
      );
    }
  }

  // Update status to in_progress
  const now = new Date();
  await sql`
    UPDATE tasks SET status = 'in_progress', started_at = COALESCE(started_at, ${now}), updated_at = ${now}
    WHERE id = ${child.id as string}
  `;

  // Assign actor
  await sql`
    INSERT INTO task_actors (task_id, actor_type, actor_id, role)
    VALUES (${child.id as string}, 'local', ${assignee}, 'assignee')
    ON CONFLICT (task_id, actor_type, actor_id, role) DO UPDATE SET created_at = now()
  `;

  return {
    status: 'in_progress',
    assignee,
    dependsOn: deps.map((d: Record<string, unknown>) => d.group_name as string),
    startedAt: now.toISOString(),
  };
}

/**
 * Transition a group to `done`.
 * Recalculates dependent groups (blocked → ready when all deps done).
 */
export async function completeGroup(slug: string, groupName: string, cwd?: string): Promise<GroupState> {
  const sql = await getConnection();
  const repoPath = resolveRepoPath(cwd);

  const parent = await findParent(sql, slug, repoPath);
  if (!parent) throw new Error(`Group "${groupName}" not found in wish "${slug}"`);

  const child = await findGroup(sql, parent.id as string, groupName);
  if (!child) throw new Error(`Group "${groupName}" not found in wish "${slug}"`);

  if (child.status !== 'in_progress') {
    throw new Error(`Cannot complete group "${groupName}": must be in_progress (currently ${child.status})`);
  }

  const now = new Date();
  await sql`
    UPDATE tasks SET status = 'done', ended_at = ${now}, updated_at = ${now}
    WHERE id = ${child.id as string}
  `;

  // Recalculate dependents: blocked siblings → ready when ALL deps done
  await sql`
    UPDATE tasks SET status = 'ready', updated_at = ${now}
    WHERE parent_id = ${parent.id as string}
      AND status = 'blocked'
      AND EXISTS (
        SELECT 1 FROM task_dependencies WHERE task_id = tasks.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies td
        JOIN tasks dep ON dep.id = td.depends_on_id
        WHERE td.task_id = tasks.id
          AND dep.status != 'done'
      )
  `;

  // Build return value
  const actors = await sql`
    SELECT actor_id FROM task_actors WHERE task_id = ${child.id as string} AND role = 'assignee' LIMIT 1
  `;
  const deps = await sql`
    SELECT t.group_name FROM task_dependencies td
    JOIN tasks t ON t.id = td.depends_on_id
    WHERE td.task_id = ${child.id as string}
  `;

  return {
    status: 'done',
    assignee: actors.length > 0 ? (actors[0].actor_id as string) : undefined,
    dependsOn: deps.map((d: Record<string, unknown>) => d.group_name as string),
    startedAt: toISO(child.started_at),
    completedAt: now.toISOString(),
  };
}

/**
 * Reset an in-progress group back to ready.
 * Clears assignee and startedAt. Only valid from in_progress status.
 */
export async function resetGroup(slug: string, groupName: string, cwd?: string): Promise<GroupState> {
  const sql = await getConnection();
  const repoPath = resolveRepoPath(cwd);

  const parent = await findParent(sql, slug, repoPath);
  if (!parent) throw new Error(`Group "${groupName}" not found`);

  const child = await findGroup(sql, parent.id as string, groupName);
  if (!child) throw new Error(`Group "${groupName}" not found`);

  if (child.status !== 'in_progress') {
    throw new Error(`Cannot reset: must be in_progress (currently ${child.status})`);
  }

  const now = new Date();
  await sql`UPDATE tasks SET status = 'ready', started_at = NULL, updated_at = ${now} WHERE id = ${child.id as string}`;
  await sql`DELETE FROM task_actors WHERE task_id = ${child.id as string} AND role = 'assignee'`;

  const deps = await sql`
    SELECT t.group_name FROM task_dependencies td
    JOIN tasks t ON t.id = td.depends_on_id
    WHERE td.task_id = ${child.id as string}
  `;

  return {
    status: 'ready',
    assignee: undefined,
    dependsOn: deps.map((d: Record<string, unknown>) => d.group_name as string),
    startedAt: undefined,
  };
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

/**
 * Find any in_progress group assigned to a worker across ALL wishes in a repo.
 * Used by protocol-router-spawn for resume context injection.
 *
 * Returns the first match with slug, groupName, and group state.
 */
export async function findAnyGroupByAssignee(
  workerId: string,
  cwd?: string,
): Promise<{ slug: string; groupName: string; group: GroupState } | null> {
  const sql = await getConnection();
  const repoPath = resolveRepoPath(cwd);

  // Find all in_progress group tasks with assignees in this repo
  const rows = await sql`
    SELECT t.group_name, ta.actor_id AS assignee, p.wish_file
    FROM tasks t
    JOIN task_actors ta ON ta.task_id = t.id AND ta.role = 'assignee'
    JOIN tasks p ON p.id = t.parent_id
    WHERE t.repo_path = ${repoPath}
      AND t.status = 'in_progress'
      AND t.group_name IS NOT NULL
      AND p.wish_file IS NOT NULL
    ORDER BY t.created_at
  `;

  for (const row of rows) {
    const assignee = row.assignee as string;
    if (assignee !== workerId && !workerId.endsWith(`-${assignee}`)) continue;

    // Extract slug from wish_file path
    const wishFile = row.wish_file as string;
    const slugMatch = wishFile.match(/\.genie\/wishes\/([^/]+)\/WISH\.md/);
    if (!slugMatch) continue;
    const slug = slugMatch[1];
    const groupName = row.group_name as string;

    // Get full group state
    const state = await getState(slug, cwd);
    if (!state) continue;
    const group = state.groups[groupName];
    if (!group) continue;

    return { slug, groupName, group: { ...group } };
  }

  return null;
}

/**
 * Get existing state or create it from group definitions.
 * Avoids the "no state file" gap that causes polling loops.
 */
export async function getOrCreateState(slug: string, groups: GroupDefinition[], cwd?: string): Promise<WishState> {
  const existing = await getState(slug, cwd);
  if (existing) return existing;
  return createState(slug, groups, cwd);
}

/** Read current state. Returns null if no state exists for this wish. */
export async function getState(slug: string, cwd?: string): Promise<WishState | null> {
  const sql = await getConnection();
  const repoPath = resolveRepoPath(cwd);

  const parent = await findParent(sql, slug, repoPath);
  if (!parent) return null;

  // Get all children
  const children = await sql`SELECT * FROM tasks WHERE parent_id = ${parent.id as string} ORDER BY created_at`;
  if (children.length === 0) return null;

  const childIds = children.map((c: Record<string, unknown>) => c.id as string);

  // Get dependencies: which group each child depends on
  const deps = await sql`
    SELECT td.task_id, t.group_name AS dep_group
    FROM task_dependencies td
    JOIN tasks t ON t.id = td.depends_on_id
    WHERE td.task_id = ANY(${childIds})
  `;
  const depsMap: Record<string, string[]> = {};
  for (const dep of deps) {
    const taskId = dep.task_id as string;
    if (!depsMap[taskId]) depsMap[taskId] = [];
    depsMap[taskId].push(dep.dep_group as string);
  }

  // Get assignees
  const actors = await sql`
    SELECT task_id, actor_id FROM task_actors
    WHERE task_id = ANY(${childIds}) AND role = 'assignee'
  `;
  const assigneeMap: Record<string, string> = {};
  for (const actor of actors) {
    assigneeMap[actor.task_id as string] = actor.actor_id as string;
  }

  // Reconstruct WishState
  const groups: Record<string, GroupState> = {};
  for (const child of children) {
    const id = child.id as string;
    const groupName = child.group_name as string;
    groups[groupName] = {
      status: child.status as GroupState['status'],
      assignee: assigneeMap[id],
      dependsOn: depsMap[id] ?? [],
      startedAt: toISO(child.started_at),
      completedAt: toISO(child.ended_at),
    };
  }

  return {
    wish: slug,
    groups,
    createdAt: toISO(parent.created_at) ?? '',
    updatedAt: toISO(parent.updated_at) ?? '',
  };
}

/**
 * Read a single group's state.
 */
export async function getGroupState(slug: string, groupName: string, cwd?: string): Promise<GroupState | null> {
  const state = await getState(slug, cwd);
  if (!state) return null;
  return state.groups[groupName] ?? null;
}
