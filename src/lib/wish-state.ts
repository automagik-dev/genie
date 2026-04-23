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
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { getConnection } from './db.js';

// ============================================================================
// Schemas
// ============================================================================

const GroupStatusSchema = z.enum(['blocked', 'ready', 'in_progress', 'done']);

const GroupStateSchema = z.object({
  status: GroupStatusSchema,
  assignee: z.string().optional(),
  dependsOn: z.array(z.string()).default([]),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});
type GroupState = z.infer<typeof GroupStateSchema>;

const WishStateSchema = z.object({
  wish: z.string(),
  groups: z.record(z.string(), GroupStateSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type WishState = z.infer<typeof WishStateSchema>;

// ============================================================================
// Group definition (input to createState)
// ============================================================================

export interface GroupDefinition {
  name: string;
  dependsOn?: string[];
}

// ============================================================================
// Group-structure signature (drift detection)
// ============================================================================

/**
 * Compute a deterministic signature of a wish's group structure.
 *
 * Captures group names + sorted `dependsOn` per group. Order of groups in the
 * input array does not affect the result (groups are sorted by name first), and
 * dep order within a group does not matter either. Prose changes to WISH.md
 * (Summary, Decisions, etc.) leave the signature untouched — only structural
 * changes that affect dispatch flip it.
 */
export function computeGroupsSignature(groups: GroupDefinition[]): string {
  const canonical = groups
    .map((g) => ({ name: g.name, dependsOn: [...(g.dependsOn ?? [])].sort() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Thrown by `getOrCreateState` when the WISH.md group structure has drifted
 * from the cached signature. Callers can pattern-match on this type to render
 * remediation UI; the `.message` already contains a human-readable diff and the
 * remediation command.
 */
export class WishStateMismatchError extends Error {
  readonly slug: string;
  readonly added: string[];
  readonly removed: string[];
  readonly changed: string[];

  constructor(slug: string, added: string[], removed: string[], changed: string[]) {
    const lines: string[] = [`Wish "${slug}" group structure has changed since state was created.`];
    if (added.length > 0) lines.push(`  + added: ${added.join(', ')}`);
    if (removed.length > 0) lines.push(`  - removed: ${removed.join(', ')}`);
    if (changed.length > 0) lines.push(`  ~ changed deps: ${changed.join(', ')}`);
    lines.push('');
    lines.push(`Run \`genie reset ${slug}\` to recreate state from the current WISH.md.`);
    super(lines.join('\n'));
    this.name = 'WishStateMismatchError';
    this.slug = slug;
    this.added = added;
    this.removed = removed;
    this.changed = changed;
  }
}

/** Diff two group-definition arrays into added/removed/changed names. */
function diffGroups(
  prev: GroupDefinition[],
  next: GroupDefinition[],
): { added: string[]; removed: string[]; changed: string[] } {
  const prevMap = new Map(prev.map((g) => [g.name, [...(g.dependsOn ?? [])].sort()]));
  const nextMap = new Map(next.map((g) => [g.name, [...(g.dependsOn ?? [])].sort()]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [name, deps] of nextMap) {
    if (!prevMap.has(name)) {
      added.push(name);
    } else if (JSON.stringify(prevMap.get(name)) !== JSON.stringify(deps)) {
      changed.push(name);
    }
  }
  for (const name of prevMap.keys()) {
    if (!nextMap.has(name)) removed.push(name);
  }

  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

// ============================================================================
// Internal helpers
// ============================================================================

/** Resolve repo root via git, fallback to cwd.
 * Uses git-common-dir to normalize across worktrees — returns the main repo path
 * even when called from a linked worktree.
 */
function normalizeGitPath(path: string): string {
  if (process.platform !== 'darwin') return path;
  if (!path.startsWith('/private/')) return path;
  const logicalPath = path.slice('/private'.length);
  return existsSync(logicalPath) ? logicalPath : path;
}

export function resolveRepoPath(cwd?: string): string {
  if (cwd) return cwd;
  try {
    // git-common-dir returns the shared .git for worktrees, or .git for main repo.
    // GIT_CEILING_DIRECTORIES prevents git from walking above cwd into unrelated
    // repos (e.g. a stale /tmp/.git on shared servers).
    const currentDir = process.cwd();
    const commonDir = execSync('git rev-parse --path-format=absolute --git-common-dir', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(currentDir) },
    }).trim();
    // For main repos: commonDir = /path/to/repo/.git → parent = /path/to/repo
    // For worktrees: commonDir = /path/to/main-repo/.git → same parent
    return normalizeGitPath(dirname(commonDir));
  } catch {
    return normalizeGitPath(process.cwd());
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

/**
 * Find parent task for a wish slug at a specific repo_path.
 *
 * Also emits a loud warning when the slug has parent rows at OTHER repo_paths
 * (state-partitioning — issue #1234). Worktrees, submodule clones, and main
 * repos all resolve to different `repo_path` values, and naively filtering on
 * the current cwd's path silently hides sibling state.
 *
 * Still returns null on miss — we never auto-heal by adopting a foreign
 * parent, because picking the wrong one would silently merge unrelated
 * execution into the current cwd's wish. The warning gives the operator
 * enough signal to diagnose and reconcile manually.
 */
async function findParent(sql: Sql, slug: string, repoPath: string) {
  const wishFile = wishFilePath(slug);
  const rows = await sql`
    SELECT * FROM tasks
    WHERE wish_file = ${wishFile} AND repo_path = ${repoPath} AND parent_id IS NULL
    LIMIT 1
  `;
  if (rows.length > 0) return rows[0];

  // Diagnostic: are there parent rows for this wish at *other* repo_paths?
  // Those would silently own the state while we report "not found" here.
  const crossRows = await sql`
    SELECT repo_path FROM tasks
    WHERE wish_file = ${wishFile} AND parent_id IS NULL AND repo_path != ${repoPath}
  `;
  if (crossRows.length > 0) {
    const otherPaths = crossRows
      .map((r: Record<string, unknown>) => r.repo_path as string)
      .filter((p: string, i: number, arr: string[]) => arr.indexOf(p) === i);
    const otherList = otherPaths.map((p: string) => `     - ${p}`).join('\n');
    console.warn(
      `⚠ Wish "${slug}" has state partitioned across repo_paths (issue #1234).\n   Current cwd resolves to: ${repoPath}\n   Other parents exist at:\n${otherList}\n   Operations against this wish from the current cwd see NONE of the state above.\n   Re-run from one of the listed paths, or reconcile the partitioned rows manually.`,
    );
  }

  return null;
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

  // Create parent task (the wish itself).
  // Stash the group-structure signature so getOrCreateState can detect drift
  // when WISH.md gets edited after state was first created.
  const groupsSignature = computeGroupsSignature(groups);
  const [parent] = await sql`
    INSERT INTO tasks (repo_path, title, wish_file, type_id, stage, status, metadata)
    VALUES (
      ${repoPath}, ${slug}, ${wishFile}, 'software', 'draft', 'ready',
      ${sql.json({ groupsSignature })}
    )
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
 *
 * Auto-recovers from dispatch-bypass (issue #1214): when the group is `ready`
 * (never entered `in_progress`) we transition it through `in_progress` before
 * marking it `done`, so sidechannel-spawned engineers don't produce silent
 * no-ops. `blocked` still fails — unmet dependencies must not complete. `done`
 * is idempotent (return existing state rather than throw).
 */
export async function completeGroup(slug: string, groupName: string, cwd?: string): Promise<GroupState> {
  const sql = await getConnection();
  const repoPath = resolveRepoPath(cwd);

  const parent = await findParent(sql, slug, repoPath);
  if (!parent) throw new Error(`Group "${groupName}" not found in wish "${slug}"`);

  const child = await findGroup(sql, parent.id as string, groupName);
  if (!child) throw new Error(`Group "${groupName}" not found in wish "${slug}"`);

  // Idempotent done — return existing state, don't throw.
  if (child.status === 'done') {
    const [actors, deps] = await Promise.all([
      sql`
        SELECT actor_id FROM task_actors WHERE task_id = ${child.id as string} AND role = 'assignee' LIMIT 1
      `,
      sql`
        SELECT t.group_name FROM task_dependencies td
        JOIN tasks t ON t.id = td.depends_on_id
        WHERE td.task_id = ${child.id as string}
      `,
    ]);
    return {
      status: 'done',
      assignee: actors.length > 0 ? (actors[0].actor_id as string) : undefined,
      dependsOn: deps.map((d: Record<string, unknown>) => d.group_name as string),
      startedAt: toISO(child.started_at),
      completedAt: toISO(child.ended_at) ?? toISO(child.updated_at),
    };
  }

  // Blocked — unmet deps still prevent completion. Surface the blocker clearly.
  if (child.status === 'blocked') {
    const pendingDeps = await sql`
      SELECT t.group_name, t.status
      FROM task_dependencies td
      JOIN tasks t ON t.id = td.depends_on_id
      WHERE td.task_id = ${child.id as string}
        AND t.status != 'done'
    `;
    const blockers = pendingDeps
      .map((d: Record<string, unknown>) => `${d.group_name as string} (${d.status as string})`)
      .join(', ');
    throw new Error(`Cannot complete group "${groupName}": blocked on unmet dependencies: ${blockers || 'unknown'}`);
  }

  // Ready — auto-recover dispatch-bypass. Transition ready → in_progress before
  // marking done. This fixes issue #1214 where sidechannel spawns skipped
  // startGroup and `genie done` became a silent no-op.
  if (child.status === 'ready') {
    const assignee = process.env.GENIE_AGENT_NAME || 'auto-recovered';
    const startNow = new Date();
    await sql`
      UPDATE tasks SET status = 'in_progress', started_at = COALESCE(started_at, ${startNow}), updated_at = ${startNow}
      WHERE id = ${child.id as string}
    `;
    await sql`
      INSERT INTO task_actors (task_id, actor_type, actor_id, role)
      VALUES (${child.id as string}, 'local', ${assignee}, 'assignee')
      ON CONFLICT (task_id, actor_type, actor_id, role) DO UPDATE SET created_at = now()
    `;
    console.warn(
      `⚠ Group "${groupName}" was \`ready\` (dispatch-bypass); auto-transitioned to \`in_progress\` before completion.`,
    );
    // Refresh child.status for the write below (child row is mutated by UPDATE).
    // Also propagate started_at so the final return's toISO(child.started_at)
    // yields the real timestamp instead of undefined. Mirror PG's COALESCE —
    // don't overwrite an existing timestamp.
    child.status = 'in_progress';
    if (!child.started_at) child.started_at = startNow;
  }

  if (child.status !== 'in_progress') {
    throw new Error(`Cannot complete group "${groupName}": must be in_progress (currently ${child.status})`);
  }

  const now = new Date();
  // Use RETURNING so a 0-row update fails loudly instead of silently no-opping.
  // The status read-path and write-path both key on (wish_file, repo_path),
  // and pre-check gates (findParent, findGroup, status guards) normally catch
  // drift earlier — but if a concurrent delete or race nukes the row between
  // the pre-check and this UPDATE, we never want to return success on 0 rows.
  // Issue #1234: "make genie done fail loudly when it doesn't actually update".
  const updated = await sql`
    UPDATE tasks SET status = 'done', ended_at = ${now}, updated_at = ${now}
    WHERE id = ${child.id as string}
    RETURNING id
  `;
  if (updated.length === 0) {
    throw new Error(
      `Completion UPDATE affected 0 rows for group "${groupName}" in wish "${slug}" ` +
        `(child id ${child.id as string} disappeared mid-operation). ` +
        `State was NOT written — re-run \`genie done ${slug}#${groupName}\` to retry.`,
    );
  }

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
 *
 * If state already exists and the parent task carries a `groupsSignature` in
 * `metadata`, we recompute the signature from the supplied `groups` and throw
 * `WishStateMismatchError` if they don't match — protects against silently
 * dispatching against a stale plan after WISH.md was edited.
 *
 * Pre-existing state without a `groupsSignature` is treated as "valid, never
 * validated" (backfill-free path) — first successful invalidation requires a
 * `genie reset <slug>`.
 */
export async function getOrCreateState(slug: string, groups: GroupDefinition[], cwd?: string): Promise<WishState> {
  const existing = await getState(slug, cwd);
  if (existing) {
    await validateSignatureOrThrow(slug, groups, cwd);
    return existing;
  }
  return createState(slug, groups, cwd);
}

/**
 * Read the parent task's stored signature and compare to a fresh one.
 * Throws `WishStateMismatchError` on mismatch; no-op if the parent has no
 * stored signature (pre-existing state from before this feature landed).
 */
async function validateSignatureOrThrow(slug: string, groups: GroupDefinition[], cwd?: string): Promise<void> {
  const sql = await getConnection();
  const repoPath = resolveRepoPath(cwd);
  const parent = await findParent(sql, slug, repoPath);
  if (!parent) return;

  const stored = readStoredSignature(parent.metadata);
  if (!stored) return; // backfill-free: no signature → no validation

  const fresh = computeGroupsSignature(groups);
  if (stored === fresh) return;

  // Reconstruct previous group definitions from existing child tasks for diffing.
  const prevGroups = await readGroupDefinitions(sql, parent.id as string);
  const { added, removed, changed } = diffGroups(prevGroups, groups);
  throw new WishStateMismatchError(slug, added, removed, changed);
}

/** Extract `groupsSignature` from a parent's metadata column (string or object). */
function readStoredSignature(metadata: unknown): string | null {
  if (metadata == null) return null;
  let parsed: unknown = metadata;
  if (typeof metadata === 'string') {
    try {
      parsed = JSON.parse(metadata);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const sig = (parsed as Record<string, unknown>).groupsSignature;
  return typeof sig === 'string' ? sig : null;
}

/** Reconstruct the GroupDefinition[] for an existing parent (for diff messages). */
async function readGroupDefinitions(sql: Sql, parentId: string): Promise<GroupDefinition[]> {
  const children = await sql`SELECT id, group_name FROM tasks WHERE parent_id = ${parentId} ORDER BY created_at`;
  if (children.length === 0) return [];
  const childIds = children.map((c: Record<string, unknown>) => c.id as string);
  const deps = await sql`
    SELECT td.task_id, t.group_name AS dep_group
    FROM task_dependencies td
    JOIN tasks t ON t.id = td.depends_on_id
    WHERE td.task_id = ANY(${childIds})
  `;
  const depsByTask: Record<string, string[]> = {};
  for (const dep of deps) {
    const taskId = dep.task_id as string;
    if (!depsByTask[taskId]) depsByTask[taskId] = [];
    depsByTask[taskId].push(dep.dep_group as string);
  }
  return children.map((c: Record<string, unknown>) => ({
    name: c.group_name as string,
    dependsOn: depsByTask[c.id as string] ?? [],
  }));
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

/**
 * Check if all groups in a wish are done.
 * Returns true only when every group has status === 'done'.
 */
export async function isWishComplete(slug: string, cwd?: string): Promise<boolean> {
  const state = await getState(slug, cwd);
  if (!state) return false;
  const groups = Object.values(state.groups);
  return groups.length > 0 && groups.every((g) => g.status === 'done');
}

/**
 * Wipe all wish state for a slug — deletes the parent task (FK cascade
 * removes children + dependencies + actors). Returns true if anything was
 * deleted, false if no state existed.
 *
 * Used by `genie reset <slug>` to recover from a `WishStateMismatchError`.
 */
export async function wipeState(slug: string, cwd?: string): Promise<boolean> {
  const sql = await getConnection();
  const repoPath = resolveRepoPath(cwd);
  const parent = await findParent(sql, slug, repoPath);
  if (!parent) return false;
  await sql`DELETE FROM tasks WHERE id = ${parent.id as string}`;
  return true;
}

/**
 * Reset all in_progress groups back to ready for a wish.
 * Used during team disband to prevent stale state from blocking re-dispatch.
 * Returns the number of groups that were reset.
 */
export async function resetInProgressGroups(slug: string, cwd?: string): Promise<number> {
  const sql = await getConnection();
  const repoPath = resolveRepoPath(cwd);

  const parent = await findParent(sql, slug, repoPath);
  if (!parent) return 0;

  const now = new Date();

  // Find all in_progress children
  const inProgress = await sql`
    SELECT id FROM tasks
    WHERE parent_id = ${parent.id as string} AND status = 'in_progress'
  `;

  if (inProgress.length === 0) return 0;

  const ids = inProgress.map((r: Record<string, unknown>) => r.id as string);

  // Reset to ready, clear started_at
  await sql`
    UPDATE tasks SET status = 'ready', started_at = NULL, updated_at = ${now}
    WHERE id = ANY(${ids})
  `;

  // Remove assignees
  await sql`
    DELETE FROM task_actors WHERE task_id = ANY(${ids}) AND role = 'assignee'
  `;

  return ids.length;
}
